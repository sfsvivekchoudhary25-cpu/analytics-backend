import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GRAPH } from './graph-client.service';
import { InstagramConnectionService } from './instagram-connection.service';
import { User } from '../auth/user.entity';

// Official Instagram Graph API permissions for Professional (Business / Creator) accounts
const DEFAULT_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
  'instagram_business_content_publish',
  'instagram_business_manage_insights',
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
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  private redirectUri(): string {
    if (process.env.INSTAGRAM_REDIRECT_URI) return process.env.INSTAGRAM_REDIRECT_URI;
    const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '') || 'http://localhost:4000';
    return `${base}/instagram/oauth/callback`;
  }

  // Public endpoint: Frontend calls this to obtain the official Instagram OAuth login dialog URL
  @Get('url')
  async authorizeUrl() {
    const appId = process.env.INSTAGRAM_APP_ID;
    if (!appId) {
      throw new Error('INSTAGRAM_APP_ID is not configured in backend .env. Please set your Meta App ID.');
    }

    // `state` is a signed JWT so only flows initiated by this system can finish
    const state = await this.jwt.signAsync({ purpose: 'ig-oauth' }, { expiresIn: '15m' });
    const redirectUri = this.redirectUri();

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(','),
      state,
    });

    this.logger.log(`Initiating Instagram OAuth with redirect URI: ${redirectUri}`);
    return { url: `https://www.instagram.com/oauth/authorize?${params}` };
  }

  // Meta redirects the user's browser here with the authorization code
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

    if (providerError || !code) {
      return back({ error: providerError || 'Instagram authentication was cancelled.' });
    }

    try {
      const payload = await this.jwt.verifyAsync(state ?? '');
      if (payload.purpose !== 'ig-oauth') throw new Error('bad state');
    } catch {
      return back({ error: 'Login session expired or invalid. Please try again.' });
    }

    try {
      const cleanCode = code.replace(/#_$/, '');
      const { token: shortLived, permissions, userId } = await this.exchangeCode(cleanCode);
      const longLived = await this.exchangeLongLived(shortLived);

      // Save/update connection credentials in the database (encrypted at rest)
      const { username } = await this.connection.connect(
        longLived.access_token,
        longLived.expires_in,
        permissions,
        { userId },
      );
      await this.subscribeToMessages(longLived.access_token);

      // Multi-account / User provisioning: Find or create User in app_users
      const handle = (username || 'creator').toLowerCase();
      let user = await this.userRepo.findOne({
        where: [
          { instagramHandle: username },
          { instagramHandle: handle },
          { email: `${handle}@inro.social` },
        ],
      });

      if (!user) {
        user = this.userRepo.create({
          email: `${handle}@inro.social`,
          name: username,
          passwordHash: '',
          instagramHandle: username,
          role: 'admin',
        });
        user = await this.userRepo.save(user);
      } else if (!user.instagramHandle) {
        user.instagramHandle = username;
        await this.userRepo.save(user);
      }

      // Generate session JWT for the authenticated user
      const sessionToken = await this.jwt.signAsync({
        sub: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        instagramHandle: user.instagramHandle,
      });

      const missing = SCOPES.filter((s) => !permissions.includes(s));
      this.logger.log(`Instagram OAuth login OK for @${username}. Session created for user ${user.id}`);
      if (missing.length) this.logger.warn(`Permissions requested but NOT granted: ${missing.join(', ')}`);

      return back({
        auth_token: sessionToken,
        connected: username,
        perms: permissions.join(','),
        ...(missing.length && permissions.length ? { missing: missing.join(',') } : {}),
      });
    } catch (err) {
      this.logger.error('Instagram OAuth failed', err as Error);
      return back({ error: (err as Error).message });
    }
  }

  private async exchangeCode(code: string): Promise<{ token: string; permissions: string[]; userId?: string }> {
    const res = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: process.env.INSTAGRAM_APP_ID ?? '',
        client_secret: process.env.INSTAGRAM_APP_SECRET ?? '',
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri(),
        code,
      }),
    });

    const body = await res.json();
    this.logger.log(`Instagram exchangeCode response: ${JSON.stringify(body)}`);
    const first = body.data?.[0] ?? body;
    const token = first.access_token;
    if (!res.ok || !token) throw new Error(body.error_message ?? body.error?.message ?? 'Instagram rejected the authorization code.');

    const raw = first.permissions ?? body.permissions ?? [];
    const permissions: string[] = (Array.isArray(raw) ? raw : String(raw).split(',')).map((p: string) => p.trim()).filter(Boolean);
    const userId = first.user_id ? String(first.user_id) : undefined;
    return { token, permissions, userId };
  }

  private async exchangeLongLived(shortLived: string): Promise<{ access_token: string; expires_in: number }> {
    const appId = process.env.INSTAGRAM_APP_ID || process.env.FACEBOOK_APP_ID || '';
    const clientSecret = process.env.INSTAGRAM_APP_SECRET || process.env.FACEBOOK_APP_SECRET || '';

    // 1. Try Meta Graph API exchange (fb_exchange_token)
    if (appId && clientSecret) {
      try {
        const fbUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${clientSecret}&fb_exchange_token=${shortLived}`;
        const fbRes = await fetch(fbUrl);
        const fbBody = await fbRes.json();
        if (fbRes.ok && fbBody.access_token) {
          this.logger.log('Successfully acquired 60-day long-lived Instagram token via Meta Graph API');
          return {
            access_token: fbBody.access_token,
            expires_in: fbBody.expires_in ?? 5184000,
          };
        } else {
          this.logger.debug?.(`fb_exchange_token response: status=${fbRes.status} body=${JSON.stringify(fbBody)}`);
        }
      } catch (e) {
        this.logger.warn(`Meta fb_exchange_token error: ${e}`);
      }
    }

    // 2. Try Instagram Graph API exchange (ig_exchange_token)
    if (clientSecret) {
      try {
        const params = new URLSearchParams({
          grant_type: 'ig_exchange_token',
          client_secret: clientSecret,
          access_token: shortLived,
        });

        const res = await fetch(`https://graph.instagram.com/access_token?${params}`);
        const body: any = await res.json().catch(() => ({}));
        if (res.ok && body.access_token) {
          this.logger.log('Successfully acquired 60-day long-lived Instagram access token');
          return {
            access_token: body.access_token,
            expires_in: body.expires_in ?? 5184000,
          };
        } else {
          this.logger.warn(`Instagram ig_exchange_token failed: status=${res.status} body=${JSON.stringify(body)}`);
        }
      } catch (e) {
        this.logger.warn(`Instagram ig_exchange_token error: ${e}`);
      }
    }

    // 3. Graceful fallback: use short-lived token so user login doesn't fail
    this.logger.log('Proceeding with verified short-lived token to preserve seamless user session');
    return {
      access_token: shortLived,
      expires_in: 3600,
    };
  }

  private async subscribeToMessages(accessToken: string) {
    try {
      const params = new URLSearchParams({
        subscribed_fields: 'messages,messaging_seen,message_reactions,messaging_postbacks,messaging_referral',
        access_token: accessToken,
      });
      const res = await fetch(`${GRAPH}/me/subscribed_apps?${params}`, { method: 'POST' });
      if (!res.ok) this.logger.warn(`Webhook subscribe failed: ${await res.text()}`);
    } catch (err) {
      this.logger.warn(`Webhook subscribe threw: ${(err as Error).message}`);
    }
  }
}
