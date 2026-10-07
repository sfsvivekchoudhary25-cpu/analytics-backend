import { Controller, Get, Logger, Query, Res, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard } from '../auth/auth.guard';
import { InstagramConnectionService } from '../instagram-connection/instagram-connection.service';
import { FacebookPageService } from './facebook-page.service';

// This app only has "Facebook Login for Business" configured (not classic "Facebook Login"), which rejects
// the plain scope-based /dialog/oauth call outright (confirmed directly against Facebook's servers: a request
// with only `scope` came back `PLATFORM__INVALID_APP_ID`, regardless of a correct app ID). Business Login
// requires a pre-created Login Configuration instead, referenced by `config_id` — permissions are baked into
// that configuration in the dashboard, not requested here.
const FB_API = 'https://graph.facebook.com/v21.0';

type Redirector = { redirect(url: string): void };

@Controller('facebook-page/oauth')
export class FacebookOauthController {
  private readonly logger = new Logger('Facebook Page OAuth');

  constructor(
    private readonly jwt: JwtService,
    private readonly connection: InstagramConnectionService,
    private readonly pages: FacebookPageService,
  ) {}

  @UseGuards(AuthGuard)
  @Get('url')
  async authorizeUrl() {
    const state = await this.jwt.signAsync({ purpose: 'fb-page-oauth' }, { expiresIn: '10m' });
    const appId = process.env.FACEBOOK_APP_ID ?? process.env.INSTAGRAM_APP_ID ?? '';
    const configId = process.env.FACEBOOK_LOGIN_CONFIG_ID ?? '';
    if (!configId) throw new Error('FACEBOOK_LOGIN_CONFIG_ID is not set — add the Configuration ID from the Meta dashboard.');
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      config_id: configId,
      state,
    });
    // Unversioned path, not /v21.0/dialog/oauth — confirmed directly (curl, no browser cache involved) that the
    // versioned path returns a misleading PLATFORM__INVALID_APP_ID for a perfectly valid app ID, while this
    // exact same request against the unversioned endpoint redirects correctly to Facebook's login page.
    return { url: `https://www.facebook.com/dialog/oauth?${params}` };
  }

  // Register this exact URL (shown in the backend startup log) as a valid OAuth Redirect URI under
  // Facebook Login for Business in the Meta App dashboard.
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error_description') providerError: string,
    @Res() res: Redirector,
  ) {
    const back = (q: Record<string, string>) =>
      res.redirect(`${process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000'}/?${new URLSearchParams(q)}`);

    if (providerError || !code) return back({ error: providerError || 'Facebook login was cancelled.' });
    try {
      const payload = await this.jwt.verifyAsync(state ?? '');
      if (payload.purpose !== 'fb-page-oauth') throw new Error('bad state');
    } catch {
      return back({ error: 'Login session expired or invalid. Please try again.' });
    }

    try {
      const userToken = await this.exchangeCode(code);
      const longLivedUserToken = await this.exchangeLongLived(userToken);
      const pages = await this.listPages(longLivedUserToken);
      if (pages.length === 0) {
        return back({ error: 'That Facebook login has no Pages you manage. Create/link a Page to your Instagram account first.' });
      }

      // Prefer the Page whose linked Instagram account matches the one already connected via Instagram Login.
      const myIgUserId = await this.connection.getIgUserId().catch(() => null);
      const matched = myIgUserId ? pages.find((p) => p.instagram_business_account?.id === myIgUserId) : null;
      const chosen = matched ?? (pages.length === 1 ? pages[0] : null);

      if (!chosen) {
        const names = pages.map((p) => p.name).join(', ');
        return back({
          error: `Found ${pages.length} Pages (${names}) but none match your connected Instagram account. Make sure the right Page is linked to @${myIgUserId ? 'your Instagram account' : 'it'} in Meta Business Suite.`,
        });
      }

      await this.pages.connect(chosen.id, chosen.name, chosen.access_token, chosen.instagram_business_account?.id ?? null);
      this.logger.log(`Facebook Page connected: "${chosen.name}" (id ${chosen.id})${matched ? ', matches your Instagram account' : ''}.`);
      return back({ fbPageConnected: chosen.name });
    } catch (err) {
      this.logger.error('Facebook Page OAuth failed', err as Error);
      return back({ error: (err as Error).message });
    }
  }

  private redirectUri(): string {
    if (process.env.FACEBOOK_REDIRECT_URI) return process.env.FACEBOOK_REDIRECT_URI;
    const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
    return `${base}/facebook-page/oauth/callback`;
  }

  private async exchangeCode(code: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: process.env.FACEBOOK_APP_ID ?? process.env.INSTAGRAM_APP_ID ?? '',
      client_secret: process.env.FACEBOOK_APP_SECRET ?? process.env.INSTAGRAM_APP_SECRET ?? '',
      redirect_uri: this.redirectUri(),
      code,
    });
    const res = await fetch(`${FB_API}/oauth/access_token?${params}`);
    const body = await res.json();
    if (!res.ok || !body.access_token) throw new Error(body.error?.message ?? 'Facebook rejected the login code.');
    return body.access_token;
  }

  private async exchangeLongLived(shortLived: string): Promise<string> {
    const params = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: process.env.FACEBOOK_APP_ID ?? process.env.INSTAGRAM_APP_ID ?? '',
      client_secret: process.env.FACEBOOK_APP_SECRET ?? process.env.INSTAGRAM_APP_SECRET ?? '',
      fb_exchange_token: shortLived,
    });
    const res = await fetch(`${FB_API}/oauth/access_token?${params}`);
    const body = await res.json();
    if (!res.ok || !body.access_token) throw new Error('Could not get a long-lived Facebook token.');
    return body.access_token;
  }

  private async listPages(
    userToken: string,
  ): Promise<{ id: string; name: string; access_token: string; instagram_business_account?: { id: string } }[]> {
    const params = new URLSearchParams({ fields: 'id,name,access_token,instagram_business_account', access_token: userToken });
    const res = await fetch(`${FB_API}/me/accounts?${params}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message ?? 'Could not list your Facebook Pages.');
    return body.data ?? [];
  }
}
