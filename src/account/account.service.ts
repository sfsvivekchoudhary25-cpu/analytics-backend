import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { rlsStorage } from '../common/rls/rls.context';
import { UPLOAD_DIR } from '../submissions/paths';
import { AuditService } from '../common/audit/audit.service';

// Every table whose rows belong to ONE Instagram account (owner_username).
const OWNER_TABLES = [
  'auto_reply_rule',
  'auto_reply_setting',
  'comment',
  'comment_dm_log',
  'comment_dm_rule',
  'conversation',
  'message',
  'message_auto_log',
  'message_auto_rule',
  'message_auto_setting',
  'story',
  'submission',
  'voice_note',
  'saved_reels',
  'facebook_page_connection',
];

export type DeletionReport = Record<string, number>;

// A DELETE ... RETURNING comes back either as the rows or as [rows, count], depending on the driver version.
const countOf = (r: any): number => (Array.isArray(r) ? (Array.isArray(r[0]) ? r[0].length : r.length) : 0);

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * Permanently deletes one user and everything that belongs to them: their data in every table, their Instagram
   * and Facebook connections (tokens), their login, and the images we stored for them.
   * `handle` is the user's Instagram account; `email` covers data saved before they had one (it is the owner key then).
   */
  async deleteAccount(opts: { userId?: string | null; handle?: string | null; email?: string | null }): Promise<DeletionReport> {
    const clean = (v?: string | null) => String(v ?? '').trim().replace(/^@/, '').toLowerCase();
    const handle = clean(opts.handle);
    const owners = Array.from(new Set([handle, clean(opts.email)].filter(Boolean)));
    const report: DeletionReport = {};
    if (!owners.length && !opts.userId) return report;

    const files: string[] = [];
    // Deleting is a server task, so it runs outside any single tenant's row-level security.
    await rlsStorage.run({ bypass: true }, async () => {
      await this.dataSource.transaction(async (em) => {
        if (owners.length) {
          const stories = await em.query('SELECT file FROM story WHERE LOWER(owner_username) = ANY($1)', [owners]);
          const subs = await em.query('SELECT image_file FROM submission WHERE LOWER(owner_username) = ANY($1)', [owners]);
          for (const r of stories) if (r.file) files.push(String(r.file));
          for (const r of subs) if (r.image_file) files.push(String(r.image_file));
          for (const t of OWNER_TABLES) {
            report[t] = countOf(await em.query(`DELETE FROM "${t}" WHERE LOWER(owner_username) = ANY($1) RETURNING 1`, [owners]));
          }
        }
        if (handle) {
          report.instagram_connection = countOf(
            await em.query('DELETE FROM instagram_connection WHERE LOWER(username) = $1 RETURNING 1', [handle]),
          );
        }
        // The login itself, plus any duplicate login created for the same Instagram handle.
        report.app_users = countOf(
          await em.query(
            "DELETE FROM app_users WHERE ($1::uuid IS NOT NULL AND id = $1::uuid) OR ($2 <> '' AND LOWER(instagram_handle) = $2) RETURNING 1",
            [opts.userId ?? null, handle],
          ),
        );
      });
    });

    // Stored images are only removed once the database part has succeeded.
    for (const f of files) {
      const name = f.replace(/^.*[\\/]/, '');
      if (name) await unlink(join(UPLOAD_DIR, name)).catch(() => {});
    }
    this.logger.log(`Account deleted (${handle || opts.email || opts.userId}): ${JSON.stringify(report)}`);
    await this.audit
      .log({ actorId: opts.userId ?? undefined, actorEmail: opts.email ?? undefined, action: 'ACCOUNT_DELETED', targetResource: 'account', details: report })
      .catch(() => {});
    return report;
  }

  /** Meta told us the user removed the app: revoke access (delete the tokens) but keep their data. */
  async revokeConnectionsByInstagramId(igUserId: string): Promise<DeletionReport> {
    const report: DeletionReport = {};
    await rlsStorage.run({ bypass: true }, async () => {
      await this.dataSource.transaction(async (em) => {
        const conn = await em.query('SELECT username FROM instagram_connection WHERE ig_user_id = $1', [igUserId]);
        const owners = conn.map((c: any) => String(c.username).toLowerCase());
        report.instagram_connection = countOf(await em.query('DELETE FROM instagram_connection WHERE ig_user_id = $1 RETURNING 1', [igUserId]));
        report.facebook_page_connection = countOf(
          await em.query('DELETE FROM facebook_page_connection WHERE ig_user_id = $1 OR LOWER(owner_username) = ANY($2) RETURNING 1', [igUserId, owners]),
        );
      });
    });
    return report;
  }

  /** Meta data-deletion request: delete everything for the Instagram account with this app-scoped id. */
  async deleteByInstagramId(igUserId: string): Promise<DeletionReport> {
    let username: string | null = null;
    let user: { id: string; email: string } | null = null;
    await rlsStorage.run({ bypass: true }, async () => {
      const conn = await this.dataSource.query('SELECT username FROM instagram_connection WHERE ig_user_id = $1', [igUserId]);
      username = conn[0]?.username ? String(conn[0].username).toLowerCase() : null;
      if (username) {
        const u = await this.dataSource.query('SELECT id, email FROM app_users WHERE LOWER(instagram_handle) = $1 LIMIT 1', [username]);
        user = u[0] ?? null;
      }
    });
    if (!username) return {};
    const u = user as { id: string; email: string } | null;
    return this.deleteAccount({ userId: u?.id, handle: username, email: u?.email });
  }
}
