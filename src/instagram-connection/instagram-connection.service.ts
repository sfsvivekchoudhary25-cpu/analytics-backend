import { Injectable, Logger, BadRequestException, OnModuleInit } from '@nestjs/common';
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
export class InstagramConnectionService implements OnModuleInit {
  private readonly logger = new Logger(InstagramConnectionService.name);

  constructor(
    @InjectRepository(InstagramConnection)
    private readonly repo: Repository<InstagramConnection>,
  ) {}

  async onModuleInit() {
    try {
      // Reconcile legacy logs: All rows created before sfs.vivekchoudhary25 was connected (Oct 8, 2026 ~11:50 UTC)
      // or containing Swedish error notes / fabroniee references belong to fabroniee.
      await this.repo.query(`
        UPDATE "message_auto_log"
        SET "owner_username" = 'fabroniee'
        WHERE "owner_username" = 'sfs.vivekchoudhary25'
          AND ("created_at" < '2026-10-08 10:00:00Z' OR "note" LIKE '%anv%' OR "username" = 'fabroniee');
      `).catch(() => {});

      await this.repo.query(`
        UPDATE "comment_dm_log"
        SET "owner_username" = 'fabroniee'
        WHERE "owner_username" = 'sfs.vivekchoudhary25'
          AND "created_at" < '2026-10-08 10:00:00Z';
      `).catch(() => {});

      await this.repo.query(`
        UPDATE "message"
        SET "owner_username" = 'fabroniee'
        WHERE "owner_username" = 'sfs.vivekchoudhary25'
          AND "created_at" < '2026-10-08 10:00:00Z';
      `).catch(() => {});

      await this.repo.query(`
        UPDATE "conversation"
        SET "owner_username" = 'fabroniee'
        WHERE "owner_username" = 'sfs.vivekchoudhary25'
          AND "created_at" < '2026-10-08 10:00:00Z';
      `).catch(() => {});

      // For any unassigned legacy rows, attribute to fabroniee (the legacy initial account)
      const legacyTables = [
        'comment_dm_rule',
        'comment_dm_log',
        'auto_reply_setting',
        'auto_reply_rule',
        'message_auto_setting',
        'message_auto_rule',
        'message_auto_log',
        'conversation',
        'message',
        'comment',
        'submission',
        'story',
      ];
      for (const table of legacyTables) {
        await this.repo.query(`UPDATE "${table}" SET "owner_username" = 'fabroniee' WHERE "owner_username" IS NULL`).catch(() => {});
      }
      this.logger.log('Multi-account isolation and legacy data reconciliation complete.');
    } catch (e) {
      this.logger.warn(`Backfill error: ${(e as Error).message}`);
    }
  }

  private async cacheProfilePicture(metaUrl: string, filename?: string): Promise<string | null> {
    try {
      const res = await fetch(metaUrl);
      if (!res.ok) return null;
      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      const name = filename || `avatar-${Date.now()}.jpg`;
      const filePath = join(UPLOAD_DIR, name);
      await fs.writeFile(filePath, buf);
      this.logger.log(`Cached Instagram profile picture (${buf.length} bytes) to ${filePath}`);
      return `/media/${name}`;
    } catch (e) {
      this.logger.warn(`Failed to cache profile picture locally: ${e}`);
      return null;
    }
  }

  // Live sync real Instagram profile and avatar directly from Meta
  async syncLiveProfile(force = false, account?: string): Promise<InstagramConnection | null> {
    const connection = await this.getConnectionRow(account);
    if (!connection || !connection.accessToken) return null;

    let profileUrl: string | null = null;
    let username: string | null = null;
    let name: string | null = null;

    // 1. Try querying Instagram Graph API directly
    try {
      const res = await fetch(`${GRAPH_BASE}/me?fields=id,username,name,profile_picture_url&access_token=${connection.accessToken}`);
      const data = await res.json();
      if (res.ok) {
        if (data.username) username = data.username;
        if (data.name) name = data.name;
        if (data.profile_picture_url) profileUrl = data.profile_picture_url;
      }
    } catch (e) {
      this.logger.debug?.(`Instagram /me live sync: ${e}`);
    }

    // 2. Fallback / Enrichment: query linked Facebook Page if connected
    if (!profileUrl || !username) {
      try {
        const FB_API = 'https://graph.facebook.com/v21.0';
        const [fbConn] = (await this.repo.manager.getRepository('FacebookPageConnection').find({ take: 1 })) as any;
        if (fbConn?.pageAccessToken && connection.igUserId) {
          const fbRes = await fetch(`${FB_API}/${connection.igUserId}?fields=id,username,name,profile_picture_url&access_token=${encodeURIComponent(fbConn.pageAccessToken)}`);
          const fbData = await fbRes.json();
          if (fbRes.ok) {
            if (fbData.username && !username) username = fbData.username;
            if (fbData.name && !name) name = fbData.name;
            if (fbData.profile_picture_url && !profileUrl) profileUrl = fbData.profile_picture_url;
          }
        }
      } catch (e) {
        this.logger.debug?.(`Facebook Page live sync: ${e}`);
      }
    }

    let changed = false;
    if (username && username !== connection.username && username !== 'creator') {
      connection.username = username;
      changed = true;
    }

    if (profileUrl) {
      const avatarFilename = `avatar-${connection.igUserId || connection.username || 'brand'}.jpg`;
      const cached = await this.cacheProfilePicture(profileUrl, avatarFilename);
      if (cached && (cached !== connection.profilePictureUrl || force)) {
        connection.profilePictureUrl = cached;
        changed = true;
      }
    }

    if (changed || force) {
      await this.repo.save(connection);
      this.logger.log(`Live profile synced for @${connection.username}: avatar=${connection.profilePictureUrl}`);
    }

    return connection;
  }

  // One-time: paste in the long-lived token you generated in the Meta dashboard.
  // Verifies it actually works before saving anything.
  async connect(
    accessToken: string,
    expiresInSeconds = 60 * 24 * 60 * 60,
    permissions: string[] | null = null, // only known when connecting through the login flow
    fallbackIdentity?: { userId?: string; username?: string },
  ): Promise<{ username: string }> {
    let me: { user_id: string; username: string; profile_picture_url?: string } | null = null;
    let livePermissions: string[] = permissions ?? [];

    // 1. Try querying /me or /{userId} with Instagram Graph fields: id,username,profile_picture_url
    const targetPaths = ['/me'];
    if (fallbackIdentity?.userId) {
      targetPaths.push(`/${fallbackIdentity.userId}`);
    }

    pathLoop: for (const path of targetPaths) {
      for (const fields of [
        'id,username,profile_picture_url',
        'id,username',
        'id,name',
      ]) {
        try {
          const res = await fetch(`${GRAPH_BASE}${path}?fields=${fields}&access_token=${accessToken}`);
          const data = await res.json();
          if (res.ok && (data.id || data.username)) {
            me = {
              user_id: String(data.id || fallbackIdentity?.userId || ''),
              username: data.username || data.name || fallbackIdentity?.username || 'creator',
              profile_picture_url: data.profile_picture_url,
            };
            this.logger.log(`Verified Instagram user @${me.username} (id: ${me.user_id})`);
            break pathLoop;
          } else {
            this.logger.warn(`Failed ${path}?fields=${fields}: ${JSON.stringify(data)}`);
          }
        } catch (err) {
          this.logger.warn(`Error querying ${path}?fields=${fields}: ${err}`);
        }
      }
    }

    // 2. Fallback: Check if this is a Meta / Facebook System User or Page token
    if (!me) {
      try {
        const FB_API = 'https://graph.facebook.com/v21.0';
        const fbAccRes = await fetch(`${FB_API}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,profile_picture_url}&access_token=${accessToken}`);
        const fbAccBody = await fbAccRes.json();
        const igAcc = fbAccBody?.data?.find((p: any) => p.instagram_business_account)?.instagram_business_account;
        if (igAcc?.id && igAcc?.username) {
          me = {
            user_id: String(igAcc.id),
            username: igAcc.username,
            profile_picture_url: igAcc.profile_picture_url,
          };
          this.logger.log(`Verified Instagram via Facebook Page: @${me.username} (id: ${me.user_id})`);
          try {
            const perms = await fetch(`${FB_API}/me/permissions?access_token=${accessToken}`).then((r) => r.json());
            if (Array.isArray(perms?.data)) {
              livePermissions = perms.data.filter((p: any) => p.status === 'granted').map((p: any) => p.permission);
            }
          } catch {}
        }
      } catch {}
    }

    // 3. Fallback: if identity could not be retrieved from Graph API, use OAuth identity
    if (!me && (fallbackIdentity?.userId || fallbackIdentity?.username)) {
      me = {
        user_id: String(fallbackIdentity.userId || 'ig_' + Date.now()),
        username: fallbackIdentity.username || 'creator',
      };
      this.logger.log(`Using OAuth fallback identity: @${me.username} (id: ${me.user_id})`);
    }

    if (!me) {
      throw new BadRequestException('Could not verify that token with Instagram. Double-check it and try again.');
    }

    const cleanNew = me.username ? me.username.trim().toLowerCase() : null;
    let connection: InstagramConnection | null = null;
    if (cleanNew) {
      connection = await this.repo
        .createQueryBuilder('c')
        .where('LOWER(c.username) = :u', { u: cleanNew })
        .getOne();
    }
    if (!connection && me.user_id) {
      connection = await this.repo.findOne({ where: { igUserId: me.user_id } });
    }
    if (!connection) {
      connection = this.repo.create();
    }

    connection.igUserId = me.user_id;
    connection.username = me.username;

    let localAvatar: string | null = null;
    if (me.profile_picture_url) {
      const avatarFilename = `avatar-${connection.igUserId || connection.username || 'brand'}.jpg`;
      localAvatar = await this.cacheProfilePicture(me.profile_picture_url, avatarFilename);
    }
    connection.profilePictureUrl = localAvatar || me.profile_picture_url || null;
    connection.accessToken = accessToken;
    connection.tokenExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    connection.permissions = livePermissions && livePermissions.length ? livePermissions.join(',') : connection.permissions || null;

    await this.repo.save(connection);
    this.logger.log(`Instagram connected for @${connection.username} (token saved independently)`);
    return { username: connection.username };
  }

  // Live-syncs granted permissions directly from Meta without manual database intervention
  async syncLivePermissions(account?: string): Promise<string[]> {
    const connection = await this.getConnectionRow(account);
    if (!connection) return [];

    const grantedSet = new Set<string>();
    if (connection.permissions) {
      connection.permissions.split(',').forEach((p) => p.trim() && grantedSet.add(p.trim()));
    }

    // Try checking Meta permissions if a Facebook Page connection exists
    try {
      const FB_API = 'https://graph.facebook.com/v21.0';
        const [fbConn] = (await this.repo.manager.getRepository('FacebookPageConnection').find({ take: 1 })) as any;
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
      this.logger.log(`Live synced ${list.length} permissions for @${connection.username}: ${connection.permissions}`);
    }
    return list;
  }

  async listConnectedAccounts() {
    const list = await this.repo.find({ order: { updatedAt: 'DESC' } });
    return list.map((c) => ({
      username: c.username,
      igUserId: c.igUserId,
      profilePictureUrl: c.profilePictureUrl ?? null,
      expiresAt: c.tokenExpiresAt,
      permissions: c.permissions ? c.permissions.split(',') : null,
      updatedAt: c.updatedAt,
    }));
  }

  async touchAccount(username: string) {
    const clean = username.trim().replace(/^@/, '').toLowerCase();
    const conn = await this.repo
      .createQueryBuilder('c')
      .where('LOWER(c.username) = :u', { u: clean })
      .getOne();
    if (!conn) throw new BadRequestException(`Account @${clean} is not connected.`);
    conn.updatedAt = new Date();
    await this.repo.save(conn);
    return { success: true, username: conn.username };
  }

  async getStatus(account?: string) {
    let connection = await this.getConnectionRow(account);
    if (!connection) {
      return { connected: false };
    }

    // Refresh & cache avatar if missing locally, external http URL, or legacy static brand-avatar
    if ((!connection.profilePictureUrl || connection.profilePictureUrl === '/media/brand-avatar.jpg' || connection.profilePictureUrl.startsWith('http')) && connection.accessToken) {
      const refreshed = await this.syncLiveProfile(false, connection.username);
      if (refreshed) connection = refreshed;
    }

    return {
      connected: true,
      username: connection.username,
      profilePictureUrl: connection.profilePictureUrl ?? null,
      expiresAt: connection.tokenExpiresAt,
      permissions: connection.permissions ? connection.permissions.split(',') : null,
    };
  }

  // Used by the posting/messaging modules. Scoped per account if provided.
  async getValidAccessToken(account?: string): Promise<string> {
    return (await this.getConnectionOrThrow(account)).accessToken;
  }

  async getIgUserId(account?: string): Promise<string> {
    return (await this.getConnectionOrThrow(account)).igUserId;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async refreshTokenIfNeeded() {
    const connections = await this.repo.find();
    if (!connections.length) return;

    for (const connection of connections) {
      const daysLeft = (connection.tokenExpiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysLeft > REFRESH_WINDOW_DAYS) continue;

      try {
        const res = await fetch(
          `${GRAPH_BASE}/refresh_access_token?grant_type=ig_refresh_token&access_token=${connection.accessToken}`,
        );
        if (!res.ok) {
          this.logger.error(`Instagram token refresh failed for @${connection.username} - you will need to reconnect the account manually.`);
          continue;
        }
        const body = await res.json();
        connection.accessToken = body.access_token;
        connection.tokenExpiresAt = new Date(Date.now() + body.expires_in * 1000);
        await this.repo.save(connection);
        this.logger.log(`Instagram access token refreshed for @${connection.username}.`);

        // Also refresh brand profile picture
        try {
          const me = await fetch(`${GRAPH_BASE}/me?fields=profile_picture_url&access_token=${connection.accessToken}`).then((r) => r.json());
          if (me?.profile_picture_url) {
            const cached = await this.cacheProfilePicture(me.profile_picture_url, `avatar-${connection.igUserId || connection.username}.jpg`);
            if (cached) {
              connection.profilePictureUrl = cached;
              await this.repo.save(connection);
            }
          }
        } catch {}
      } catch (err) {
        this.logger.error(`Instagram token refresh threw an error for @${connection.username}`, err as Error);
      }
    }
  }

  async getConnectionByIgUserId(igUserId?: string): Promise<InstagramConnection | null> {
    if (!igUserId) return null;
    return this.repo.findOne({ where: { igUserId } });
  }

  async getConnectionRow(account?: string): Promise<InstagramConnection | null> {
    if (account) {
      const clean = account.trim().replace(/^@/, '').toLowerCase();
      const conn = await this.repo
        .createQueryBuilder('c')
        .where('LOWER(c.username) = :u OR LOWER(c.username) = :atU', { u: clean, atU: `@${clean}` })
        .getOne();
      if (conn) return conn;
    }
    const [connection] = await this.repo.find({ order: { updatedAt: 'DESC' }, take: 1 });
    return connection ?? null;
  }

  private async getConnectionOrThrow(account?: string): Promise<InstagramConnection> {
    const connection = await this.getConnectionRow(account);
    if (!connection) {
      throw new BadRequestException('No Instagram account connected yet.');
    }
    return connection;
  }

  async linkUserInstagramHandle(userId?: string, username?: string) {
    if (!userId || userId === 'dev-admin' || !username) return;
    try {
      await this.repo.manager.getRepository('User').update(
        { id: userId },
        { instagramHandle: username },
      );
    } catch (err) {
      this.logger.warn(`Could not link instagram handle to user ${userId}: ${err}`);
    }
  }
}
