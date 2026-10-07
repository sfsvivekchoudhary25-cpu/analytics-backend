import { Controller, Get, Logger, Query, Res, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard } from '../auth/auth.guard';
import { GRAPH } from './graph-client.service';
import { InstagramConnectionService } from './instagram-connection.service';

const DEFAULT_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
  'instagram_business_manage_insights',
  'instagram_manage_engagement',
  'pages_show_list',
  'pages_read_engagement',
  'instagram_manage_upcoming_events',
];

const SCOPES = (process.env.INSTAGRAM_OAUTH_SCOPES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean).length
  ? process.env.INSTAGRAM_OAUTH_SCOPES!.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_SCOPES;

type Redirector = { redirect(url: string): void };

@Controller('instagram/oauth')
export class InstagramOauthController {
  private readonly logger = new Logger(InstagramOauthController.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly connection: InstagramConnectionService,
  ) {}

  // Admin panel asks for the Instagram login URL, then sends the browser there.
  @UseGuards(AuthGuard)
  @Get('url')
  async authorizeUrl() {
    // `state` is a short-lived signed token so only flows we started can finish.
    const state = await this.jwt.signAsync({ purpose: 'ig-oauth' }, { expiresIn: '10m' });
    const params = new URLSearchParams({
      client_id: process.env.INSTAGRAM_APP_ID ?? '',
      redirect_uri: process.env.INSTAGRAM_REDIRECT_URI ?? '',
      response_type: 'code',
      scope: SCOPES.join(','),
      state,
    });
    return { url: `https://www.instagram.com/oauth/authorize?${params}` };
  }

  // Instagram redirects the browser here; this URL is what you register in the Meta dashboard.
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error_description') providerError: string,
    @Res() res: Redirector,
  ) {
    const back = (q: Record<string, string>) =>
      res.redirect(`${process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000'}/?${new URLSearchParams(q)}`);

    if (providerError || !code) return back({ error: providerError || 'Instagram login was cancelled.' });
    try {
      const payload = await this.jwt.verifyAsync(state ?? '');
      if (payload.purpose !== 'ig-oauth') throw new Error('bad state');
    } catch {
      return back({ error: 'Login session expired or invalid. Please try again.' });
    }

    try {
      const { token: shortLived, permissions } = await this.exchangeCode(code.replace(/#_$/, ''));
      const longLived = await this.exchangeLongLived(shortLived);
      const { username } = await this.connection.connect(longLived.access_token, longLived.expires_in, permissions);
      await this.subscribeToMessages(longLived.access_token);

      // The login response is the only place Instagram states which permissions this token really holds.
      const missing = SCOPES.filter((s) => !permissions.includes(s));
      this.logger.log(`Instagram login OK for @${username}. Permissions granted: ${permissions.join(', ') || '(not reported)'}`);
      if (missing.length) this.logger.warn(`Permissions requested but NOT granted: ${missing.join(', ')}`);
      return back({
        connected: username,
        perms: permissions.join(','),
        ...(missing.length && permissions.length ? { missing: missing.join(',') } : {}),
      });
    } catch (err) {
      this.logger.error('Instagram OAuth failed', err as Error);
      return back({ error: (err as Error).message });
    }
  }

  private async exchangeCode(code: string): Promise<{ token: string; permissions: string[] }> {
    const res = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: process.env.INSTAGRAM_APP_ID ?? '',
        client_secret: process.env.INSTAGRAM_APP_SECRET ?? '',
        grant_type: 'authorization_code',
        redirect_uri: process.env.INSTAGRAM_REDIRECT_URI ?? '',
        code,
      }),
    });
    const body = await res.json();
    const first = body.data?.[0] ?? body;
    const token = first.access_token;
    if (!res.ok || !token) throw new Error(body.error_message ?? 'Instagram rejected the login code.');
    // `permissions` is a comma-separated string or an array, depending on the API version.
    const raw = first.permissions ?? body.permissions ?? [];
    const permissions: string[] = (Array.isArray(raw) ? raw : String(raw).split(',')).map((p: string) => p.trim()).filter(Boolean);
    return { token, permissions };
  }

  private async exchangeLongLived(shortLived: string): Promise<{ access_token: string; expires_in: number }> {
    const params = new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: process.env.INSTAGRAM_APP_SECRET ?? '',
      access_token: shortLived,
    });
    const res = await fetch(`https://graph.instagram.com/access_token?${params}`);
    const body = await res.json();
    if (!res.ok || !body.access_token) throw new Error('Could not get a long-lived Instagram token.');
    return body;
  }

  // Best effort: the account still connects if this fails (e.g. messages permission not granted).
  private async subscribeToMessages(accessToken: string) {
    try {
      const params = new URLSearchParams({ subscribed_fields: 'messages,messaging_seen,message_reactions,messaging_postbacks,messaging_referral', access_token: accessToken });
      const res = await fetch(`${GRAPH}/me/subscribed_apps?${params}`, { method: 'POST' });
      if (!res.ok) this.logger.warn(`Webhook subscribe failed: ${await res.text()}`);
    } catch (err) {
      this.logger.warn(`Webhook subscribe threw: ${(err as Error).message}`);
    }
  }
}
