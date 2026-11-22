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

// Instagram's app reports whole calendar days in the account's timezone. Set INSIGHTS_TIMEZONE (e.g. Asia/Kolkata)
// so our day boundaries match the app; it defaults to UTC.
const INSIGHTS_TZ = process.env.INSIGHTS_TIMEZONE || 'UTC';

// Unix seconds of local midnight, `daysAgo` days before today, in INSIGHTS_TZ.
function localMidnight(daysAgo: number): number {
  const offsetAt = (ms: number) => {
    const p: Record<string, number> = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: INSIGHTS_TZ, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(ms)).forEach((x) => { if (x.type !== 'literal') p[x.type] = Number(x.value); });
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  };
  const now = Date.now();
  const local = new Date(now + offsetAt(now)); // wall-clock "now" in the timezone, read via UTC getters
  const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysAgo);
  return Math.floor((guess - offsetAt(guess)) / 1000);
}

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
    // N whole calendar days ending at the start of today (today is incomplete and Instagram lags up to 48h),
    // plus the N days before that for "vs last period".
    const since = localMidnight(days);
    const until = localMidnight(0);
    const prevSince = localMidnight(days * 2);
    const token = await this.connection.getValidAccessToken(account);

    const call = async (path: string, params: Record<string, string>) => {
      const qs = new URLSearchParams({ ...params, access_token: token });
      const res = await fetch(`${GRAPH}${path}?${qs}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `Instagram error ${res.status}`);
      return body;
    };
    const window = { since: String(since), until: String(until) };
    const prevWindow = { since: String(prevSince), until: String(since) };
    const errors: Record<string, string> = {};
    const note = (key: string) => (e: Error) => {
      errors[key] = e.message;
      return null;
    };

    const [profile, media, reachSeries, followerSeries, prevTotals, ...totals] = await Promise.all([
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
      // Previous period totals, one call for all three, for the "vs last period" comparison.
      call('/me/insights', {
        metric: 'reach,views,total_interactions', metric_type: 'total_value', period: 'day', ...prevWindow,
      }).catch(note('previous')),
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

    const previous: Record<string, number | null> = {};
    for (const metric of ['reach', 'views', 'total_interactions']) {
      const v = (prevTotals?.data ?? []).find((d: any) => d.name === metric)?.total_value?.value;
      previous[metric] = typeof v === 'number' ? v : null;
    }

    let finalProfile = profile;
    if (!finalProfile || finalProfile.followers_count == null) {
      try {
        const igUserId = await this.connection.getIgUserId(account);
        const fbRepo = (this.connection as any).repo.manager.getRepository('FacebookPageConnection');
        const fbConn = account
          ? await fbRepo.createQueryBuilder('f').where('LOWER(f.owner_username) = :o', { o: String(account).toLowerCase() }).getOne()
          : null;
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
      previous,
      series: { reach: toSeries(reachSeries), followers: toSeries(followerSeries) },
      errors,
    };
  }
}
