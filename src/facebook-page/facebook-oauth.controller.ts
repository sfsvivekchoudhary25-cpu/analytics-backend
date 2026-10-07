import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InstagramConnectionService } from '../instagram-connection/instagram-connection.service';
import { FacebookPageService } from './facebook-page.service';
import { User } from '../auth/user.entity';

const FB_API = 'https://graph.facebook.com/v21.0';

type Redirector = { redirect(url: string): void };

@Controller('facebook-page/oauth')
export class FacebookOauthController {
  private readonly logger = new Logger('Facebook Page OAuth');

  constructor(
    private readonly jwt: JwtService,
    private readonly connection: InstagramConnectionService,
    private readonly pages: FacebookPageService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  @Get('url')
  async authorizeUrl() {
    const state = await this.jwt.signAsync({ purpose: 'fb-page-oauth' }, { expiresIn: '15m' });
    const appId = process.env.FACEBOOK_APP_ID ?? process.env.INSTAGRAM_APP_ID ?? '';
    const configId = process.env.FACEBOOK_LOGIN_CONFIG_ID ?? '';
    if (!configId) {
      throw new Error('FACEBOOK_LOGIN_CONFIG_ID is not configured in backend .env. Add the Configuration ID from the Meta dashboard.');
    }
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      config_id: configId,
      state,
    });
    return { url: `https://www.facebook.com/dialog/oauth?${params}` };
  }

  // Register this exact URL as a valid OAuth Redirect URI under Facebook Login for Business in Meta dashboard.
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error_description') providerError: string,
    @Res() res: Redirector,
  ) {
    const frontendBase = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000';
    const back = (q: Record<string, string>) =>
      res.redirect(`${frontendBase}/?${new URLSearchParams(q)}`);

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

      // Also auto-provision or find user in app_users
      let igUsername = (await this.connection.getStatus()).username || null;
      if (!igUsername && chosen.instagram_business_account?.id) {
        try {
          const igInfo = await fetch(`https://graph.facebook.com/v21.0/${chosen.instagram_business_account.id}?fields=username&access_token=${chosen.access_token}`).then(r => r.json());
          if (igInfo?.username) igUsername = igInfo.username;
        } catch {}
      }

      let sessionToken = '';
      if (igUsername) {
        const handle = igUsername.toLowerCase();
        let user = await this.userRepo.findOne({
          where: [{ instagramHandle: igUsername }, { instagramHandle: handle }, { email: `${handle}@inro.social` }],
        });
        if (!user) {
          user = this.userRepo.create({
            email: `${handle}@inro.social`,
            name: chosen.name || igUsername,
            passwordHash: '',
            instagramHandle: igUsername,
            role: 'admin',
          });
          user = await this.userRepo.save(user);
        }
        sessionToken = await this.jwt.signAsync({
          sub: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          instagramHandle: user.instagramHandle,
        });
      }

      return back({
        ...(sessionToken ? { auth_token: sessionToken } : {}),
        fbPageConnected: chosen.name,
        ...(igUsername ? { connected: igUsername } : {}),
      });
    } catch (err) {
      this.logger.error('Facebook Page OAuth failed', err as Error);
      return back({ error: (err as Error).message });
    }
  }

  private redirectUri(): string {
    if (process.env.FACEBOOK_REDIRECT_URI) return process.env.FACEBOOK_REDIRECT_URI;
    const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '') || 'http://localhost:4000';
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
