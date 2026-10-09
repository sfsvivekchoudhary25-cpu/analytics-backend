import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GraphApiError } from '../instagram-connection/graph-client.service';
import { FacebookPageConnection } from './facebook-page.entity';

const FB_API = 'https://graph.facebook.com/v21.0';

export type MessageButton =
  | { type: 'web_url'; title: string; url: string }
  | { type: 'postback'; title: string; payload: string };

@Injectable()
export class FacebookPageService {
  private readonly logger = new Logger(FacebookPageService.name);

  constructor(@InjectRepository(FacebookPageConnection) private readonly repo: Repository<FacebookPageConnection>) {}

  // For a System User access token generated directly in Meta Business Suite (Business Settings > Users >
  // System Users > Generate New Token) — sidesteps the OAuth consent dialog entirely, which is more reliable
  // for a token that isn't tied to a browser login flow in the first place.
  //
  // A System User token is NOT itself a Page token: /me on it resolves to the system user's own identity
  // (confirmed directly — it has no `instagram_business_account` field and isn't a Page). The real Page token
  // has to be read off /me/accounts, same as the OAuth flow does for a personal login token.
  async connectWithToken(pastedToken: string) {
    const token = pastedToken.trim();
    if (!token) throw new BadRequestException('Paste the access token first.');

    const accountsRes = await fetch(
      `${FB_API}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${encodeURIComponent(token)}`,
    );
    const accountsBody = await accountsRes.json();
    let result: { pageName: string };
    if (accountsRes.ok && Array.isArray(accountsBody.data) && accountsBody.data.length > 0) {
      const pages = accountsBody.data as { id: string; name: string; access_token: string; instagram_business_account?: { id: string } }[];
      const chosen = pages.length === 1 ? pages[0] : pages.find((p) => p.instagram_business_account) ?? pages[0];
      result = await this.connect(chosen.id, chosen.name, chosen.access_token, chosen.instagram_business_account?.id ?? null);
    } else {
      // Fall back to treating the pasted value as a Page token directly (e.g. someone pasted a Page token, not
      // a System User/personal token).
      const meRes = await fetch(`${FB_API}/me?fields=id,name,instagram_business_account&access_token=${encodeURIComponent(token)}`);
      const meBody = await meRes.json();
      if (!meRes.ok) throw new BadRequestException(meBody?.error?.message ?? accountsBody?.error?.message ?? 'Facebook rejected that token.');
      if (!meBody.id || !meBody.name) throw new BadRequestException('That token did not resolve to a Facebook Page.');
      result = await this.connect(meBody.id, meBody.name, token, meBody.instagram_business_account?.id ?? null);
    }

    // Automatically query Meta for all live granted permissions on this token and sync them
    try {
      const permsRes = await fetch(`${FB_API}/me/permissions?access_token=${encodeURIComponent(token)}`);
      const permsBody = await permsRes.json();
      if (permsRes.ok && Array.isArray(permsBody.data)) {
        const granted = permsBody.data
          .filter((p: any) => p.status === 'granted')
          .map((p: any) => p.permission);
        if (granted.length > 0) {
          await this.syncPermissionsToInstagramConnection(granted);
        }
      }
    } catch (err) {
      this.logger.warn(`Could not sync live permissions from Meta: ${err}`);
    }

    return result;
  }

  private async syncPermissionsToInstagramConnection(granted: string[]) {
    try {
      const igRepo = this.repo.manager.getRepository('InstagramConnection');
      const [igConn] = (await igRepo.find({ take: 1 })) as any;
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

  async connect(pageId: string, pageName: string, pageAccessToken: string, igUserId: string | null) {
    const row = (await this.getRow()) ?? this.repo.create();
    row.pageId = pageId;
    row.pageName = pageName;
    row.pageAccessToken = pageAccessToken;
    row.igUserId = igUserId;
    await this.repo.save(row);
    return { pageName };
  }

  async disconnect() {
    const row = await this.getRow();
    if (row) await this.repo.remove(row);
    return { ok: true };
  }

  async getStatus() {
    const row = await this.getRow();
    if (!row) return { connected: false as const };
    return { connected: true as const, pageId: row.pageId, pageName: row.pageName, igUserId: row.igUserId };
  }

  async getPageAccessToken(): Promise<string> {
    const row = await this.getRow();
    if (!row) throw new BadRequestException('No Facebook Page connected.');
    return row.pageAccessToken;
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
  ): Promise<{ recipientId: string; messageId: string }> {
    const row = await this.getRow();
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

  private async getRow(): Promise<FacebookPageConnection | null> {
    const [row] = await this.repo.find({ take: 1 });
    return row ?? null;
  }
}
