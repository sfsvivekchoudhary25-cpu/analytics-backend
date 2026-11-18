import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, IsNull, MoreThan, Repository } from 'typeorm';
import { GraphApiError, GraphClient } from '../instagram-connection/graph-client.service';
import { InstagramConnectionService } from '../instagram-connection/instagram-connection.service';
import { eventDate, messagingEvents } from '../instagram-webhook/events';
import { Conversation, Message } from './messaging.entities';
import { MessageButton } from '../facebook-page/facebook-page.service';
import { MessagePrivacyService } from './message-privacy.service';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // Meta Human Agent feature unlocks 7 days

export function generateLetterAvatar(nameOrId: string | null | undefined): string {
  const raw = String(nameOrId ?? '').replace(/^@/, '').trim();
  const isAllDigits = /^\d+$/.test(raw);
  const letter = (isAllDigits || !raw ? 'U' : raw[0]).toUpperCase();

  const colors = [
    '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899',
    '#f43f5e', '#ea580c', '#10b981', '#06b6d4',
  ];
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  const bg = colors[hash % colors.length];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">` +
    `<circle cx="50" cy="50" r="50" fill="${bg}"/>` +
    `<text x="50" y="55" font-size="44" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-weight="600" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${letter}</text>` +
    `</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// Buttons in the shape Instagram expects (title up to 20 characters, valid links only).
function formatButtons(buttons?: MessageButton[]) {
  if (!buttons?.length) return undefined;
  const safeUrl = (raw?: string | null): string => {
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
  return buttons.map((b) => ({
    type: b.type,
    title: (b.title || 'Click Here').slice(0, 20),
    ...(b.type === 'web_url' ? { url: safeUrl(b.url) } : { payload: b.payload || 'ACTION' }),
  }));
}

// Problems with the comment itself (not with the message format): trying a simpler format cannot help.
// 100/2534014 comment or user not found or already replied to, 100/2534025 older than 7 days, 4/17/32/613 rate limits.
export function isCommentLevelError(err: unknown): boolean {
  if (!(err instanceof GraphApiError)) return false;
  return (err.code === 100 && (err.subcode === 2534014 || err.subcode === 2534025)) || [4, 17, 32, 613].includes(Number(err.code));
}

@Injectable()
export class MessagingService implements OnModuleInit {
  private readonly logger = new Logger('Messaging');

  constructor(
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    private readonly graph: GraphClient,
    private readonly connection: InstagramConnectionService,
    private readonly privacy: MessagePrivacyService,
  ) {}

  onModuleInit() {
    // Run constraint and avatar maintenance in background so server listens immediately
    setTimeout(() => {
      this.maintainAvatarsAndConstraints().catch((e) => this.logger.warn(`Avatar maintenance note: ${e.message}`));
    }, 10000);
  }

  private async maintainAvatarsAndConstraints() {
    try {
      // Drop global unique constraint on mid so multiple tenants can store the same message mid without collision
      await this.messages.query(`
        ALTER TABLE message DROP CONSTRAINT IF EXISTS "UQ_70c82ca0811ee5dbe177c655115";
        ALTER TABLE message DROP CONSTRAINT IF EXISTS message_mid_key;
      `).catch(() => {});

      const rows = await this.conversations.find({ where: { profilePic: IsNull() }, take: 100 });
      let updated = 0;
      for (const c of rows) {
        if (!c.profilePic) {
          c.profilePic = generateLetterAvatar(c.username || c.igsid);
          await this.conversations.save(c);
          updated++;
        }
      }
      if (updated > 0) {
        this.logger.log(`Initialized first-letter avatars for ${updated} conversation(s) without profile pictures`);
      }
    } catch (e) {
      this.logger.warn(`Could not backfill avatars: ${(e as Error).message}`);
    }
  }

  // ---------- importing from Instagram (history + polling fallback) ----------

  // The automation tick (in AutoMessageService) calls syncFromInstagram() every 10s as its fallback path,
  // right before processing replies, so a message caught by polling is answered in the same pass, with no
  // separate timer to wait for. This class does not schedule its own sync.
  private syncing = false;
  // Instagram chat ids that could not be read, and until when we skip them.
  private readonly unreadableChats = new Map<string, number>();

  // Saves one message row. For an account that chose "Don't store my messages" only the metadata (who / when /
  // direction / id) is written; the text is kept in short-lived memory so automation can still answer it.
  // Private reply to a comment, sent with the account's own Instagram login (no Facebook Page needed):
  // POST /<IG_ID>/messages with recipient.comment_id. Tries the richest format first (card, buttons) and falls back
  // to simpler ones if Instagram rejects the format; stops at once for problems with the comment itself
  // (already replied to, older than 7 days, gone), because a simpler format cannot fix those.
  async sendPrivateReplyViaInstagram(
    commentId: string,
    text: string,
    buttons?: MessageButton[],
    card?: { title?: string; subtitle?: string; imageUrl?: string; buttons?: MessageButton[] },
    account?: string,
  ): Promise<{ recipientId: string; messageId: string }> {
    const own = (await this.resolveOwner(account)) ?? undefined;
    const igUserId = await this.connection.getIgUserId(own);
    const formatted = formatButtons(card?.buttons || buttons);
    const attempts: { label: string; message: any }[] = [];
    if (card && (card.imageUrl || card.title)) {
      const element: any = { title: (card.title || text).slice(0, 80), subtitle: (card.subtitle || text).slice(0, 80) };
      if (card.imageUrl) element.image_url = card.imageUrl;
      if (formatted?.length) element.buttons = formatted;
      attempts.push({ label: 'card', message: { attachment: { type: 'template', payload: { template_type: 'generic', elements: [element] } } } });
    }
    if (formatted?.length) {
      attempts.push({ label: 'buttons', message: { attachment: { type: 'template', payload: { template_type: 'button', text: text.slice(0, 640), buttons: formatted } } } });
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const title = (lines[0] || 'Hello').slice(0, 80);
      const subtitle = (lines.slice(1).join(' ') || title).slice(0, 80);
      attempts.push({ label: 'card-from-text', message: { attachment: { type: 'template', payload: { template_type: 'generic', elements: [{ title, subtitle, buttons: formatted }] } } } });
      attempts.push({
        label: 'quick-replies',
        message: { text, quick_replies: formatted.map((b: any) => ({ content_type: 'text', title: b.title.slice(0, 20), payload: b.type === 'postback' ? b.payload : b.url })) },
      });
    }
    attempts.push({ label: 'text', message: { text } });

    let lastError: unknown;
    for (const a of attempts) {
      try {
        const res = await this.graph.postJson(`/${igUserId}/messages`, { recipient: { comment_id: commentId }, message: a.message }, { account: own });
        if (res?.recipient_id) {
          this.logger.log(`Private reply sent through the Instagram login (${a.label}) for comment ${commentId}`);
          return { recipientId: String(res.recipient_id), messageId: String(res.message_id ?? '') };
        }
        lastError = new Error('Instagram accepted the request but returned no recipient.');
      } catch (err) {
        lastError = err;
        if (isCommentLevelError(err)) throw err; // a different format cannot fix this
        this.logger.warn(`Private reply format "${a.label}" was not accepted: ${(err as Error).message}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Private reply failed.');
  }

  // Saves one message. For an account that chose "Don't store my messages" NO row is written at all: the text goes to
  // short-lived memory only (so automation can answer it and the inbox preview works) and the few facts we need
  // (last inbound / outbound time and sender) are kept on the conversation row by touchConversation().
  private async saveMessage(
    noStore: boolean,
    data: Partial<Message> & { igsid: string; direction: 'in' | 'out' },
    opts: { enqueue?: boolean } = {},
  ): Promise<Message | null> {
    if (!noStore) return this.messages.save(this.messages.create(data));
    if (!data.ownerUsername) return null;
    const at = (data.createdAt ?? new Date()).getTime();
    const mid = data.mid ?? null;
    const text = String(data.text ?? '');
    this.privacy.remember(data.ownerUsername, data.igsid, { id: mid ?? `${data.direction}-${at}-${data.igsid}`, mid, direction: data.direction, text, at });
    if (data.direction === 'in' && mid && text && opts.enqueue !== false) {
      this.privacy.enqueueInbound({ id: mid, mid, owner: data.ownerUsername, igsid: data.igsid, text, at });
    }
    return null;
  }

  // Customer messages waiting for automation (accounts that don't store messages only).
  queuedInbound(owner?: string | null) {
    return this.privacy.queued(owner);
  }

  dequeueInbound(id: string) {
    this.privacy.dequeue(id);
  }

  // The last few remembered messages before a moment (the AI uses these as context when nothing is stored).
  recentChat(owner: string, igsid: string, beforeMs: number, n = 6) {
    return this.privacy.recent(owner, igsid).filter((m) => m.at < beforeMs).slice(-n);
  }

  // What automations need to know about a chat, without reading message rows when none are kept.
  async chatState(owner: string | null | undefined, igsid: string): Promise<{ lastDirection: 'in' | 'out' | null; lastInboundAt: Date | null; lastInboundText: string }> {
    const own = owner ? owner.trim().replace(/^@/, '').toLowerCase() : undefined;
    if (own && (await this.privacy.isNoStore(own))) {
      const c = await this.conversations.findOne({ where: { igsid, ownerUsername: own } });
      const inAt = c?.lastInboundAt ?? null;
      const outAt = c?.lastOutboundAt ?? null;
      const lastDirection = inAt && (!outAt || inAt >= outAt) ? 'in' : outAt ? 'out' : null;
      const lastIn = this.privacy.recent(own, igsid).filter((m) => m.direction === 'in').pop();
      return { lastDirection, lastInboundAt: inAt, lastInboundText: lastIn?.text ?? '' };
    }
    const where = (extra: object) => (own ? { igsid, ownerUsername: own, ...extra } : { igsid, ...extra });
    const last = await this.messages.findOne({ where: where({}), order: { createdAt: 'DESC' } });
    const lastIn = await this.messages.findOne({ where: where({ direction: 'in' as const }), order: { createdAt: 'DESC' } });
    return { lastDirection: last?.direction ?? null, lastInboundAt: lastIn?.createdAt ?? null, lastInboundText: lastIn?.text ?? '' };
  }

  // The first customer message after a moment (used to tell whether they replied to an automated DM).
  async firstInboundAfter(owner: string | null | undefined, igsid: string, after: Date): Promise<Date | null> {
    const own = owner ? owner.trim().replace(/^@/, '').toLowerCase() : undefined;
    if (own && (await this.privacy.isNoStore(own))) {
      const c = await this.conversations.findOne({ where: { igsid, ownerUsername: own } });
      return c?.lastInboundAt && c.lastInboundAt > after ? c.lastInboundAt : null;
    }
    const row = await this.messages.findOne({
      where: { ...(own ? { ownerUsername: own } : {}), igsid, direction: 'in', createdAt: MoreThan(after) },
      order: { createdAt: 'ASC' },
    });
    return row?.createdAt ?? null;
  }

  isNoStore(owner?: string | null) {
    return this.privacy.isNoStore(owner);
  }

  cachedText(id: string) {
    return this.privacy.textOf(id);
  }

  // The text an automation needs for a message whose text is not in the database.
  async textForAutomation(m: Message): Promise<string> {
    if (m.text) return m.text;
    const own = m.ownerUsername ?? undefined;
    if (!(await this.privacy.isNoStore(own))) return '';
    const cached = this.privacy.textOf(m.id);
    if (cached !== null) return cached;
    if (!m.mid) return '';
    // Not in memory (for example the server restarted): ask Instagram for just this one message.
    try {
      const d = await this.graph.get(`/${m.mid}`, { fields: 'message' }, { account: own });
      const text = String(d?.message ?? '');
      if (text && own) this.privacy.remember(own, m.igsid, { id: m.id, mid: m.mid, direction: 'in', text, at: m.createdAt.getTime() });
      return text;
    } catch {
      return '';
    }
  }

  async getPrivacy(account?: string) {
    const own = await this.resolveOwner(account);
    if (!own) return { connected: false, storeMessages: true };
    return { connected: true, storeMessages: !(await this.privacy.isNoStore(own)) };
  }

  async setPrivacy(account: string | undefined, storeMessages: boolean) {
    const own = await this.resolveOwner(account);
    if (!own) throw new BadRequestException('Connect your Instagram account first.');
    return { connected: true, ...(await this.privacy.setStoreMessages(own, !!storeMessages)) };
  }

  private async resolveOwner(ownerUsername?: string): Promise<string | null> {
    if (ownerUsername) return ownerUsername.trim().replace(/^@/, '').toLowerCase();
    const status: any = await this.connection.getStatus().catch(() => null);
    return status?.connected && status?.username ? String(status.username).trim().toLowerCase() : null;
  }

  // Reads conversations from Instagram and stores what we don't have yet. Safe to run repeatedly.
  async syncFromInstagram(ownerUsername?: string) {
    const zero = { conversations: 0, newMessages: 0 };
    if (this.syncing) return zero;
    const own = await this.resolveOwner(ownerUsername);
    const status: any = await this.connection.getStatus(own ?? undefined);
    if (!status.connected) return zero;
    this.syncing = true;
    try {
      const ownHandle = String(status.username).toLowerCase();
      const noStore = await this.privacy.isNoStore(ownHandle);
      const list = await this.graph.get(
        '/me/conversations',
        { platform: 'instagram', fields: 'id,updated_time,participants', limit: '50' },
        { account: ownHandle },
      );
      let conversations = 0;
      let newMessages = 0;
      for (const conv of list.data ?? []) {
        const other = (conv.participants?.data ?? []).find((p: any) => String(p.username ?? '').toLowerCase() !== ownHandle);
        if (!other?.id) continue;
        const existing = await this.conversations.findOne({ where: { igsid: String(other.id), ownerUsername: ownHandle } });
        const isRecent = new Date(conv.updated_time).getTime() > Date.now() - 2 * 24 * 3600_000;
        if (!isRecent && existing && existing.lastMessageAt >= new Date(conv.updated_time)) continue; // nothing new here

        // One chat Instagram will not let us read (deleted, blocked, or no permission: code 100/33) must not stop the
        // sync of every other chat. It is skipped, and not asked about again for an hour.
        const badUntil = this.unreadableChats.get(conv.id);
        if (badUntil && badUntil > Date.now()) continue;
        let detail: any;
        try {
          detail = await this.graph.get(`/${conv.id}`, { fields: 'messages.limit(50){id,created_time,from,message}' }, { account: ownHandle, silent: true });
        } catch (err) {
          if (err instanceof GraphApiError && err.code === 100) {
            this.unreadableChats.set(conv.id, Date.now() + 3600_000);
            this.logger.debug?.(`Skipping a chat Instagram will not let us read (@${ownHandle}): ${err.message}`);
            continue;
          }
          throw err;
        }
        const msgs: any[] = [...(detail.messages?.data ?? [])].reverse(); // oldest first
        let added = 0;
        let addedInbound = 0;
        let lastText = existing?.lastText ?? '';
        let lastAt = existing?.lastMessageAt ?? null;
        let lastInboundAt = existing?.lastInboundAt ?? null;
        let lastOutboundAt = existing?.lastOutboundAt ?? null;
        let lastOutboundSource = existing?.lastOutboundSource ?? null;

        for (const m of msgs) {
          const at = new Date(m.created_time);
          const outgoing = String(m.from?.username ?? '').toLowerCase() === ownHandle;
          const text = String(m.message ?? '');
          // History sync only returns the text. A message with no text is an attachment whose type we cannot know,
          // so it is not stored (real attachments with their type still arrive through the webhook).
          if (!text) continue;
          if (noStore) {
            // No message rows exist in this mode, so "already seen" means: handled by the webhook (the conversation's
            // last-message time is already at or past it) or remembered in memory.
            if (existing && at.getTime() <= existing.lastMessageAt.getTime() + 3000) continue;
            if (this.privacy.seenMid(ownHandle, m.id)) continue;
          } else {
            // The same message may already be stored via the webhook, possibly under a different id format.
            // (Message text is encrypted, so it cannot be compared in SQL: fetch the few rows around that moment and compare here.)
            const sameMoment = await this.messages.find({
              where: { igsid: String(other.id), ownerUsername: ownHandle, direction: outgoing ? 'out' : 'in', createdAt: Between(new Date(+at - 5000), new Date(+at + 5000)) },
            });
            const dup = (await this.messages.exists({ where: { mid: m.id, ownerUsername: ownHandle } })) || sameMoment.some((r) => r.text === text);
            if (dup) continue;
          }
          await this.saveMessage(noStore, {
            igsid: String(other.id),
            ownerUsername: ownHandle,
            direction: outgoing ? 'out' : 'in',
            text,
            // An outgoing message we did not send ourselves through this app was typed in the Instagram app.
            source: outgoing ? 'app' : null,
            attachmentType: null,
            attachmentUrl: null,
            mid: m.id,
            createdAt: at,
          }, { enqueue: !!existing }); // a first-time import of old history is never queued for automation
          added += 1;
          if (!outgoing) addedInbound += 1;
          if (!lastAt || at >= lastAt) {
            lastAt = at;
            lastText = noStore ? '' : text;
          }
          if (!outgoing && (!lastInboundAt || at > lastInboundAt)) lastInboundAt = at;
          if (outgoing && (!lastOutboundAt || at > lastOutboundAt)) {
            lastOutboundAt = at;
            lastOutboundSource = 'app';
          }
        }

        if (!existing || added) {
          let username = other.username ?? existing?.username ?? null;
          // Never import a conversation with own self
          if (username && username.toLowerCase() === ownHandle) continue;

          let profilePic = existing?.profilePic ?? null;
          if (!username || !profilePic) {
            const p = await this.graph.get(`/${other.id}`, { fields: 'username,profile_pic' }, { account: ownHandle }).catch(() => null);
            if (p?.username) username = p.username;
            if (p?.profile_pic) profilePic = p.profile_pic;
          }
          if (username && username.toLowerCase() === ownHandle) continue;

          if (!profilePic) {
            profilePic = generateLetterAvatar(username || String(other.id));
          }
          await this.conversations.save(
            this.conversations.create({
              igsid: String(other.id),
              ownerUsername: ownHandle,
              username,
              profilePic,
              lastText,
              lastMessageAt: lastAt ?? new Date(conv.updated_time),
              lastInboundAt,
              lastOutboundAt,
              lastOutboundSource,
              // A first-time import of old history is not "unread"; later messages are.
              unread: existing ? existing.unread + addedInbound : 0,
            }),
          );
          conversations += 1;
          newMessages += added;
        }
      }
      if (newMessages) this.logger.log(`Inbox sync (@${ownHandle}): ${newMessages} new message(s) in ${conversations} conversation(s)`);
      return { conversations, newMessages };
    } finally {
      this.syncing = false;
    }
  }

  // ---------- webhook ----------

  async handleWebhook(payload: any) {
    for (const { ownId, ev } of messagingEvents(payload)) {
      try {
        await this.recordEvent(ownId, ev);
      } catch (err) {
        this.logger.error(`Could not store message event: ${(err as Error).message}`);
      }
    }
  }

  // Store one messaging event (customer -> us, or an echo of something we sent from the app).
  async recordEvent(ownId: string, ev: any) {
    const conn = await this.connection.getConnectionByIgUserId(ownId).catch(() => null);
    const ownUsername = conn?.username?.toLowerCase() ?? null;
    const noStore = await this.privacy.isNoStore(ownUsername);

    // A customer edited a message we already stored.
    if (ev.message_edit?.mid) {
      if (noStore) {
        // No rows exist in this mode; only the short-lived in-memory copy is refreshed.
        if (ownUsername) this.privacy.updateTextByMid(ownUsername, ev.message_edit.mid, String(ev.message_edit.text ?? ''));
        this.logger.log(`A customer edited a message (edit #${ev.message_edit.num_edit ?? '?'})`);
        return;
      }
      const stored = await this.messages.findOne({ where: { mid: ev.message_edit.mid, ...(ownUsername ? { ownerUsername: ownUsername } : {}) } });
      if (!stored) {
        this.logger.log(`Edit of a message we never stored (...${String(ev.message_edit.mid).slice(-8)}); ignored`);
        return;
      }
      const newText = String(ev.message_edit.text ?? '');
      const before = stored.text;
      stored.text = newText;
      if (ownUsername && !stored.ownerUsername) stored.ownerUsername = ownUsername;
      await this.messages.save(stored);
      // Refresh the list preview only if this was the conversation's latest message (compared here, not in SQL).
      const conv = await this.conversations.findOne({ where: ownUsername ? { igsid: stored.igsid, ownerUsername: ownUsername } : { igsid: stored.igsid } });
      if (conv && conv.lastText === before) {
        conv.lastText = stored.text;
        await this.conversations.save(conv);
      }
      this.logger.log(`A customer edited a message (edit #${ev.message_edit.num_edit ?? '?'})`);
      return;
    }

    const msg = ev.message;
    if (!msg) {
      if (ev.postback) {
        const text = ev.postback.title || ev.postback.payload || "I'm following ✅";
        const customerId = ev.sender?.id;
        if (customerId && customerId !== ownId) {
          const at = eventDate(ev.timestamp);
          if (noStore && ownUsername && this.privacy.seenMid(ownUsername, ev.postback.mid)) return; // duplicate delivery
          await this.saveMessage(noStore, {
            igsid: customerId,
            ownerUsername: ownUsername,
            direction: 'in',
            text,
            source: null,
            attachmentType: null,
            attachmentUrl: null,
            mid: ev.postback.mid ?? null,
            createdAt: at,
          });
          await this.touchConversation(customerId, text, undefined, 'in', at, ownUsername ?? undefined, noStore);
        }
      }
      return; // reads, reactions, etc. are only logged, not stored
    }
    const echo = !!msg.is_echo;

    // Meta's own test message sent to our account: nothing to store, but say so.
    if (msg.is_self) {
      this.logger.log('Received Meta\'s self-test message (is_self). The webhook is working end to end.');
      return;
    }

    // The customer deleted a message: keep the thread, replace its content.
    if (msg.is_deleted && msg.mid) {
      if (noStore) return; // nothing is stored, so there is nothing to mark
      const stored = await this.messages.findOne({ where: { mid: msg.mid, ...(ownUsername ? { ownerUsername: ownUsername } : {}) } });
      if (stored) {
        stored.text = '[message deleted by sender]';
        stored.attachmentType = null;
        stored.attachmentUrl = null;
        await this.messages.save(stored);
        this.logger.log(`Marked a message as deleted (...${String(msg.mid).slice(-8)})`);
      }
      return;
    }

    const customerId: string | undefined = echo ? ev.recipient?.id : ev.sender?.id;
    if (!customerId || customerId === ownId) return;
    const duplicate = noStore
      ? !!ownUsername && this.privacy.seenMid(ownUsername, msg.mid) // no rows in this mode: remembered ids instead
      : !!msg.mid && (await this.messages.exists({ where: { mid: msg.mid, ...(ownUsername ? { ownerUsername: ownUsername } : {}) } }));
    if (duplicate) {
      this.logger.log(`Ignored duplicate delivery of message ...${String(msg.mid).slice(-8)}`);
      return;
    }

    const attachment = msg.attachments?.[0];
    const at = eventDate(ev.timestamp);
    // Give context to messages that have no text of their own.
    const label = msg.is_unsupported
      ? '[unsupported media, open it in the Instagram app]'
      : msg.reply_to?.story
        ? '[replied to your story]'
        : '';
    const text = [label, msg.text ?? ''].filter(Boolean).join(' ');
    await this.saveMessage(noStore, {
      igsid: customerId,
      ownerUsername: ownUsername,
      direction: echo ? 'out' : 'in',
      text,
      source: echo ? 'app' : null,
      attachmentType: attachment?.type ?? null,
      attachmentUrl: attachment?.payload?.url ?? null,
      mid: msg.mid ?? null,
      createdAt: at,
    });
    const c = await this.touchConversation(customerId, text, attachment?.type, echo ? 'out' : 'in', at, ownUsername ?? undefined, noStore, echo ? 'app' : undefined);
    this.logger.log(
      `Stored ${echo ? 'outgoing (from app)' : 'incoming'} message ${echo ? 'to' : 'from'} ${c.username ? '@' + c.username : customerId} (unread: ${c.unread})`,
    );
  }

  private async touchConversation(igsid: string, text: string, attachmentType: string | undefined, dir: 'in' | 'out', at: Date, ownerUsername?: string, noStore = false, source?: string) {
    const cleanOwner = ownerUsername ? ownerUsername.trim().replace(/^@/, '').toLowerCase() : null;
    let c = await this.conversations.findOne({
      where: cleanOwner ? { igsid, ownerUsername: cleanOwner } : { igsid },
    });
    if (!c) {
      c = this.conversations.create({ igsid, ownerUsername: cleanOwner, username: null, profilePic: null, unread: 0, lastInboundAt: null });
      const p = await this.graph.get(`/${igsid}`, { fields: 'username,profile_pic' }, { account: cleanOwner ?? undefined }).catch(() => null);
      if (p?.username) c.username = p.username;
      if (p?.profile_pic) c.profilePic = p.profile_pic;
      if (!c.profilePic) {
        c.profilePic = generateLetterAvatar(c.username || igsid);
      }
    } else {
      if (cleanOwner && !c.ownerUsername) c.ownerUsername = cleanOwner;
      if (!c.profilePic || !c.username) {
        const p = await this.graph.get(`/${igsid}`, { fields: 'username,profile_pic' }, { account: cleanOwner ?? undefined }).catch(() => null);
        if (p?.username) c.username = p.username;
        if (p?.profile_pic) c.profilePic = p.profile_pic;
        if (!c.profilePic) {
          c.profilePic = generateLetterAvatar(c.username || igsid);
        }
      }
    }
    // "Don't store" mode keeps no preview text in the database (an attachment label is not message content).
    c.lastText = noStore ? (attachmentType ? `[${attachmentType}]` : '') : text || (attachmentType ? `[${attachmentType}]` : '');
    c.lastMessageAt = at;
    if (dir === 'in') {
      c.lastInboundAt = at;
      c.unread += 1;
    } else {
      // Who last sent something here, and when: automation stays quiet after a person, even with no message rows.
      c.lastOutboundAt = at;
      c.lastOutboundSource = source ?? null;
    }
    return this.conversations.save(c);
  }

  // ---------- admin ----------

  async listConversations(ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    if (!own) return [];

    const qb = this.conversations.createQueryBuilder('c')
      .where('LOWER(c.ownerUsername) = :own', { own })
      .andWhere('(LOWER(c.username) != :own OR c.username IS NULL)', { own })
      .orderBy('c.lastMessageAt', 'DESC')
      .take(100);

    const rows = await qb.getMany();
    for (const c of rows) {
      if (!c.profilePic) {
        this.fetchContactProfile(c, own).catch(() => {});
      }
    }
    const noStore = await this.privacy.isNoStore(own);
    return rows.map((c) => this.view(c, noStore ? own : undefined));
  }

  // Reads one chat live from Instagram (used when message text is not stored). Kept for a few seconds so the
  // inbox's regular refresh does not hammer Instagram's rate limit.
  private readonly liveThreads = new Map<string, { at: number; messages: any[] }>();

  private async liveThread(own: string, c: Conversation): Promise<{ messages: any[]; live: boolean }> {
    const key = `${own}|${c.igsid}`;
    const hit = this.liveThreads.get(key);
    if (hit && Date.now() - hit.at < 20_000) return { messages: hit.messages, live: true };
    try {
      let convId: string | undefined;
      const byUser = await this.graph
        .get('/me/conversations', { platform: 'instagram', user_id: c.igsid, fields: 'id' }, { account: own })
        .catch(() => null);
      convId = byUser?.data?.[0]?.id;
      if (!convId) {
        const all = await this.graph.get('/me/conversations', { platform: 'instagram', fields: 'id,participants', limit: '50' }, { account: own });
        convId = (all.data ?? []).find((x: any) => (x.participants?.data ?? []).some((p: any) => String(p.id) === c.igsid))?.id;
      }
      if (!convId) throw new Error('conversation not found on Instagram');
      const detail = await this.graph.get(`/${convId}`, { fields: 'messages.limit(50){id,created_time,from,message}' }, { account: own });
      const messages = [...(detail.messages?.data ?? [])].reverse().map((m: any) => {
        const outgoing = String(m.from?.username ?? '').toLowerCase() === own;
        return {
          id: m.id,
          igsid: c.igsid,
          ownerUsername: own,
          direction: outgoing ? 'out' : 'in',
          text: String(m.message ?? '') || '[media]',
          attachmentType: null,
          attachmentUrl: null,
          // Messages sent from this app are remembered for a while; anything else outgoing was typed in Instagram.
          source: this.privacy.sourceOf(own, m.id) ?? (outgoing ? 'app' : null),
          mid: m.id,
          createdAt: new Date(m.created_time),
        };
      });
      this.liveThreads.set(key, { at: Date.now(), messages });
      return { messages, live: true };
    } catch (err) {
      this.logger.warn(`Could not read a chat live from Instagram: ${(err as Error).message}`);
      // Fall back to whatever the server still remembers in memory (never from the database).
      const memory = this.privacy.recent(own, c.igsid).map((m) => ({
        id: m.id, igsid: c.igsid, ownerUsername: own, direction: m.direction, text: m.text, attachmentType: null, attachmentUrl: null, source: null, mid: m.mid, createdAt: new Date(m.at),
      }));
      return { messages: memory, live: false };
    }
  }

  async thread(igsid: string, ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    if (!own) throw new NotFoundException('Conversation not found.');

    const c = await this.conversations.findOne({
      where: { igsid, ownerUsername: own },
    });
    if (!c) throw new NotFoundException('Conversation not found.');

    if (!c.profilePic) {
      await this.fetchContactProfile(c, own).catch(() => {});
    }
    const noStore = await this.privacy.isNoStore(own);
    let messages: any[];
    let live: boolean | undefined;
    if (noStore) {
      const r = await this.liveThread(own, c);
      messages = r.messages;
      live = r.live;
    } else {
      const recent = await this.messages.find({
        where: { igsid, ownerUsername: own },
        order: { createdAt: 'DESC' },
        take: 300,
      });
      messages = recent.reverse();
    }
    if (c.unread) {
      c.unread = 0;
      await this.conversations.save(c);
    }
    return { conversation: this.view(c, noStore ? own : undefined), messages, ...(noStore ? { notStored: true, live } : {}) };
  }

  private async fetchContactProfile(c: Conversation, account?: string) {
    try {
      const p = await this.graph.get(`/${c.igsid}`, { fields: 'username,profile_pic' }, { account });
      let changed = false;
      if (p?.username && p.username !== c.username) {
        c.username = p.username;
        changed = true;
      }
      if (p?.profile_pic && p.profile_pic !== c.profilePic) {
        c.profilePic = p.profile_pic;
        changed = true;
      } else if (!c.profilePic) {
        c.profilePic = generateLetterAvatar(c.username || c.igsid);
        changed = true;
      }
      if (changed) {
        await this.conversations.save(c);
      }
    } catch {
      // If fetching fails (e.g. code 230 - user consent required), fallback to first letter as profile picture
      // so we don't query repeatedly on every 3-second poll.
      if (!c.profilePic) {
        c.profilePic = generateLetterAvatar(c.username || c.igsid);
        await this.conversations.save(c).catch(() => {});
      }
    }
  }

  // Removes the conversation and its messages from this dashboard only; nothing is deleted on Instagram.
  async deleteConversation(igsid: string, ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    const c = await this.getConversation(igsid, own ?? undefined);
    if (own) {
      const { affected } = await this.messages.delete({ igsid, ownerUsername: own });
      await this.conversations.delete({ igsid, ownerUsername: own });
      this.privacy.forgetChat(own, igsid);
      this.liveThreads.delete(`${own}|${igsid}`);
      this.logger.log(`Deleted conversation (@${own}) with ${c.username ? '@' + c.username : igsid} (${affected ?? 0} messages)`);
      return { ok: true, deletedMessages: affected ?? 0 };
    }
    const { affected } = await this.messages.delete({ igsid });
    await this.conversations.delete({ igsid });
    this.logger.log(`Deleted conversation with ${c.username ? '@' + c.username : igsid} (${affected ?? 0} messages)`);
    return { ok: true, deletedMessages: affected ?? 0 };
  }

  async reply(igsid: string, rawText: string, ownerUsername?: string) {
    const text = String(rawText ?? '').trim();
    if (!text) throw new BadRequestException('Message is empty.');
    if (text.length > 1000) throw new BadRequestException('Message is too long (1000 characters max).');
    const own = await this.resolveOwner(ownerUsername);
    const c = await this.getConversation(igsid, own ?? undefined);
    if (!this.canReply(c)) {
      this.logger.warn(`Reply to ${c.username ? '@' + c.username : igsid} blocked: outside Instagram's 24-hour window`);
      throw new BadRequestException('More than 24 hours have passed since this customer last messaged you, so Instagram will not deliver a reply.');
    }
    try {
      return await this.send(igsid, text, 'dashboard', undefined, undefined, own ?? undefined);
    } catch (err) {
      this.logger.warn(`Reply to ${c.username ? '@' + c.username : igsid} FAILED: ${(err as Error).message}`);
      // Surface Instagram's own reason instead of a bare 500.
      throw new BadGatewayException(`Instagram could not send the message: ${(err as Error).message}`);
    }
  }

  // Send a DM and record it in the thread. `source` says who sent it, so automation can tell a person from itself.
  async send(
    igsid: string,
    text: string,
    source: 'dashboard' | 'auto' | 'system' = 'dashboard',
    buttons?: MessageButton[],
    card?: { title?: string; subtitle?: string; imageUrl?: string; buttons?: MessageButton[] },
    ownerUsername?: string,
  ) {
    const own = await this.resolveOwner(ownerUsername);
    const igUserId = await this.connection.getIgUserId(own ?? undefined);
    let res: any;

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

    let sentFormat = 'text';

    // 1. Generic card template (product card, downloadable file, or media template)
    if (card && (card.imageUrl || card.title)) {
      try {
        const element: any = {
          title: (card.title || text).slice(0, 80),
          subtitle: (card.subtitle || text).slice(0, 80),
        };
        if (card.imageUrl) element.image_url = card.imageUrl;
        if (formattedButtons && formattedButtons.length > 0) element.buttons = formattedButtons;

        res = await this.graph.postJson(
          `/${igUserId}/messages`,
          {
            recipient: { id: igsid },
            message: {
              attachment: {
                type: 'template',
                payload: {
                  template_type: 'generic',
                  elements: [element],
                },
              },
            },
          },
          { account: own ?? undefined },
        );
        if (res?.message_id) sentFormat = 'generic_card';
      } catch (err) {
        this.logger.warn(`Messaging generic card template failed: ${(err as Error).message}`);
      }
    }

    // 2. Button template (text with up to 3 action buttons)
    if (!res?.message_id && formattedButtons && formattedButtons.length > 0) {
      try {
        res = await this.graph.postJson(
          `/${igUserId}/messages`,
          {
            recipient: { id: igsid },
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
          },
          { account: own ?? undefined },
        );
        if (res?.message_id) sentFormat = 'button_template';
      } catch (err) {
        this.logger.warn(`Messaging button template failed: ${(err as Error).message}`);
      }
    }

    if (!res?.message_id) {
      const conv = await this.conversations.findOne({
        where: own ? { igsid, ownerUsername: own } : { igsid },
      });
      const isPast24h = conv?.lastInboundAt && (Date.now() - conv.lastInboundAt.getTime() > WINDOW_MS);
      const isWithin7Days = conv?.lastInboundAt && (Date.now() - conv.lastInboundAt.getTime() < HUMAN_AGENT_WINDOW_MS);

      const payload: any = {
        recipient: { id: igsid },
        message: { text },
      };

      // If sending from dashboard beyond 24h, use Meta's HUMAN_AGENT tag
      if (isPast24h && isWithin7Days && source === 'dashboard') {
        payload.tag = 'HUMAN_AGENT';
      }

      try {
        res = await this.graph.postJson(`/${igUserId}/messages`, payload, { account: own ?? undefined });
      } catch (err) {
        // Fallback retry with HUMAN_AGENT tag if standard 24h send was rejected
        if (!payload.tag && source === 'dashboard' && isWithin7Days) {
          try {
            payload.tag = 'HUMAN_AGENT';
            res = await this.graph.postJson(`/${igUserId}/messages`, payload, { account: own ?? undefined });
            this.logger.log(`[Messaging] Standard send failed; recovered via HUMAN_AGENT tag for ${igsid}`);
          } catch {
            throw err;
          }
        } else {
          throw err;
        }
      }
    }
    const now = new Date();
    const noStore = await this.privacy.isNoStore(own);
    // Instagram echoes our own DMs back through the webhook. Remember this id as ours so the echo is not mistaken for
    // a message typed in the Instagram app (in "don't store" mode there are no rows to check instead).
    if (noStore && own) this.privacy.markSent(own, res?.message_id, source);
    // If the echo already stored this mid, don't insert twice.
    const alreadyStored = !noStore && res?.message_id && (await this.messages.exists({ where: { mid: res.message_id, ...(own ? { ownerUsername: own } : {}) } }));
    if (!alreadyStored) {
      await this.saveMessage(noStore, {
        igsid,
        ownerUsername: own ?? null,
        direction: 'out',
        text,
        source,
        attachmentType: null,
        attachmentUrl: null,
        mid: res?.message_id ?? null,
        createdAt: now,
      });
    } else {
      // The webhook echo won the race and labelled it as typed in the app; set the true sender.
      await this.messages.update({ mid: res.message_id, ...(own ? { ownerUsername: own } : {}) }, { source, ...(own ? { ownerUsername: own } : {}) });
    }
    const c = await this.touchConversation(igsid, text, undefined, 'out', now, own ?? undefined, noStore, source);
    this.logger.log(`[Messaging] DM sent (${sentFormat}) to ${c.username ? '@' + c.username : igsid} (${text.length} characters)`);
    return { ok: true };
  }

  private async getConversation(igsid: string, ownerUsername?: string) {
    const c = await this.conversations.findOne({
      where: ownerUsername ? { igsid, ownerUsername } : { igsid },
    });
    if (!c) throw new NotFoundException('Conversation not found.');
    return c;
  }

  private canReply(c: Conversation) {
    // Allows reply within 7 days if Human Agent feature is enabled for dashboard replies
    return !!c.lastInboundAt && Date.now() - c.lastInboundAt.getTime() < HUMAN_AGENT_WINDOW_MS;
  }

  // `noStoreOwner` is set for accounts that don't store message text: the preview then comes from short-lived memory.
  private view(c: Conversation, noStoreOwner?: string) {
    const lastText = noStoreOwner ? this.privacy.lastText(noStoreOwner, c.igsid) ?? (c.lastText || 'Open to read this message') : c.lastText;
    return {
      igsid: c.igsid,
      username: c.username,
      profilePic: c.profilePic ?? null,
      lastText,
      lastMessageAt: c.lastMessageAt,
      unread: c.unread,
      canReply: this.canReply(c),
      replyUntil: c.lastInboundAt ? new Date(c.lastInboundAt.getTime() + WINDOW_MS) : null,
    };
  }
}
