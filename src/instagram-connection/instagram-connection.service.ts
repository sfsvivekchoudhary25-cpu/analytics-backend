import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { existsSync, promises as fs } from 'fs';
import { join } from 'path';
import { InstagramConnection } from './instagram-connection.entity';
import { UPLOAD_DIR } from '../submissions/paths';

const GRAPH_BASE = 'https://graph.instagram.com';
const REFRESH_WINDOW_DAYS = 10; // refresh once fewer than this many days remain

@Injectable()
export class InstagramConnectionService {
  private readonly logger = new Logger(InstagramConnectionService.name);

  constructor(
    @InjectRepository(InstagramConnection)
    private readonly repo: Repository<InstagramConnection>,
  ) {}

  private async cacheProfilePicture(metaUrl: string, filename = 'brand-avatar.jpg'): Promise<string | null> {
    try {
      const res = await fetch(metaUrl);
      if (!res.ok) return null;
      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      const filePath = join(UPLOAD_DIR, filename);
      await fs.writeFile(filePath, buf);
      this.logger.log(`Cached Instagram profile picture (${buf.length} bytes) to ${filePath}`);
      return `/media/${filename}`;
    } catch (e) {
      this.logger.warn(`Failed to cache profile picture locally: ${e}`);
      return null;
    }
  }

  // One-time: paste in the long-lived token you generated in the Meta dashboard.
  // Verifies it actually works before saving anything.
  async connect(
    accessToken: string,
    expiresInSeconds = 60 * 24 * 60 * 60,
    permissions: string[] | null = null, // only known when connecting through the login flow
  ): Promise<{ username: string }> {
    let me: { user_id: string; username: string; profile_picture_url?: string } | null = null;
    let livePermissions: string[] = permissions ?? [];

    const meRes = await fetch(`${GRAPH_BASE}/me?fields=user_id,username,profile_picture_url&access_token=${accessToken}`);
    if (meRes.ok) {
      me = await meRes.json();
    } else {
      // Fallback: Check if this is a Meta / Facebook System User or Page token
      const FB_API = 'https://graph.facebook.com/v21.0';
      const fbAccRes = await fetch(`${FB_API}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,profile_picture_url}&access_token=${accessToken}`);
      const fbAccBody = await fbAccRes.json();
      const igAcc = fbAccBody?.data?.find((p: any) => p.instagram_business_account)?.instagram_business_account;
      if (igAcc?.id && igAcc?.username) {
        me = {
          user_id: igAcc.id,
          username: igAcc.username,
          profile_picture_url: igAcc.profile_picture_url,
        };
        // Automatically fetch live permissions from Meta
        try {
          const perms = await fetch(`${FB_API}/me/permissions?access_token=${accessToken}`).then((r) => r.json());
          if (Array.isArray(perms?.data)) {
            livePermissions = perms.data.filter((p: any) => p.status === 'granted').map((p: any) => p.permission);
          }
        } catch {}
      }
    }

    if (!me) {
      throw new BadRequestException('Could not verify that token with Instagram. Double-check it and try again.');
    }

    const connection = (await this.getConnectionRow()) ?? this.repo.create();
    connection.igUserId = me.user_id;
    connection.username = me.username;

    let localAvatar: string | null = null;
    if (me.profile_picture_url) {
      localAvatar = await this.cacheProfilePicture(me.profile_picture_url);
    }
    connection.profilePictureUrl = localAvatar || me.profile_picture_url || null;
    connection.accessToken = accessToken;
    connection.tokenExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    connection.permissions = livePermissions && livePermissions.length ? livePermissions.join(',') : connection.permissions || null;

    await this.repo.save(connection);
    return { username: connection.username };
  }

  // Live-syncs granted permissions directly from Meta without manual database intervention
  async syncLivePermissions(): Promise<string[]> {
    const connection = await this.getConnectionRow();
    if (!connection) return [];

    const grantedSet = new Set<string>();
    if (connection.permissions) {
      connection.permissions.split(',').forEach((p) => p.trim() && grantedSet.add(p.trim()));
    }

    // Try checking Meta permissions if a Facebook Page connection exists
    try {
      const FB_API = 'https://graph.facebook.com/v21.0';
      const fbConn = (await this.repo.manager.getRepository('FacebookPageConnection').findOne({ where: {} })) as any;
      if (fbConn?.pageAccessToken) {
        const permsRes = await fetch(`${FB_API}/me/permissions?access_token=${encodeURIComponent(fbConn.pageAccessToken)}`);
        const permsBody = await permsRes.json();
        if (permsRes.ok && Array.isArray(permsBody.data)) {
          permsBody.data
            .filter((p: any) => p.status === 'granted')
            .forEach((p: any) => grantedSet.add(p.permission));
        }
      }
    } catch {}

    const list = Array.from(grantedSet);
    if (list.length > 0) {
      connection.permissions = list.join(',');
      await this.repo.save(connection);
      this.logger.log(`Live synced ${list.length} permissions: ${connection.permissions}`);
    }
    return list;
  }

  async getStatus() {
    const connection = await this.getConnectionRow();
    if (!connection) {
      return { connected: false };
    }

    const localAvatarPath = join(UPLOAD_DIR, 'brand-avatar.jpg');
    const localAvatarExists = existsSync(localAvatarPath);

    // Refresh & cache avatar if missing locally or if stored as an old external URL
    if ((!localAvatarExists || !connection.profilePictureUrl || connection.profilePictureUrl.startsWith('http')) && connection.accessToken) {
      try {
        const info = await fetch(`${GRAPH_BASE}/me?fields=id,username,profile_picture_url&access_token=${connection.accessToken}`).then((r) => r.json());
        if (info?.profile_picture_url) {
          const cached = await this.cacheProfilePicture(info.profile_picture_url);
          if (cached) {
            connection.profilePictureUrl = cached;
            await this.repo.save(connection);
          }
        }
      } catch (err) {
        this.logger.warn(`Could not refresh profile picture: ${err}`);
      }
    }

    const effectiveProfilePic = (existsSync(localAvatarPath) ? '/media/brand-avatar.jpg' : connection.profilePictureUrl) ?? null;

    return {
      connected: true,
      username: connection.username,
      profilePictureUrl: effectiveProfilePic,
      expiresAt: connection.tokenExpiresAt,
      permissions: connection.permissions ? connection.permissions.split(',') : null,
    };
  }

  // Used by the posting/messaging modules we build next.
  async getValidAccessToken(): Promise<string> {
    return (await this.getConnectionOrThrow()).accessToken;
  }

  async getIgUserId(): Promise<string> {
    return (await this.getConnectionOrThrow()).igUserId;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async refreshTokenIfNeeded() {
    const connection = await this.getConnectionRow();
    if (!connection) return;

    const daysLeft = (connection.tokenExpiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysLeft > REFRESH_WINDOW_DAYS) return;

    try {
      const res = await fetch(
        `${GRAPH_BASE}/refresh_access_token?grant_type=ig_refresh_token&access_token=${connection.accessToken}`,
      );
      if (!res.ok) {
        this.logger.error('Instagram token refresh failed - you will need to reconnect the account manually.');
        return;
      }
      const body = await res.json();
      connection.accessToken = body.access_token;
      connection.tokenExpiresAt = new Date(Date.now() + body.expires_in * 1000);
      await this.repo.save(connection);
      this.logger.log('Instagram access token refreshed.');

      // Also refresh brand profile picture
      try {
        const me = await fetch(`${GRAPH_BASE}/me?fields=profile_picture_url&access_token=${connection.accessToken}`).then((r) => r.json());
        if (me?.profile_picture_url) {
          const cached = await this.cacheProfilePicture(me.profile_picture_url);
          if (cached) {
            connection.profilePictureUrl = cached;
            await this.repo.save(connection);
          }
        }
      } catch {}
    } catch (err) {
      this.logger.error('Instagram token refresh threw an error', err as Error);
    }
  }

  private async getConnectionRow(): Promise<InstagramConnection | null> {
    const [connection] = await this.repo.find({ take: 1 });
    return connection ?? null;
  }

  private async getConnectionOrThrow(): Promise<InstagramConnection> {
    const connection = await this.getConnectionRow();
    if (!connection) {
      throw new BadRequestException('No Instagram account connected yet.');
    }
    return connection;
  }
}
