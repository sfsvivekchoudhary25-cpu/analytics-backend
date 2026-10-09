import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
import { InstagramConnectionService } from './instagram-connection.service';

import { GRAPH } from './graph-client.service';
const TOTAL_METRICS = [
  'views',
  'reach',
  'profile_views',
  'accounts_engaged',
  'total_interactions',
  'likes',
  'comments',
  'shares',
  'saves',
];

type Point = { date: string; value: number };

@UseGuards(AuthGuard)
@Controller('instagram/insights')
export class InstagramInsightsController {
  constructor(private readonly connection: InstagramConnectionService) {}

  @Get('overview')
  async overview(
    @Query('days') daysParam?: string,
    @CurrentAccount() account?: string,
  ) {
    // Instagram only serves insights for windows of up to 30 days per request.
    const days = Math.min(30, Math.max(1, parseInt(daysParam ?? '30', 10) || 30));
    const until = Math.floor(Date.now() / 1000);
    const since = until - days * 86400;
    const token = await this.connection.getValidAccessToken(account);

    const call = async (path: string, params: Record<string, string>) => {
      const qs = new URLSearchParams({ ...params, access_token: token });
      const res = await fetch(`${GRAPH}${path}?${qs}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `Instagram error ${res.status}`);
      return body;
    };
    const window = { since: String(since), until: String(until) };
    const errors: Record<string, string> = {};
    const note = (key: string) => (e: Error) => {
      errors[key] = e.message;
      return null;
    };

    const [profile, media, reachSeries, followerSeries, ...totals] = await Promise.all([
      call('/me', {
        fields:
          'user_id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url',
      }).catch(note('profile')),
      call('/me/media', {
        fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
        limit: '50',
      }).catch(note('media')),
      call('/me/insights', { metric: 'reach', period: 'day', ...window }).catch(note('reach')),
      call('/me/insights', { metric: 'follower_count', period: 'day', ...window }).catch(note('followers')),
      ...TOTAL_METRICS.map((metric) =>
        call('/me/insights', { metric, metric_type: 'total_value', period: 'day', ...window }).catch(
          note(`metric:${metric}`),
        ),
      ),
    ]);

    const toSeries = (body: any): Point[] =>
      (body?.data?.[0]?.values ?? []).map((v: any) => ({
        date: String(v.end_time).slice(0, 10),
        value: Number(v.value) || 0,
      }));

    const totalsOut: Record<string, number | null> = {};
    TOTAL_METRICS.forEach((metric, i) => {
      const value = totals[i]?.data?.[0]?.total_value?.value;
      totalsOut[metric] = typeof value === 'number' ? value : null;
    });

    let finalProfile = profile;
    if (!finalProfile || finalProfile.followers_count == null) {
      try {
        const igUserId = await this.connection.getIgUserId(account);
        const fbRepo = (this.connection as any).repo.manager.getRepository('FacebookPageConnection');
        const [fbConn] = await fbRepo.find({ take: 1 });
        if (fbConn?.pageAccessToken && igUserId) {
          const fbRes = await fetch(`https://graph.facebook.com/v21.0/${igUserId}?fields=id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url&access_token=${encodeURIComponent(fbConn.pageAccessToken)}`);
          const fbData = await fbRes.json();
          if (fbRes.ok && (fbData.username || fbData.name)) {
            finalProfile = { ...(finalProfile || {}), ...fbData };
          }
        }
      } catch {}
    }

    return {
      days,
      profile: finalProfile,
      media: media?.data ?? [],
      totals: totalsOut,
      series: { reach: toSeries(reachSeries), followers: toSeries(followerSeries) },
      errors,
    };
  }
}
