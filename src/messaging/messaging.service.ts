import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, IsNull, Repository } from 'typeorm';
import { GraphClient } from '../instagram-connection/graph-client.service';
import { InstagramConnectionService } from '../instagram-connection/instagram-connection.service';
import { eventDate, messagingEvents } from '../instagram-webhook/events';
import { Conversation, Message } from './messaging.entities';
import { MessageButton } from '../facebook-page/facebook-page.service';

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

@Injectable()
export class MessagingService implements OnModuleInit {
  private readonly logger = new Logger('Messaging');

  constructor(
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    private readonly graph: GraphClient,
    private readonly connection: InstagramConnectionService,
  ) {}

  async onModuleInit() {
    try {
      // Drop global unique constraint on mid so multiple tenants can store the same message mid without collision
      await this.messages.query(`
        ALTER TABLE message DROP CONSTRAINT IF EXISTS "UQ_70c82ca0811ee5dbe177c655115";
        ALTER TABLE message DROP CONSTRAINT IF EXISTS message_mid_key;
      `).catch(() => {});

      const rows = await this.conversations.find();
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
        if (existing && existing.lastMessageAt >= new Date(conv.updated_time)) continue; // nothing new here

        const detail = await this.graph.get(`/${conv.id}`, { fields: 'messages.limit(50){id,created_time,from,message}' }, { account: ownHandle });
        const msgs: any[] = [...(detail.messages?.data ?? [])].reverse(); // oldest first
        let added = 0;
        let addedInbound = 0;
        let lastText = existing?.lastText ?? '';
        let lastAt = existing?.lastMessageAt ?? null;
        let lastInboundAt = existing?.lastInboundAt ?? null;

        for (const m of msgs) {
          const at = new Date(m.created_time);
          const outgoing = String(m.from?.username ?? '').toLowerCase() === ownHandle;
          const text = String(m.message ?? '');
          // The same message may already be stored via the webhook, possibly under a different id format.
          const dup =
            (await this.messages.exists({ where: { mid: m.id, ownerUsername: ownHandle } })) ||
            (await this.messages.exists({
              where: { igsid: String(other.id), ownerUsername: ownHandle, direction: outgoing ? 'out' : 'in', text, createdAt: Between(new Date(+at - 5000), new Date(+at + 5000)) },
            }));
          if (dup) continue;
          await this.messages.save(
            this.messages.create({
              igsid: String(other.id),
              ownerUsername: ownHandle,
              direction: outgoing ? 'out' : 'in',
              text,
              // An outgoing message we did not send ourselves through this app was typed in the Instagram app.
              source: outgoing ? 'app' : null,
              attachmentType: text ? null : 'attachment',
              attachmentUrl: null,
              mid: m.id,
              createdAt: at,
            }),
          );
          added += 1;
          if (!outgoing) addedInbound += 1;
          if (!lastAt || at >= lastAt) {
            lastAt = at;
            lastText = text || '[attachment]';
          }
          if (!outgoing && (!lastInboundAt || at > lastInboundAt)) lastInboundAt = at;
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

    // A customer edited a message we already stored.
    if (ev.message_edit?.mid) {
      const stored = await this.messages.findOne({ where: { mid: ev.message_edit.mid, ...(ownUsername ? { ownerUsername: ownUsername } : {}) } });
      if (!stored) {
        this.logger.log(`Edit of a message we never stored (...${String(ev.message_edit.mid).slice(-8)}); ignored`);
        return;
      }
      const before = stored.text;
      stored.text = String(ev.message_edit.text ?? '');
      if (ownUsername && !stored.ownerUsername) stored.ownerUsername = ownUsername;
      await this.messages.save(stored);
      // Refresh the list preview only if this was the conversation's latest message.
      await this.conversations.update(
        ownUsername ? { igsid: stored.igsid, lastText: before, ownerUsername: ownUsername } : { igsid: stored.igsid, lastText: before },
        { lastText: stored.text },
      );
      this.logger.log(`Updated message to "${stored.text.slice(0, 60)}" (edit #${ev.message_edit.num_edit ?? '?'})`);
      return;
    }

    const msg = ev.message;
    if (!msg) {
      if (ev.postback) {
        const text = ev.postback.title || ev.postback.payload || "I'm following ✅";
        const customerId = ev.sender?.id;
        if (customerId && customerId !== ownId) {
          const at = eventDate(ev.timestamp);
          await this.messages.save(
            this.messages.create({
              igsid: customerId,
              ownerUsername: ownUsername,
              direction: 'in',
              text,
              source: null,
              attachmentType: null,
              attachmentUrl: null,
              mid: ev.postback.mid ?? null,
              createdAt: at,
            }),
          );
          await this.touchConversation(customerId, text, undefined, 'in', at, ownUsername ?? undefined);
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
    if (msg.mid && (await this.messages.exists({ where: { mid: msg.mid, ...(ownUsername ? { ownerUsername: ownUsername } : {}) } }))) {
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
    await this.messages.save(
      this.messages.create({
        igsid: customerId,
        ownerUsername: ownUsername,
        direction: echo ? 'out' : 'in',
        text,
        source: echo ? 'app' : null,
        attachmentType: attachment?.type ?? null,
        attachmentUrl: attachment?.payload?.url ?? null,
        mid: msg.mid ?? null,
        createdAt: at,
      }),
    );
    const c = await this.touchConversation(customerId, text, attachment?.type, echo ? 'out' : 'in', at, ownUsername ?? undefined);
    this.logger.log(
      `Stored ${echo ? 'outgoing (from app)' : 'incoming'} message ${echo ? 'to' : 'from'} ${c.username ? '@' + c.username : customerId} (unread: ${c.unread})`,
    );
  }

  private async touchConversation(igsid: string, text: string, attachmentType: string | undefined, dir: 'in' | 'out', at: Date, ownerUsername?: string) {
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
    c.lastText = text || (attachmentType ? `[${attachmentType}]` : '');
    c.lastMessageAt = at;
    if (dir === 'in') {
      c.lastInboundAt = at;
      c.unread += 1;
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
    return rows.map((c) => this.view(c));
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
    const recent = await this.messages.find({
      where: { igsid, ownerUsername: own },
      order: { createdAt: 'DESC' },
      take: 300,
    });
    const messages = recent.reverse();
    if (c.unread) {
      c.unread = 0;
      await this.conversations.save(c);
    }
    return { conversation: this.view(c), messages };
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
    // Instagram echoes our own DMs back through the webhook; if that already stored this mid, don't insert twice.
    const alreadyStored = res?.message_id && (await this.messages.exists({ where: { mid: res.message_id, ...(own ? { ownerUsername: own } : {}) } }));
    if (!alreadyStored) {
      await this.messages.save(
        this.messages.create({
          igsid,
          ownerUsername: own ?? null,
          direction: 'out',
          text,
          source,
          attachmentType: null,
          attachmentUrl: null,
          mid: res?.message_id ?? null,
          createdAt: now,
        }),
      );
    } else {
      // The webhook echo won the race and labelled it as typed in the app; set the true sender.
      await this.messages.update({ mid: res.message_id, ...(own ? { ownerUsername: own } : {}) }, { source, ...(own ? { ownerUsername: own } : {}) });
    }
    const c = await this.touchConversation(igsid, text, undefined, 'out', now, own ?? undefined);
    this.logger.log(`[Messaging] DM sent (${sentFormat}) to ${c.username ? '@' + c.username : igsid}: "${text.length > 60 ? text.slice(0, 60) + '…' : text}"`);
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

  private view(c: Conversation) {
    return {
      igsid: c.igsid,
      username: c.username,
      profilePic: c.profilePic ?? null,
      lastText: c.lastText,
      lastMessageAt: c.lastMessageAt,
      unread: c.unread,
      canReply: this.canReply(c),
      replyUntil: c.lastInboundAt ? new Date(c.lastInboundAt.getTime() + WINDOW_MS) : null,
    };
  }
}
