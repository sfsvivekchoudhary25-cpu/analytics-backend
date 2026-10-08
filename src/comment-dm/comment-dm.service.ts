import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Not, Repository } from 'typeorm';
import { GraphClient } from '../instagram-connection/graph-client.service';
import { FacebookPageService, MessageButton } from '../facebook-page/facebook-page.service';
import { InstagramConnectionService } from '../instagram-connection/instagram-connection.service';
import { Comment } from '../comments/comment.entities';
import { messagingEvents } from '../instagram-webhook/events';
import { Conversation, Message } from '../messaging/messaging.entities';
import { MessagingService } from '../messaging/messaging.service';
import { CommentDmLog, CommentDmRule, DEFAULT_FOLLOW_GATE_TEXT } from './comment-dm.entities';
import { AutoReplyRule, AutoReplySetting } from '../comments/comment.entities';

const preview = (t: string, n = 80) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const DAY = 24 * 3600_000;

@Injectable()
export class CommentDmService {
  private readonly logger = new Logger('Comment→DM');

  constructor(
    @InjectRepository(CommentDmRule) private readonly rules: Repository<CommentDmRule>,
    @InjectRepository(CommentDmLog) private readonly logs: Repository<CommentDmLog>,
    @InjectRepository(Comment) private readonly comments: Repository<Comment>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(AutoReplyRule) private readonly autoRules: Repository<AutoReplyRule>,
    @InjectRepository(AutoReplySetting) private readonly autoSettings: Repository<AutoReplySetting>,
    private readonly graph: GraphClient,
    private readonly messaging: MessagingService,
    private readonly facebookPage: FacebookPageService,
    private readonly connection: InstagramConnectionService,
  ) {}

  // ---------- the automations themselves (any number of them; the dashboard shows a list, then an editor
  // per automation). A comment can only ever be claimed by one automation — see processAuto() below. ----------

  private async resolveOwner(ownerUsername?: string): Promise<string | null> {
    if (ownerUsername) return ownerUsername.trim().replace(/^@/, '').toLowerCase();
    const status: any = await this.connection.getStatus().catch(() => null);
    return status?.connected && status?.username ? String(status.username).trim().toLowerCase() : null;
  }

  private async getOwnOrThrow(id: string, ownerUsername?: string): Promise<CommentDmRule> {
    const own = await this.resolveOwner(ownerUsername);
    if (!own) throw new NotFoundException('Automation not found.');
    const rule = await this.rules
      .createQueryBuilder('r')
      .where('r.id = :id AND LOWER(r.ownerUsername) = :own', { id, own })
      .getOne();
    if (!rule) throw new NotFoundException('Automation not found.');
    if (!rule.followGateText) rule.followGateText = DEFAULT_FOLLOW_GATE_TEXT;
    return rule;
  }

  async list(ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    if (!own) return [];
    const rules = await this.rules.find({
      where: { ownerUsername: own },
      order: { createdAt: 'ASC' },
    });
    if (!rules.length) return [];
    const counts = await this.logs
      .createQueryBuilder('l')
      .select('l.rule_id', 'ruleId')
      .addSelect('COUNT(*)', 'triggered')
      .addSelect('COUNT(l.dm_sent_at)', 'sent')
      .where('l.rule_id IN (:...ids)', { ids: rules.map((r) => r.id) })
      .groupBy('l.rule_id')
      .getRawMany<{ ruleId: string; triggered: string; sent: string }>();
    const byRule = new Map(counts.map((c) => [c.ruleId, { triggered: Number(c.triggered), sent: Number(c.sent) }]));
    return rules.map((rule) => {
      if (!rule.followGateText) rule.followGateText = DEFAULT_FOLLOW_GATE_TEXT;
      return { rule, triggered: byRule.get(rule.id)?.triggered ?? 0, sent: byRule.get(rule.id)?.sent ?? 0 };
    });
  }

  async create(ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    const count = await this.rules.count({ where: own ? { ownerUsername: own } : {} });
    return this.rules.save(
      this.rules.create({
        ownerUsername: own,
        name: count ? `Comment-to-DM Automation ${count + 1}` : 'Comment-to-DM Automation',
        enabled: false,
        keywords: '',
        dmText: 'Hey! 👋 Thanks for your comment.',
        requireFollow: false,
        followGateText: DEFAULT_FOLLOW_GATE_TEXT,
      }),
    );
  }

  async getOne(id: string, ownerUsername?: string) {
    return this.getOwnOrThrow(id, ownerUsername);
  }

  async remove(id: string, ownerUsername?: string) {
    const rule = await this.getOwnOrThrow(id, ownerUsername);
    // Its comment_dm_log rows are left alone on purpose — they're history (past invites/DMs sent), not
    // config, and deleting the automation shouldn't erase what it already did.
    await this.rules.delete({ id: rule.id });
    return { ok: true, id };
  }

  // Per-automation activity log: returns recent log entries enriched with the original comment text.
  async logsForRule(id: string, limit = 50, ownerUsername?: string) {
    const rule = await this.getOwnOrThrow(id, ownerUsername);
    const rows = await this.logs.find({
      where: { ruleId: rule.id },
      order: { createdAt: 'DESC' },
      take: limit,
    });
    if (!rows.length) return [];

    // Enrich each log with the original comment text + post thumb from our comment store.
    const commentIds = rows.map((r) => r.commentId);
    const comments = await this.comments
      .createQueryBuilder('c')
      .select(['c.id', 'c.text', 'c.mediaId', 'c.mediaPermalink', 'c.mediaThumb'])
      .where('c.id IN (:...ids)', { ids: commentIds })
      .getMany();
    const commentMap = new Map(comments.map((c) => [c.id, c]));

    // Determine the matched keyword for each log entry.
    const keywords = (rule?.keywords ?? '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);

    return rows.map((log) => {
      const c = commentMap.get(log.commentId);
      const commentText = c?.text ?? null;
      // Find which keyword in the rule matched this comment text.
      const matchedKeyword = commentText
        ? keywords.find((k) => commentText.toLowerCase().includes(k)) ?? null
        : null;
      return {
        id: log.id,
        commentId: log.commentId,
        username: log.username,
        commentText,
        mediaThumb: c?.mediaThumb ?? null,
        mediaPermalink: c?.mediaPermalink ?? null,
        matchedKeyword,
        triggeredAt: log.createdAt,
        dmText: rule?.dmText ?? null,
        status: log.status,
        note: log.note,
        dmSentAt: log.dmSentAt,
        followGateSentAt: log.followGateSentAt,
        pendingFollowGate: log.pendingFollowGate,
        repliedAt: log.repliedAt,
      };
    });
  }

  private getDmPayload(rule: CommentDmRule, username: string) {
    const text = (rule.dmText || 'Hey! 👋 Thanks for your comment.').replaceAll('{username}', username || 'there');

    const sanitizeUrl = (raw?: string | null): string => {
      let u = (raw || '').trim().replaceAll('{username}', username || 'there');
      if (!u || u === 'https://' || u === 'http://') {
        return 'https://www.instagram.com';
      }
      if (!u.startsWith('http://') && !u.startsWith('https://')) {
        u = 'https://' + u;
      }
      try {
        const parsed = new URL(u);
        if (!parsed.hostname || !parsed.hostname.includes('.')) {
          return 'https://www.instagram.com';
        }
        return parsed.toString();
      } catch {
        return 'https://www.instagram.com';
      }
    };

    // If pure text template selected and no card fields set, send clean text
    if (rule.templateType === 'text' && !rule.cardTitle && !rule.cardImageUrl && (!rule.cardButtons || rule.cardButtons.length === 0)) {
      return { text, buttons: undefined, card: undefined };
    }

    const buttons: MessageButton[] = (rule.cardButtons || []).map((b): MessageButton => {
      const title = (b.title || 'Click Here').slice(0, 20);
      if (b.type === 'postback') {
        return {
          type: 'postback',
          title,
          payload: (b as any).payload || 'ACTION',
        };
      }
      return {
        type: 'web_url',
        title,
        url: sanitizeUrl((b as any).url || rule.cardFileUrl),
      };
    });

    let card: { title?: string; subtitle?: string; imageUrl?: string; buttons?: MessageButton[] } | undefined;
    const isCard =
      rule.templateType === 'product' ||
      rule.templateType === 'file' ||
      rule.templateType === 'card' ||
      !!rule.cardImageUrl ||
      !!rule.cardTitle;

    if (isCard) {
      const defaultTitle =
        rule.templateType === 'product'
          ? 'Featured Product'
          : rule.templateType === 'file'
            ? 'Download Resource'
            : text.split('\n')[0] || 'Special Offer';

      const defaultSubtitle =
        rule.templateType === 'file' && rule.cardFileUrl
          ? 'Tap button below to download'
          : text.split('\n').slice(1).join(' ').trim() || text;

      card = {
        title: (rule.cardTitle || defaultTitle).replaceAll('{username}', username || 'there').slice(0, 80),
        subtitle: (rule.cardSubtitle || defaultSubtitle).replaceAll('{username}', username || 'there').slice(0, 80),
        imageUrl: rule.cardImageUrl || undefined,
        buttons: buttons.length > 0 ? buttons : undefined,
      };
    }

    return { text, buttons: buttons.length > 0 ? buttons : undefined, card };
  }

  async update(
    id: string,
    body: {
      name?: string;
      enabled?: boolean;
      keywords?: string;
      dmText?: string;
      requireFollow?: boolean;
      followGateText?: string;
      templateType?: 'text' | 'button' | 'product' | 'file' | 'card';
      cardTitle?: string | null;
      cardSubtitle?: string | null;
      cardImageUrl?: string | null;
      cardFileUrl?: string | null;
      cardButtons?: MessageButton[] | null;
      mediaId?: string | null;
      mediaPermalink?: string | null;
      mediaThumb?: string | null;
    },
    ownerUsername?: string,
  ) {
    const rule = await this.getOwnOrThrow(id, ownerUsername);
    const own = await this.resolveOwner(ownerUsername);
    if (own && !rule.ownerUsername) rule.ownerUsername = own;
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new BadRequestException('Give the automation a name.');
      if (name.length > 100) throw new BadRequestException('Name is too long (100 characters max).');
      rule.name = name;
    }
    if (body.keywords !== undefined) {
      const kw = String(body.keywords).trim();
      if (kw.length > 500) throw new BadRequestException('Keywords are too long (500 characters max).');
      rule.keywords = kw;
    }
    if (body.dmText !== undefined) {
      const text = String(body.dmText).trim();
      if (!text) throw new BadRequestException('The message is required.');
      if (text.length > 1000) throw new BadRequestException('The message is too long (1000 characters max).');
      rule.dmText = text;
    }
    if (typeof body.requireFollow === 'boolean') {
      rule.requireFollow = body.requireFollow;
    }
    if (body.followGateText !== undefined) {
      const gateText = String(body.followGateText).trim();
      if (gateText.length > 1000) throw new BadRequestException('Follow gate message is too long (1000 characters max).');
      rule.followGateText = gateText || rule.followGateText;
    }
    if (body.templateType !== undefined) {
      rule.templateType = body.templateType;
    }
    if (body.cardTitle !== undefined) {
      rule.cardTitle = body.cardTitle ? String(body.cardTitle).trim().slice(0, 80) : null;
    }
    if (body.cardSubtitle !== undefined) {
      rule.cardSubtitle = body.cardSubtitle ? String(body.cardSubtitle).trim().slice(0, 80) : null;
    }
    if (body.cardImageUrl !== undefined) {
      rule.cardImageUrl = body.cardImageUrl ? String(body.cardImageUrl).trim() : null;
    }
    if (body.cardFileUrl !== undefined) {
      rule.cardFileUrl = body.cardFileUrl ? String(body.cardFileUrl).trim() : null;
    }
    if (body.cardButtons !== undefined) {
      rule.cardButtons = Array.isArray(body.cardButtons)
        ? body.cardButtons.slice(0, 3).map((b): MessageButton => {
            const title = String(b.title || '').trim().slice(0, 20);
            if (b.type === 'postback') {
              return {
                type: 'postback',
                title,
                payload: String((b as any).payload || 'ACTION').trim(),
              };
            }
            return {
              type: 'web_url',
              title,
              url: String((b as any).url || 'https://instagram.com').trim(),
            };
          })
        : [];
    }
    if (body.mediaId !== undefined) {
      rule.mediaId = body.mediaId || null;
      rule.mediaPermalink = body.mediaPermalink ?? null;
      rule.mediaThumb = body.mediaThumb ?? null;
    }
    const wasEnabled = rule.enabled;
    if (typeof body.enabled === 'boolean') rule.enabled = body.enabled;
    if (!wasEnabled && rule.enabled) {
      rule.enabledAt = new Date();
      this.logger.log(`"${rule.name}" ACTIVE. Only comments made after ${rule.enabledAt.toLocaleTimeString()} will be invited.`);
    } else if (wasEnabled && !rule.enabled) {
      this.logger.log(`"${rule.name}" turned off.`);
    }
    return this.rules.save(rule);
  }

  // Recent posts to choose from, for the "Check this post" step.
  async recentPosts(ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    let mediaData: any[] = [];
    try {
      const media = await this.graph.get(
        '/me/media',
        { fields: 'id,permalink,thumbnail_url,media_url,caption,timestamp', limit: '30' },
        { account: own ?? undefined },
      );
      mediaData = media?.data ?? [];
    } catch (err) {
      this.logger.warn(`Failed to fetch media from Instagram for comment-dm (${own || 'default'}): ${(err as Error).message}`);
    }
    return mediaData.map((m: any) => ({
      mediaId: m.id as string,
      permalink: (m.permalink ?? null) as string | null,
      thumb: (m.thumbnail_url ?? m.media_url ?? null) as string | null,
      caption: preview(String(m.caption ?? ''), 90),
      postedAt: m.timestamp as string,
    }));
  }




  // Check whether the given IGSID follows us using the Facebook Messaging User Profile API.
  // Returns true/false/null (null = could not determine, treat as not following).
  private async checkIsFollowing(igsid: string): Promise<boolean | null> {
    try {
      const pageToken = await this.facebookPage.getPageAccessToken();
      const FB_API = 'https://graph.facebook.com/v21.0';
      const res = await fetch(`${FB_API}/${igsid}?fields=is_user_follow_business&access_token=${encodeURIComponent(pageToken)}`);
      const body = await res.json();
      if (!res.ok) {
        this.logger.debug(`[follow-gate] is_user_follow_business check failed for ${igsid}: ${body?.error?.message}`);
        return null;
      }
      return body?.is_user_follow_business === true;
    } catch (err) {
      this.logger.debug(`[follow-gate] follow check error for ${igsid}: ${(err as Error).message}`);
      return null;
    }
  }

  private async getIgsidForComment(c: Comment): Promise<string | null> {
    if (c.username) {
      const convWhere: any = { username: c.username };
      if (c.ownerUsername) convWhere.ownerUsername = c.ownerUsername;
      const conv = await this.conversations.findOne({ where: convWhere });
      if (conv?.igsid) return conv.igsid;
      const logWhere: any = { username: c.username, igsid: Not(IsNull()) };
      if (c.ownerUsername) logWhere.ownerUsername = c.ownerUsername;
      const prevLog = await this.logs.findOne({
        where: logWhere,
        order: { createdAt: 'DESC' },
      });
      if (prevLog?.igsid) return prevLog.igsid;
    }
    try {
      const data = await this.graph.get(`/${c.id}`, { fields: 'from{id,username}' }, { silent: true });
      if (data?.from?.id) return String(data.from.id);
    } catch {}
    return null;
  }

  // ---------- matching + inviting ----------

  private matches(rule: CommentDmRule, c: Comment) {
    if (rule.mediaId && c.mediaId !== rule.mediaId) return false;
    const kws = rule.keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (kws.length === 0) return true; // any comment on the chosen post
    const t = c.text.toLowerCase();
    return kws.some((k) => t.includes(k));
  }

  // Looks at recent, not-yet-attempted comments and, for whichever match any active automation, sends the
  // rule's message straight to the commenter as a real private reply (via the Facebook Page's /messages
  // endpoint, recipient.comment_id). A comment is attempted at most once (comment_dm_log.comment_id is
  // unique) — when more than one automation would match the same comment, the first one by creation date
  // claims it and the rest are skipped for that comment, so nobody gets double-messaged.
  //
  // Follow-gate flow:
  //   requireFollow=false (default): send dmText immediately.
  //   requireFollow=true:
  //     1. Check if user is ALREADY following via their IGSID.
  //     2. If already following: send real DM directly (never send the follow-gate message!).
  //     3. If not following: send followGateText with "Visit Profile" and "I'm following ✅" buttons.
  async processAuto(ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    if (!own) return;
    const active = (
      await this.rules.find({
        where: { enabled: true, ownerUsername: own },
        order: { createdAt: 'ASC' },
      })
    ).filter((r) => r.enabledAt);
    if (!active.length) return;

    const earliestEnabledAt = active.reduce((min, r) => (r.enabledAt! < min ? r.enabledAt! : min), active[0].enabledAt!);
    const candidates = await this.comments.find({
      where: { isOwn: false, parentId: IsNull(), commentedAt: MoreThan(earliestEnabledAt), ownerUsername: own },
      order: { commentedAt: 'ASC' },
      take: 25,
    });
    if (!candidates.length) return;

    const already = new Set((await this.logs.find({ select: { commentId: true } })).map((l) => l.commentId));
    const claims = candidates
      .filter((c) => !already.has(c.id))
      .map((c) => ({ c, rule: active.find((r) => c.commentedAt > r.enabledAt! && this.matches(r, c)) }))
      .filter((x): x is { c: Comment; rule: CommentDmRule } => !!x.rule);
    if (!claims.length) return;

    for (const { c, rule } of claims) {
      try {
        if (rule.requireFollow) {
          // Step 1: Check if commenter is ALREADY following BEFORE sending any message
          const igsid = await this.getIgsidForComment(c);
          let isFollowing: boolean | null = null;
          if (igsid) {
            isFollowing = await this.checkIsFollowing(igsid);
          }

          if (isFollowing === true) {
            // Already following! Send real DM directly.
            // Do NOT send the follow-gate "Oh no! It seems you're not following me" message!
            const { text: dmText, buttons: dmButtons, card: dmCard } = this.getDmPayload(rule, c.username || 'there');
            const { recipientId } = await this.facebookPage.sendPrivateReply(c.id, dmText, dmButtons, dmCard);
            await this.logs.save(
              this.logs.create({
                ruleId: rule.id,
                commentId: c.id,
                username: c.username,
                ref: null,
                igsid: recipientId || igsid,
                status: 'sent',
                note: 'follow_gate: user was already following',
                dmSentAt: new Date(),
                followGateSentAt: null,
                pendingFollowGate: false,
              }),
            );
            this.logger.log(`[follow-gate] @${c.username} already follows — DM sent directly via "${rule.name}"`);
            continue;
          }

          // Step 2: User is NOT following (or status unknown without sending a message)
          let profileUrl = 'https://www.instagram.com/';
          try {
            const status = await this.connection.getStatus();
            if (status.username) {
              profileUrl = `https://www.instagram.com/${status.username}/`;
            }
          } catch {}

          const buttons: MessageButton[] = [
            { type: 'web_url', title: 'Visit Profile', url: profileUrl },
            { type: 'postback', title: "I'm following ✅", payload: 'CONFIRM_FOLLOW' },
          ];

          // Send the follow-gate message as a private reply to the comment with buttons
          const gateText = (rule.followGateText || DEFAULT_FOLLOW_GATE_TEXT).replaceAll('{username}', c.username || 'there');
          const { recipientId } = await this.facebookPage.sendPrivateReply(c.id, gateText, buttons);

          // If follow status was unknown initially, check again with recipientId from Meta
          if (isFollowing === null) {
            isFollowing = await this.checkIsFollowing(recipientId);
            if (isFollowing === true) {
              const { text: dmText, buttons: dmButtons, card: dmCard } = this.getDmPayload(rule, c.username || 'there');
              await this.messaging.send(recipientId, dmText, 'system', dmButtons, dmCard);
              await this.logs.save(
                this.logs.create({
                  ruleId: rule.id,
                  commentId: c.id,
                  username: c.username,
                  ref: null,
                  igsid: recipientId,
                  status: 'sent',
                  note: 'follow_gate: user was already following',
                  dmSentAt: new Date(),
                  followGateSentAt: new Date(),
                  pendingFollowGate: false,
                }),
              );
              this.logger.log(`[follow-gate] @${c.username} already follows — DM sent directly via "${rule.name}"`);
              continue;
            }
          }

          // Confirmed not following — leave as pending follow gate
          await this.logs.save(
            this.logs.create({
              ruleId: rule.id,
              commentId: c.id,
              username: c.username,
              ref: null,
              igsid: recipientId || igsid,
              status: 'follow_gate',
              note: isFollowing === null ? 'follow_gate: follow status unknown, waiting for reply' : 'follow_gate: user not following yet',
              dmSentAt: null,
              followGateSentAt: new Date(),
              pendingFollowGate: true,
            }),
          );
          this.logger.log(`[follow-gate] @${c.username} not following — follow-gate sent via "${rule.name}"`);
        } else {
          // No follow gate — send DM directly (supports text, buttons, and card templates).
          const { text: dmText, buttons: dmButtons, card: dmCard } = this.getDmPayload(rule, c.username || 'there');
          const { recipientId } = await this.facebookPage.sendPrivateReply(c.id, dmText, dmButtons, dmCard);
          await this.logs.save(
            this.logs.create({ ruleId: rule.id, commentId: c.id, username: c.username, ref: null, igsid: recipientId, status: 'sent', note: null, dmSentAt: new Date(), followGateSentAt: null, pendingFollowGate: false }),
          );
          this.logger.log(`DM sent to @${c.username || c.id} via "${rule.name}" (reply to comment: "${preview(c.text, 50)}")`);
        }
      } catch (err) {
        const note = (err as Error).message;
        await this.logs.save(this.logs.create({ ruleId: rule.id, commentId: c.id, username: c.username, ref: null, status: 'failed', note, followGateSentAt: null, pendingFollowGate: false }));
        this.logger.warn(`Private reply FAILED for @${c.username || c.id}: ${note}`);
      }
    }
  }

  // Called from the main webhook handler for every incoming message. Handles two cases:
  //   1. Old-style "invited" log entries: the customer opened the ig.me link and messaged in.
  //   2. Follow-gate pending entries: the customer confirmed they followed us; re-verify and send the real DM.
  async handleMessageWebhook(payload: any) {
    const events = messagingEvents(payload);
    if (!events.length) return;
    this.logger.log(`[comment-dm] handleMessageWebhook: ${events.length} messaging event(s) in this payload`);

    // Skip the per-message lookup entirely when nothing is waiting.
    const anyPending = await this.logs.exists({ where: [{ status: 'invited', dmSentAt: IsNull() }, { pendingFollowGate: true }] });
    this.logger.log(`[comment-dm] pending rows waiting for action: ${anyPending}`);
    if (!anyPending) return;

    for (const { ev } of events) {
      const senderId: string | undefined = ev.sender?.id;
      this.logger.log(`[comment-dm] event: senderId=${senderId} is_echo=${!!ev.message?.is_echo} hasReferral=${!!(ev.referral ?? ev.message?.referral ?? ev.postback?.referral)}`);
      if (!senderId || ev.message?.is_echo) {
        this.logger.log('[comment-dm] skipped: no senderId or is_echo');
        continue;
      }

      // ── Case 1: Follow-gate pending — any message from this IGSID triggers a re-check ──
      const followGateLog = await this.logs.findOne({
        where: { igsid: senderId, pendingFollowGate: true },
        order: { followGateSentAt: 'DESC' },
      });
      if (followGateLog) {
        const rule = await this.rules.findOne({ where: { id: followGateLog.ruleId } });
        const isFollowing = await this.checkIsFollowing(senderId);
        this.logger.log(`[follow-gate webhook] @${followGateLog.username} messaged in — is_following=${isFollowing}`);

        const postbackTitle = String(ev.postback?.title ?? '').toLowerCase();
        const msgText = String(ev.message?.text ?? '').toLowerCase();
        const isExplicitConfirmation =
          ev.postback?.payload === 'CONFIRM_FOLLOW' ||
          postbackTitle.includes('follow') ||
          postbackTitle.includes('confirm') ||
          ev.message?.quick_reply?.payload === 'CONFIRM_FOLLOW' ||
          msgText.includes('follow') ||
          msgText.includes('confirm') ||
          msgText.includes('done') ||
          msgText.includes('yes');

        // Verified if Meta confirms (true), OR if API is blocked by Meta (#200 dev mode: isFollowing === null)
        // and the user explicitly tapped "I'm following ✅" or confirmed.
        const confirmed = isFollowing === true || (isFollowing === null && isExplicitConfirmation);

        if (confirmed) {
          const { text: dmText, buttons: dmButtons, card: dmCard } = this.getDmPayload(rule ?? ({} as any), followGateLog.username || 'there');
          try {
            await this.messaging.send(senderId, dmText, 'system', dmButtons, dmCard);
            await this.logs.update(
              { igsid: senderId, pendingFollowGate: true },
              {
                status: 'follow_verified',
                pendingFollowGate: false,
                dmSentAt: new Date(),
                note: isFollowing === true ? 'follow_gate: user confirmed follow, DM sent' : 'follow_gate: user confirmed (dev fallback), DM sent',
              },
            );
            this.logger.log(`[follow-gate webhook] DM sent to @${followGateLog.username} after follow confirmed`);
          } catch (err) {
            this.logger.warn(`[follow-gate webhook] DM send failed for @${followGateLog.username}: ${(err as Error).message}`);
          }
        } else {
          // Still not following — send a reminder with buttons only if at least 45s passed since last gate prompt
          const lastGateMs = followGateLog.followGateSentAt ? Date.now() - followGateLog.followGateSentAt.getTime() : Infinity;
          if (isExplicitConfirmation && lastGateMs > 45 * 1000) {
            let profileUrl = 'https://www.instagram.com/';
            try {
              const status = await this.connection.getStatus();
              if (status.username) profileUrl = `https://www.instagram.com/${status.username}/`;
            } catch {}

            const reminderButtons: MessageButton[] = [
              { type: 'web_url', title: 'Visit Profile', url: profileUrl },
              { type: 'postback', title: "I'm following ✅", payload: 'CONFIRM_FOLLOW' },
            ];

            const reminderText = `You're not following us yet 👀! Tap "Visit Profile" below to hit Follow, then tap "I'm following ✅" again.`;
            try {
              await this.messaging.send(senderId, reminderText, 'system', reminderButtons);
              await this.logs.update(
                { igsid: senderId, pendingFollowGate: true },
                { followGateSentAt: new Date() },
              );
              this.logger.log(`[follow-gate webhook] Reminder sent with buttons to @${followGateLog.username} — still not following`);
            } catch (err) {
              this.logger.warn(`[follow-gate webhook] Reminder send failed: ${(err as Error).message}`);
            }
          } else {
            this.logger.log(`[follow-gate webhook] @${followGateLog.username} not following yet — reminder throttled (${Math.round(lastGateMs / 1000)}s ago)`);
          }
        }
        continue; // handled, skip Case 2 for this event
      }

      // ── Case 2: Legacy "invited" flow (old ig.me link workaround) ──
      const ref: string | undefined = ev.referral?.ref ?? ev.message?.referral?.ref ?? ev.postback?.referral?.ref;

      let log = ref ? await this.logs.findOne({ where: { ref, dmSentAt: IsNull() } }) : null;
      let matchedBy = 'ref';
      if (!log) {
        const profile = await this.graph.get(`/${senderId}`, { fields: 'username' }).catch((err) => {
          this.logger.warn(`[comment-dm] username lookup for ${senderId} failed: ${(err as Error).message}`);
          return null;
        });
        const username = String(profile?.username ?? '').toLowerCase();
        this.logger.log(`[comment-dm] no ref match; looked up username="${username}" for sender ${senderId}`);
        if (!username) continue;
        log = await this.logs.findOne({ where: { username, dmSentAt: IsNull(), status: 'invited' }, order: { createdAt: 'DESC' } });
        matchedBy = 'username';
      }
      if (!log) {
        this.logger.log('[comment-dm] no matching invited row for this sender — nothing to do');
        continue;
      }

      const rule = await this.rules.findOne({ where: { id: log.ruleId } });
      const text = (rule?.dmText ?? 'Thanks!').replaceAll('{username}', log.username || 'there');
      try {
        await this.messaging.send(senderId, text, 'system');
        await this.logs.update(log.id, { igsid: senderId, dmSentAt: new Date() });
        this.logger.log(`DM SENT to @${log.username || senderId} after they messaged in (matched by ${matchedBy}): "${preview(text)}"`);
      } catch (err) {
        this.logger.warn(`DM send failed for @${log.username || senderId}: ${(err as Error).message}`);
      }
    }
  }

  // Webhook-independent fallback: polls pending follow-gate logs every few seconds.
  // If the customer sent an inbound DM (like tapping "I'm following ✅") or if they followed us on Instagram,
  // this re-checks follow status via Meta Graph API and delivers either the real DM or the follow reminder.
  async processPendingFollowGates() {
    const pendingLogs = await this.logs.find({
      where: { pendingFollowGate: true },
      order: { createdAt: 'ASC' },
    });
    if (!pendingLogs.length) return;

    // Fast-sync messages from Instagram Graph API so we catch taps/messages even if webhook didn't arrive
    await this.messaging.syncFromInstagram().catch(() => {});

    // Group pending logs by IGSID
    const byIgsid = new Map<string, CommentDmLog[]>();
    for (const log of pendingLogs) {
      if (!log.igsid) continue;
      const list = byIgsid.get(log.igsid) ?? [];
      list.push(log);
      byIgsid.set(log.igsid, list);
    }

    for (const [igsid, logs] of byIgsid.entries()) {
      const username = logs[0].username || igsid;
      const latestGateSentAt = logs.reduce(
        (max, l) => (l.followGateSentAt && l.followGateSentAt > max ? l.followGateSentAt : max),
        new Date(0),
      );

      // Check the latest message overall in the conversation
      const lastMessage = await this.messages.findOne({
        where: { igsid },
        order: { createdAt: 'DESC' },
      });

      // Check if the customer sent any inbound message
      const lastInbound = await this.messages.findOne({
        where: { igsid, direction: 'in' },
        order: { createdAt: 'DESC' },
      });

      const isWaitingForReply = Boolean(lastMessage?.direction === 'in');
      const newInboundSincePrompt = Boolean(lastInbound && lastInbound.createdAt > latestGateSentAt);
      const msgText = String(lastInbound?.text ?? '').toLowerCase();
      const explicitText =
        msgText.includes('following') ||
        msgText.includes('follow') ||
        msgText.includes('confirm') ||
        msgText.includes('done') ||
        msgText.includes('yes');

      const msSinceLastPrompt = Date.now() - latestGateSentAt.getTime();

      // Check follow status if:
      // 1. Customer sent a NEW inbound message since the last follow-gate prompt
      // 2. Or customer's latest message is inbound (they are waiting for reply)
      // 3. Or passive re-check every 60s in case they followed on profile without texting
      const shouldCheck = newInboundSincePrompt || isWaitingForReply || msSinceLastPrompt > 60_000;
      if (!shouldCheck) continue;

      const isFollowing = await this.checkIsFollowing(igsid);
      this.logger.log(`[follow-gate fallback] @${username} (igsid: ${igsid}) is_following=${isFollowing}`);

      const rule = await this.rules.findOne({ where: { id: logs[0].ruleId } });

      // Follow is confirmed if:
      // 1. Meta API returns true
      // 2. OR Meta API check returned null (#200 dev mode error) AND the customer sent an explicit confirmation message
      const confirmed = isFollowing === true || (isFollowing === null && explicitText && (newInboundSincePrompt || isWaitingForReply));

      if (confirmed) {
        // User confirmed follow! Send real DM
        const { text: dmText, buttons: dmButtons, card: dmCard } = this.getDmPayload(rule ?? ({} as any), username);
        try {
          await this.messaging.send(igsid, dmText, 'system', dmButtons, dmCard);
          const now = new Date();
          await this.logs.update(
            { igsid, pendingFollowGate: true },
            {
              status: 'follow_verified',
              pendingFollowGate: false,
              dmSentAt: now,
              note: isFollowing === true ? 'follow_gate: user confirmed follow, DM sent' : 'follow_gate: user confirmed (dev fallback), DM sent',
            },
          );
          this.logger.log(`[follow-gate fallback] DM delivered to @${username} after follow confirmed`);
        } catch (err) {
          this.logger.warn(`[follow-gate fallback] DM send failed for @${username}: ${(err as Error).message}`);
        }
      } else {
        // Still not following!
        // CRITICAL BUG FIX: Only send a reminder if the customer ACTIVELY sent a NEW inbound message since the last prompt!
        // Passive background checks (when newInboundSincePrompt is false) must NEVER send reminders.
        if (newInboundSincePrompt && isWaitingForReply && msSinceLastPrompt > 15_000) {
          let profileUrl = 'https://www.instagram.com/';
          try {
            const status = await this.connection.getStatus();
            if (status.username) profileUrl = `https://www.instagram.com/${status.username}/`;
          } catch {}

          const reminderButtons: MessageButton[] = [
            { type: 'web_url', title: 'Visit Profile', url: profileUrl },
            { type: 'postback', title: "I'm following ✅", payload: 'CONFIRM_FOLLOW' },
          ];

          const reminderText = `You're not following us yet 👀! Tap "Visit Profile" below to hit Follow, then tap "I'm following ✅" again.`;
          try {
            await this.messaging.send(igsid, reminderText, 'system', reminderButtons);
            const now = new Date();
            await this.logs.update(
              { igsid, pendingFollowGate: true },
              { followGateSentAt: now },
            );
            this.logger.log(`[follow-gate fallback] Reminder sent with buttons to @${username} — still not following`);
          } catch (err) {
            this.logger.warn(`[follow-gate fallback] Reminder send failed: ${(err as Error).message}`);
          }
        }
      }
    }
  }

  // Fills in `repliedAt` once the customer sends any message after the real DM went out — using only data
  // that already synced in through the messaging pipeline, nothing guessed.
  async reconcile() {
    const pending = await this.logs.find({ where: { dmSentAt: Not(IsNull()), igsid: Not(IsNull()), repliedAt: IsNull() }, take: 100 });
    for (const log of pending) {
      const reply = await this.messages.findOne({
        where: { igsid: log.igsid!, direction: 'in', createdAt: MoreThan(log.dmSentAt!) },
        order: { createdAt: 'ASC' },
      });
      if (reply) {
        await this.logs.update(log.id, { repliedAt: reply.createdAt });
        this.logger.log(`@${log.username} replied to the automated DM.`);
      }
    }
  }

  @Cron('*/5 * * * * *')
  async tick() {
    const accounts = await this.connection.listConnectedAccounts().catch(() => []);
    if (accounts.length === 0) {
      await this.processAuto().catch((err) => this.logger.error(`Processing failed: ${(err as Error).message}`));
    } else {
      for (const acc of accounts) {
        await this.processAuto(acc.username).catch((err) => this.logger.error(`Processing failed for @${acc.username}: ${(err as Error).message}`));
      }
    }
    await this.processPendingFollowGates().catch((err) => this.logger.error(`Follow gate processing failed: ${(err as Error).message}`));
    await this.reconcile().catch((err) => this.logger.warn(`Reconcile failed: ${(err as Error).message}`));
  }

  // ---------- performance overview ----------
  // One combined dashboard across every automation (shown on the list page) — not per-automation, since
  // with several automations running at once a single "how's this working overall" view is more useful
  // than having to add numbers up by hand across each one's own page.

  private summarize(rows: CommentDmLog[], days: number) {
    const triggered = rows.length;
    const sent = rows.filter((r) => r.dmSentAt).length;
    const failed = rows.filter((r) => r.status === 'failed').length;
    const replied = rows.filter((r) => r.repliedAt).length;

    // Daily "DMs sent" series, zero-filled so the chart has one point per day.
    const buckets = new Map<string, number>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
      buckets.set(d, 0);
    }
    for (const r of rows) {
      if (!r.dmSentAt) continue;
      const d = r.dmSentAt.toISOString().slice(0, 10);
      if (buckets.has(d)) buckets.set(d, (buckets.get(d) ?? 0) + 1);
    }
    const series = [...buckets.entries()].map(([date, value]) => ({ date, value }));

    return {
      days,
      triggered,
      sent,
      failed,
      replied,
      deliveryRate: triggered ? Math.round((sent / triggered) * 1000) / 10 : null,
      responseRate: sent ? Math.round((replied / sent) * 1000) / 10 : null,
      series,
    };
  }

  async overallStats(days: number, ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    const cutoff = new Date(Date.now() - days * DAY);
    const rows = await this.logs.find({
      where: own ? { ownerUsername: own, createdAt: MoreThan(cutoff) } : { createdAt: MoreThan(cutoff) },
      order: { createdAt: 'ASC' },
    });
    return this.summarize(rows, days);
  }

  // Full post detail bundle: post meta + comments (with AI/auto/manual tags) + active automations + timeline analytics.
  async postDetail(mediaId: string, days = 30, ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    // 1. All top-level comments on this post (newest first)
    const commentWhere: any = { mediaId, parentId: IsNull() };
    if (own) commentWhere.ownerUsername = own;
    const commentRows = await this.comments.find({
      where: commentWhere,
      order: { commentedAt: 'DESC' },
      take: 200,
    });

    // 2. Detect if any comment contains hashtags
    const hasHashtagComment = commentRows.some((c) => /#[a-zA-Z0-9_\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff]+/i.test(c.text || ''));

    // 2. Comment-DM rules active for this post (either targeting it specifically, or targeting any post)
    const dmRules = await this.rules.find({
      where: own ? { ownerUsername: own, enabled: true } : { enabled: true },
      order: { createdAt: 'ASC' },
    });
    const relevantDmRules = dmRules.filter((r) => !r.mediaId || r.mediaId === mediaId);

    // 3. DM logs for comments on this post
    const commentIds = commentRows.map((c) => c.id);
    const dmLogs =
      commentIds.length > 0
        ? await this.logs
            .createQueryBuilder('l')
            .where('l.comment_id IN (:...ids)', { ids: commentIds })
            .getMany()
        : [];
    const dmLogByCommentId = new Map(dmLogs.map((l) => [l.commentId, l]));

    // 4. Auto-reply setting + rules
    const autoSetting = own
      ? await this.autoSettings.findOne({ where: { ownerUsername: own } })
      : await this.autoSettings.findOne({ where: { id: 1 } });
    const autoReplyRules = await this.autoRules.find({
      where: own ? { ownerUsername: own, enabled: true } : { enabled: true },
      order: { sortOrder: 'ASC' },
    });

    // 5. Build comment activity with tags
    const comments = commentRows
      .filter((c) => !c.isOwn)
      .map((c) => {
        const dmLog = dmLogByCommentId.get(c.id);
        // Determine trigger type tag
        let triggerTag: 'ai' | 'auto' | 'manual' | 'comment-dm' | null = null;
        let triggerNote: string | null = null;

        if (dmLog) {
          triggerTag = 'comment-dm';
          // Which DM rule matched?
          const matchedRule = relevantDmRules.find((r) => r.id === dmLog.ruleId);
          triggerNote = matchedRule
            ? `Comment-DM: "${matchedRule.name}"` + (matchedRule.keywords ? ` · keyword: ${matchedRule.keywords.split(',')[0].trim()}` : ' · any comment')
            : 'Comment-DM automation';
        } else if (c.replyKind === 'auto') {
          triggerTag = c.autoNote?.includes('AI') || c.autoNote?.includes('ai') ? 'ai' : 'auto';
          triggerNote = c.autoNote ?? 'Auto reply rule matched';
        } else if (c.replyKind === 'manual') {
          triggerTag = 'manual';
          triggerNote = 'Replied manually';
        }

        return {
          id: c.id,
          username: c.username,
          text: c.text,
          commentedAt: c.commentedAt,
          likeCount: c.likeCount,
          hidden: c.hidden,
          myReply: c.myReply,
          repliedAt: c.repliedAt,
          replyKind: c.replyKind,
          autoState: c.autoState,
          autoNote: c.autoNote,
          triggerTag,
          triggerNote,
          // DM info if comment-dm fired
          dmStatus: dmLog?.status ?? null,
          dmSentAt: dmLog?.dmSentAt ?? null,
          dmRepliedAt: dmLog?.repliedAt ?? null,
        };
      });

    // 6. Post-level stats & metrics
    const totalComments = commentRows.filter((c) => !c.isOwn).length;
    const replied = commentRows.filter((c) => c.repliedAt).length;
    const dmTriggered = dmLogs.length;
    const dmSent = dmLogs.filter((l) => l.dmSentAt).length;
    const dmReplied = dmLogs.filter((l) => l.repliedAt).length;
    const aiReplied = commentRows.filter((c) => c.replyKind === 'auto' && (c.autoNote?.includes('AI') || c.autoNote?.includes('ai'))).length;
    const autoReplied = commentRows.filter((c) => c.replyKind === 'auto').length - aiReplied;
    const manualReplied = commentRows.filter((c) => c.replyKind === 'manual').length;

    const responseRate = totalComments > 0 ? Math.round((replied / totalComments) * 1000) / 10 : 0;
    const dmDeliveryRate = dmTriggered > 0 ? Math.round((dmSent / dmTriggered) * 1000) / 10 : 0;
    const dmConversionRate = dmSent > 0 ? Math.round((dmReplied / dmSent) * 1000) / 10 : 0;

    // 6b. Follow-gate stats
    const followGateSent = dmLogs.filter((l) => l.followGateSentAt).length;
    const followGateConverted = dmLogs.filter((l) => l.status === 'follow_verified' || (l.followGateSentAt && l.dmSentAt)).length;
    const followGateConversionRate = followGateSent > 0 ? Math.round((followGateConverted / followGateSent) * 1000) / 10 : 0;

    // 6c. Average DM response time (comment → DM sent), in minutes
    const dmResponseTimes: number[] = dmLogs
      .filter((l) => l.dmSentAt)
      .map((l) => {
        const comment = commentRows.find((c) => c.id === l.commentId);
        if (!comment?.commentedAt || !l.dmSentAt) return null;
        return (l.dmSentAt.getTime() - comment.commentedAt.getTime()) / 60000;
      })
      .filter((v): v is number => v !== null && v >= 0 && v < 1440); // exclude outliers > 24h
    const avgDmResponseMinutes =
      dmResponseTimes.length > 0
        ? Math.round((dmResponseTimes.reduce((a, b) => a + b, 0) / dmResponseTimes.length) * 10) / 10
        : null;

    // 6d. Average public reply response time (comment → reply), in minutes
    const replyResponseTimes: number[] = commentRows
      .filter((c) => !c.isOwn && c.repliedAt && c.commentedAt)
      .map((c) => (c.repliedAt!.getTime() - c.commentedAt.getTime()) / 60000)
      .filter((v) => v >= 0 && v < 1440);
    const avgReplyResponseMinutes =
      replyResponseTimes.length > 0
        ? Math.round((replyResponseTimes.reduce((a, b) => a + b, 0) / replyResponseTimes.length) * 10) / 10
        : null;

    // 6e. Peak comment hour (0–23 UTC) for this post
    const hourCounts = new Array(24).fill(0);
    for (const c of commentRows.filter((x) => !x.isOwn && x.commentedAt)) {
      hourCounts[c.commentedAt.getUTCHours()]++;
    }
    const peakHour = totalComments > 0 ? hourCounts.indexOf(Math.max(...hourCounts)) : null;

    // 6f. Top commenters (by comment count) — useful for identifying engaged advocates
    const commenterCounts = new Map<string, number>();
    for (const c of commentRows.filter((x) => !x.isOwn && x.username)) {
      commenterCounts.set(c.username, (commenterCounts.get(c.username) ?? 0) + 1);
    }
    const topCommenters = [...commenterCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([username, count]) => ({ username, count }));

    // 6g. Per-rule performance: triggered, sent, replied counts for each active rule
    const rulePerformance = relevantDmRules.map((rule) => {
      const ruleLogs = dmLogs.filter((l) => l.ruleId === rule.id);
      const rTriggered = ruleLogs.length;
      const rSent = ruleLogs.filter((l) => l.dmSentAt).length;
      const rReplied = ruleLogs.filter((l) => l.repliedAt).length;
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        triggered: rTriggered,
        sent: rSent,
        replied: rReplied,
        deliveryRate: rTriggered > 0 ? Math.round((rSent / rTriggered) * 1000) / 10 : 0,
        conversionRate: rSent > 0 ? Math.round((rReplied / rSent) * 1000) / 10 : 0,
      };
    });

    // 7. Time series buckets (for proper chart analytics like dashboard)
    const buckets = new Map<string, {
      date: string;
      comments: number;
      dmsSent: number;
      replies: number;
      aiReplied: number;
      autoReplied: number;
      manualReplied: number;
    }>();

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
      buckets.set(d, {
        date: d,
        comments: 0,
        dmsSent: 0,
        replies: 0,
        aiReplied: 0,
        autoReplied: 0,
        manualReplied: 0,
      });
    }

    for (const c of commentRows.filter((x) => !x.isOwn)) {
      if (c.commentedAt) {
        const cd = c.commentedAt.toISOString().slice(0, 10);
        const b = buckets.get(cd);
        if (b) b.comments++;
      }
      if (c.repliedAt) {
        const rd = c.repliedAt.toISOString().slice(0, 10);
        const b = buckets.get(rd);
        if (b) {
          b.replies++;
          if (c.replyKind === 'auto') {
            if (c.autoNote?.includes('AI') || c.autoNote?.includes('ai')) {
              b.aiReplied++;
            } else {
              b.autoReplied++;
            }
          } else if (c.replyKind === 'manual') {
            b.manualReplied++;
          }
        }
      }
    }

    for (const l of dmLogs) {
      if (l.dmSentAt) {
        const ld = l.dmSentAt.toISOString().slice(0, 10);
        const b = buckets.get(ld);
        if (b) b.dmsSent++;
      }
    }

    const series = [...buckets.values()];

    // 8. Fetch live media metadata & detailed insights from Instagram Graph API
    let mediaMeta: any = null;
    try {
      mediaMeta = await this.graph.get(
        `/${mediaId}`,
        {
          fields: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
        },
        { account: own ?? undefined },
      );
    } catch {
      // offline or token issue
    }

    const insights: Record<string, number | null> = {
      reach: null,
      views: null,
      plays: null,
      impressions: null,
      saved: null,
      shares: null,
      totalInteractions: null,
      engagementRate: null,
      saveRate: null,
      shareRate: null,
      videoWatchTime: null,
      videoAvgWatchTime: null,
    };

    const isReel =
      mediaMeta?.media_product_type === 'REELS' ||
      mediaMeta?.media_type === 'VIDEO';

    // Tailored metric sets based on Instagram media product type.
    // Instagram Graph API rules:
    // - REELS do NOT support 'impressions', and 'plays' is deprecated in favor of 'views'.
    // - Feed posts/Carousels support 'views', 'reach', 'impressions', 'saved', 'shares', 'total_interactions'.
    const reelMetricCandidates = [
      'views,reach,saved,shares,total_interactions',
      'reach,saved,shares,total_interactions',
      'views,reach',
    ];
    const postMetricCandidates = [
      'views,reach,impressions,saved,shares,total_interactions',
      'reach,impressions,saved,shares,total_interactions',
      'reach,saved,shares,total_interactions',
    ];

    const candidateBatches = isReel ? reelMetricCandidates : postMetricCandidates;

    for (const metricQuery of candidateBatches) {
      try {
        const resp = await this.graph.get(`/${mediaId}/insights`, { metric: metricQuery }, { silent: true });
        if (resp?.data && Array.isArray(resp.data)) {
          for (const item of resp.data) {
            const val = item.values?.[0]?.value ?? item.total_value?.value ?? null;
            if (item.name === 'total_interactions') insights.totalInteractions = val;
            else if (item.name in insights) (insights as any)[item.name] = val;
          }
          break; // Primary batch succeeded
        }
      } catch {
        // try next candidate set
      }
    }

    // Optional video watch time for reels
    if (isReel) {
      try {
        const videoResp = await this.graph.get(
          `/${mediaId}/insights`,
          { metric: 'ig_reels_video_view_total_time,ig_reels_avg_watch_time' },
          { silent: true },
        );
        if (videoResp?.data && Array.isArray(videoResp.data)) {
          for (const item of videoResp.data) {
            const val = item.values?.[0]?.value ?? item.total_value?.value ?? null;
            if (item.name === 'ig_reels_video_view_total_time') insights.videoWatchTime = val;
            else if (item.name === 'ig_reels_avg_watch_time') insights.videoAvgWatchTime = val;
          }
        }
      } catch {
        // ignore video-specific metric errors silently
      }
    }

    // Individual safe fallback queries for any missing core metrics (never query 'plays' or unsupported metrics)
    const safeFallbackMetrics = isReel
      ? ['views', 'reach', 'saved', 'shares', 'total_interactions']
      : ['views', 'reach', 'impressions', 'saved', 'shares', 'total_interactions'];

    for (const met of safeFallbackMetrics) {
      const currentVal = met === 'total_interactions' ? insights.totalInteractions : (insights as any)[met];
      if (currentVal == null) {
        try {
          const r = await this.graph.get(`/${mediaId}/insights`, { metric: met }, { silent: true });
          if (r?.data?.[0]) {
            const val = r.data[0].values?.[0]?.value ?? r.data[0].total_value?.value ?? null;
            if (met === 'total_interactions') insights.totalInteractions = val;
            else if (met in insights) (insights as any)[met] = val;
          }
        } catch {
          // silently continue
        }
      }
    }

    // Sync views with plays for backward compatibility
    if (insights.views != null && insights.plays == null) {
      insights.plays = insights.views;
    } else if (insights.plays != null && insights.views == null) {
      insights.views = insights.plays;
    }

    // Compute derived metrics
    const likes = typeof mediaMeta?.like_count === 'number' ? mediaMeta.like_count : 0;
    const commentsCount = typeof mediaMeta?.comments_count === 'number' ? mediaMeta.comments_count : totalComments;
    const saves = insights.saved ?? 0;
    const shares = insights.shares ?? 0;

    if (insights.totalInteractions == null) {
      insights.totalInteractions = likes + commentsCount + saves + shares;
    }

    const reach = insights.reach ?? (insights.views ?? insights.impressions);
    if (reach && reach > 0 && insights.totalInteractions != null) {
      insights.engagementRate = Math.round((insights.totalInteractions / reach) * 1000) / 10;
      if (saves > 0) insights.saveRate = Math.round((saves / reach) * 1000) / 10;
      if (shares > 0) insights.shareRate = Math.round((shares / reach) * 1000) / 10;
    }

    // 9. All Comment-DM rules (including disabled) for this post — so user can enable/control from the detail page
    const allDmRulesForPost = (
      own
        ? await this.rules.find({
            where: { ownerUsername: own },
            order: { createdAt: 'ASC' },
          })
        : []
    ).filter((r) => !r.mediaId || r.mediaId === mediaId);

    return {
      mediaId,
      days,
      hasHashtagComment,
      mediaMeta,
      insights,
      mediaInsights: insights,
      stats: {
        totalComments,
        replied,
        dmTriggered,
        dmSent,
        dmReplied,
        aiReplied,
        autoReplied,
        manualReplied,
        responseRate,
        dmDeliveryRate,
        dmConversionRate,
        // New enriched stats
        followGateSent,
        followGateConverted,
        followGateConversionRate,
        avgDmResponseMinutes,
        avgReplyResponseMinutes,
        peakHour,
      },
      topCommenters,
      rulePerformance,
      series,
      comments,
      dmRules: allDmRulesForPost,
      autoSetting: autoSetting ?? { enabled: false, aiEnabled: false, maxPerHour: 30 },
      autoReplyRules,
    };
  }
}

