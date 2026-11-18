import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GraphApiError } from '../instagram-connection/graph-client.service';
import { FacebookPageConnection } from './facebook-page.entity';
import { NO_ACCOUNT } from '../common/current-account.decorator';

const FB_API = 'https://graph.facebook.com/v21.0';

export type MessageButton =
  | { type: 'web_url'; title: string; url: string }
  | { type: 'postback'; title: string; payload: string };

@Injectable()
export class FacebookPageService {
  private readonly logger = new Logger(FacebookPageService.name);

  constructor(@InjectRepository(FacebookPageConnection) private readonly repo: Repository<FacebookPageConnection>) {}

  // Only ever touches the Instagram connection of the given account, never "whichever row comes first".
  async syncPermissionsToInstagramConnection(granted: string[], account?: string) {
    const owner = this.cleanAccount(account);
    if (!owner) return;
    try {
      const igRepo = this.repo.manager.getRepository('InstagramConnection');
      const igConn = (await igRepo
        .createQueryBuilder('c')
        .where('LOWER(c.username) = :u', { u: owner })
        .getOne()) as any;
      if (igConn) {
        const existing = (igConn.permissions ? igConn.permissions.split(',') : []).map((s: string) => s.trim());
        const combined = Array.from(new Set([...existing, ...granted])).filter(Boolean);
        igConn.permissions = combined.join(',');
        await igRepo.save(igConn);
        this.logger.log(`Auto-synced ${combined.length} permissions to Instagram connection: ${igConn.permissions}`);
      }
    } catch (e) {
      this.logger.warn(`Failed to auto-sync permissions to Instagram connection: ${e}`);
    }
  }

  // "fbUsername" is the Instagram handle Meta reports for this Page's linked Instagram account. It decides who
  // owns the row, so the Page can only ever be tied to the Instagram account it is actually linked to.
  // "expected" is the account the signed-in user already owns (if any): a mismatch is refused.
  async connect(
    pageId: string,
    pageName: string,
    pageAccessToken: string,
    igUserId: string | null,
    fbUsername: string | null,
    expected?: string,
  ) {
    const owner = this.cleanAccount(fbUsername) || expected || '';
    if (!owner) {
      throw new BadRequestException('This Facebook Page has no Instagram professional account linked, so it cannot be tied to your account. Link one in Meta Business Suite first.');
    }
    if (expected && owner !== expected) {
      throw new BadRequestException(`That Page is linked to @${owner}, but your account is @${expected}. Connect the Page that belongs to @${expected}.`);
    }
    const taken = await this.repo
      .createQueryBuilder('f')
      .where('f.page_id = :p AND (f.owner_username IS NULL OR LOWER(f.owner_username) <> :o)', { p: pageId, o: owner })
      .getOne();
    if (taken) {
      throw new BadRequestException('That Facebook Page is already connected to a different account.');
    }
    const row = (await this.getRow(owner)) ?? this.repo.create();
    row.ownerUsername = owner;
    row.pageId = pageId;
    row.pageName = pageName;
    row.pageAccessToken = pageAccessToken;
    row.igUserId = igUserId;
    await this.repo.save(row);
    return { pageName, ownerUsername: owner };
  }

  async disconnect(account?: string) {
    const row = await this.getRow(account);
    if (row) await this.repo.remove(row);
    return { ok: true };
  }

  async getStatus(account?: string) {
    const row = await this.getRow(account);
    if (!row) return { connected: false as const };
    return { connected: true as const, pageId: row.pageId, pageName: row.pageName, igUserId: row.igUserId };
  }

  async getPageAccessToken(account?: string): Promise<string> {
    const row = await this.getRow(account);
    if (!row) throw new BadRequestException('No Facebook Page connected.');
    return row.pageAccessToken;
  }

  /** Lower-cases/strips an account name. Empty for "no account" so lookups match nothing. */
  private cleanAccount(account?: string | null): string {
    const a = String(account ?? '').trim().replace(/^@/, '').toLowerCase();
    return a === NO_ACCOUNT ? '' : a;
  }

  // Meta's actual "private reply to a comment" mechanism: not a dedicated endpoint, but the Page's own
  // /messages send API with the comment's ID as the recipient instead of a user ID. Confirmed directly
  // against Facebook's API — this works with the same permissions already on the Page token (no
  // pages_messaging needed), unlike the non-existent `/{comment-id}/private_replies` path tried earlier.
  async sendPrivateReply(
    commentId: string,
    text: string,
    buttons?: MessageButton[],
    card?: { title?: string; subtitle?: string; imageUrl?: string; buttons?: MessageButton[] },
    account?: string,
  ): Promise<{ recipientId: string; messageId: string }> {
    const row = await this.getRow(account);
    if (!row) throw new BadRequestException('No Facebook Page connected.');

    const sanitizeUrl = (raw?: string | null): string => {
      let u = (raw || '').trim();
      if (!u || u === 'https://' || u === 'http://') return 'https://www.instagram.com';
      if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://' + u;
      try {
        const parsed = new URL(u);
        return parsed.hostname && parsed.hostname.includes('.') ? parsed.toString() : 'https://www.instagram.com';
      } catch {
        return 'https://www.instagram.com';
      }
    };

    const allButtons = card?.buttons || buttons;
    const formattedButtons = (allButtons && allButtons.length > 0)
      ? allButtons.map((b) => ({
          type: b.type,
          title: (b.title || 'Click Here').slice(0, 20),
          ...(b.type === 'web_url' ? { url: sanitizeUrl(b.url) } : { payload: b.payload || 'ACTION' }),
        }))
      : undefined;

    // 1. If card template is requested (product, downloadable file, or media card with image/title)
    if (card && (card.imageUrl || card.title)) {
      try {
        const element: any = {
          title: (card.title || text).slice(0, 80),
          subtitle: (card.subtitle || text).slice(0, 80),
        };
        if (card.imageUrl) element.image_url = card.imageUrl;
        if (formattedButtons && formattedButtons.length > 0) element.buttons = formattedButtons;

        const res = await fetch(`${FB_API}/${row.pageId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { comment_id: commentId },
            message: {
              attachment: {
                type: 'template',
                payload: {
                  template_type: 'generic',
                  elements: [element],
                },
              },
            },
            access_token: row.pageAccessToken,
          }),
        });
        const body = await res.json();
        if (res.ok && body.recipient_id) {
          this.logger.log(`Private reply sent using generic card template for comment ${commentId}`);
          return { recipientId: body.recipient_id, messageId: body.message_id };
        }
        this.logger.warn(`Card template attempt returned ${res.status}: ${JSON.stringify(body?.error || body)}`);
      } catch (err) {
        this.logger.warn(`Card template threw error: ${(err as Error).message}`);
      }
    }

    // 2. Button template (single message bubble with buttons at bottom)
    if (formattedButtons && formattedButtons.length > 0) {
      try {
        const res = await fetch(`${FB_API}/${row.pageId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { comment_id: commentId },
            message: {
              attachment: {
                type: 'template',
                payload: {
                  template_type: 'button',
                  text: text.slice(0, 640),
                  buttons: formattedButtons,
                },
              },
            },
            access_token: row.pageAccessToken,
          }),
        });
        const body = await res.json();
        if (res.ok && body.recipient_id) {
          this.logger.log(`Private reply sent using button template for comment ${commentId}`);
          return { recipientId: body.recipient_id, messageId: body.message_id };
        }
        this.logger.warn(`Button template attempt returned ${res.status}: ${JSON.stringify(body?.error || body)}`);
      } catch (err) {
        this.logger.warn(`Button template threw error: ${(err as Error).message}`);
      }

      // 3. Generic template fallback without image
      try {
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        const title = (lines[0] || 'Special Offer').slice(0, 80);
        const subtitle = (lines.slice(1).join(' ') || title).slice(0, 80);
        const res = await fetch(`${FB_API}/${row.pageId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { comment_id: commentId },
            message: {
              attachment: {
                type: 'template',
                payload: {
                  template_type: 'generic',
                  elements: [
                    {
                      title,
                      subtitle,
                      buttons: formattedButtons,
                    },
                  ],
                },
              },
            },
            access_token: row.pageAccessToken,
          }),
        });
        const body = await res.json();
        if (res.ok && body.recipient_id) {
          this.logger.log(`Private reply sent using generic template for comment ${commentId}`);
          return { recipientId: body.recipient_id, messageId: body.message_id };
        }
        this.logger.warn(`Generic template attempt returned ${res.status}: ${JSON.stringify(body?.error || body)}`);
      } catch (err) {
        this.logger.warn(`Generic template threw error: ${(err as Error).message}`);
      }

      // 3. Quick replies
      try {
        const quickReplies = formattedButtons.map((b: any) => ({
          content_type: 'text',
          title: b.title.slice(0, 20),
          payload: b.type === 'postback' ? b.payload : b.url,
        }));
        const res = await fetch(`${FB_API}/${row.pageId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { comment_id: commentId },
            message: {
              text,
              quick_replies: quickReplies,
            },
            access_token: row.pageAccessToken,
          }),
        });
        const body = await res.json();
        if (res.ok && body.recipient_id) {
          this.logger.log(`Private reply sent using quick replies for comment ${commentId}`);
          return { recipientId: body.recipient_id, messageId: body.message_id };
        }
        this.logger.warn(`Quick replies attempt returned ${res.status}: ${JSON.stringify(body?.error || body)}`);
      } catch (err) {
        this.logger.warn(`Quick replies threw error: ${(err as Error).message}`);
      }
    }

    // Fallback: plain text private reply
    const res = await fetch(`${FB_API}/${row.pageId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text }, access_token: row.pageAccessToken }),
    });
    const body = await res.json();
    if (!res.ok) {
      const e = body?.error;
      throw new GraphApiError(e?.error_user_msg ?? e?.message ?? `Facebook error ${res.status}`, e?.code, e?.error_subcode);
    }
    return { recipientId: body.recipient_id, messageId: body.message_id };
  }

  // The Page of ONE account. There is deliberately no "first row" fallback: a missing account means no Page.
  private async getRow(account?: string): Promise<FacebookPageConnection | null> {
    const owner = this.cleanAccount(account);
    if (!owner) return null;
    return this.repo.createQueryBuilder('f').where('LOWER(f.owner_username) = :o', { o: owner }).getOne();
  }

  /** Number of connected Pages (for the startup log only). */
  async countConnected(): Promise<number> {
    return this.repo.count();
  }
}
