import { Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
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

  private redirectUri(clientOrigin?: string): string {
    // If an explicit HTTPS override is provided in env, use it
    if (process.env.FACEBOOK_REDIRECT_URI && process.env.FACEBOOK_REDIRECT_URI.startsWith('https://')) {
      return process.env.FACEBOOK_REDIRECT_URI;
    }
    // Meta strictly enforces HTTPS for Facebook Login for Business with Configurations.
    // Use the registered production HTTPS callback so Meta's OAuth dialog never rejects plain http://
    return 'https://analytics-backend-vxak.onrender.com/facebook-page/oauth/callback';
  }

  @Get('url')
  async authorizeUrl(@Query('origin') clientOrigin?: string, @Query('return_path') queryReturnPath?: string, @Req() req?: any) {
    let detectedOrigin = clientOrigin || req?.headers?.origin;
    if (!detectedOrigin && req?.headers?.referer) {
      try {
        detectedOrigin = new URL(req.headers.referer).origin;
      } catch {}
    }
    if (!detectedOrigin) {
      detectedOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';
    }

    const returnPath = queryReturnPath || '/account';
    const redirectUri = this.redirectUri(detectedOrigin);

    const state = await this.jwt.signAsync(
      { purpose: 'fb-page-oauth', origin: detectedOrigin, redirectUri, returnPath },
      { expiresIn: '15m' },
    );
    const appId = process.env.FACEBOOK_APP_ID ?? process.env.INSTAGRAM_APP_ID ?? '';
    const configId = process.env.FACEBOOK_LOGIN_CONFIG_ID || '';

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
    });

    // Use standard scopes by default. Only use config_id if caller explicitly passes use_config=1
    const useConfig = req?.query?.use_config === 'true' || req?.query?.use_config === '1';
    if (useConfig && configId) {
      params.append('config_id', configId);
      params.append('override_default_response_type', 'true');
    } else {
      params.append(
        'scope',
        'pages_show_list,pages_read_engagement,pages_manage_metadata,instagram_basic,instagram_manage_comments,instagram_manage_messages,public_profile',
      );
    }

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
    let frontendBase = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000';
    let matchedRedirectUri = this.redirectUri();
    let returnPath = '/account';

    const back = (q: Record<string, string>) =>
      res.redirect(`${frontendBase}${returnPath}?${new URLSearchParams(q)}`);

    if (providerError || !code) return back({ error: providerError || 'Facebook login was cancelled.' });
    try {
      const payload = await this.jwt.verifyAsync(state ?? '');
      if (payload.purpose !== 'fb-page-oauth') throw new Error('bad state');
      if (payload.origin) frontendBase = payload.origin.replace(/\/$/, '');
      if (payload.returnPath) returnPath = payload.returnPath;
      if (payload.redirectUri) matchedRedirectUri = payload.redirectUri;
    } catch {
      return back({ error: 'Login session expired or invalid. Please try again.' });
    }

    try {
      const userToken = await this.exchangeCode(code, matchedRedirectUri);
      const longLivedUserToken = await this.exchangeLongLived(userToken);
      const pages = await this.listPages(longLivedUserToken);
      if (pages.length === 0) {
        return back({ error: 'That Facebook login has no Pages you manage. Create/link a Page to your Instagram account first.' });
      }

      // Prefer the Page whose linked Instagram account matches the one already connected via Instagram Login.
      const myIgUserId = await this.connection.getIgUserId().catch(() => null);
      const matched = myIgUserId ? pages.find((p) => p.instagram_business_account?.id === myIgUserId) : null;
      // Fallback: pick any page that has a linked Instagram account, then just the first page
      const withIg = pages.find((p) => p.instagram_business_account?.id);
      const chosen = matched ?? (pages.length === 1 ? pages[0] : withIg ?? pages[0]);

      if (!chosen) {
        const names = pages.map((p) => p.name).join(', ');
        return back({
          error: `Found ${pages.length} Pages (${names}) but none match your connected Instagram account. Make sure the right Page is linked to your Instagram account in Meta Business Suite.`,
        });
      }

      await this.pages.connect(chosen.id, chosen.name, chosen.access_token, chosen.instagram_business_account?.id ?? null);
      this.logger.log(`Facebook Page connected: "${chosen.name}" (id ${chosen.id})${matched ? ', matches your Instagram account' : ''}.`);

      // Dynamically auto-connect Instagram connection using Page access token if not already connected
      try {
        await this.connection.connect(chosen.access_token);
        this.logger.log(`Auto-connected Instagram account via Facebook Page token for page "${chosen.name}"`);
      } catch (igErr) {
        this.logger.warn(`Could not auto-connect Instagram from Facebook Page token: ${igErr}`);
      }

      // Sync all permissions from user token to Instagram connection
      try {
        const permsRes = await fetch(`${FB_API}/me/permissions?access_token=${encodeURIComponent(longLivedUserToken)}`);
        const permsBody = await permsRes.json();
        if (permsRes.ok && Array.isArray(permsBody.data)) {
          const granted = permsBody.data
            .filter((p: any) => p.status === 'granted')
            .map((p: any) => p.permission);
          if (granted.length > 0) {
            await this.pages.syncPermissionsToInstagramConnection(granted);
          }
        }
      } catch (err) {
        this.logger.warn(`Could not sync permissions after Facebook OAuth: ${err}`);
      }

      // Live-sync all permissions from Meta
      try {
        await this.connection.syncLivePermissions();
      } catch (syncErr) {
        this.logger.warn(`Could not live-sync permissions: ${syncErr}`);
      }

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

  private async exchangeCode(code: string, redirectUri?: string): Promise<string> {
    const uri = redirectUri || this.redirectUri();
    const params = new URLSearchParams({
      client_id: process.env.FACEBOOK_APP_ID ?? process.env.INSTAGRAM_APP_ID ?? '',
      client_secret: process.env.FACEBOOK_APP_SECRET ?? process.env.INSTAGRAM_APP_SECRET ?? '',
      redirect_uri: uri,
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
