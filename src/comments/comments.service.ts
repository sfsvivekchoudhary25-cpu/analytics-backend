import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { AiService } from '../ai/ai.service';
import { commentEvents, commentId } from '../instagram-webhook/events';
import { GraphClient, isGoneOnInstagram } from '../instagram-connection/graph-client.service';
import { InstagramConnectionService } from '../instagram-connection/instagram-connection.service';
import { AutoReplyRule, AutoReplySetting, Comment, ReplyKind } from './comment.entities';
import { CommentDmRule } from '../comment-dm/comment-dm.entities';

type Incoming = {
  id: string;
  text: string;
  username: string;
  commentedAt: Date;
  likeCount: number;
  hidden: boolean;
  mediaId: string;
  mediaPermalink: string | null;
  mediaThumb: string | null;
  parentId: string | null;
  ownReplyText?: string | null; // set when a reply from our account already exists on Instagram
  ownReplyAt?: Date | null;
};

// A late AI answer to an old comment reads oddly, so those are left for a person.
const AI_MAX_AGE_MS = 45 * 60_000;
const AI_MAX_PER_PERSON_PER_HOUR = 2;

const preview = (t: string, n = 80) => {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

@Injectable()
export class CommentsService {
  private readonly logger = new Logger('Comments');
  private syncing = false;
  private lastHiddenWarning = 0;
  private readonly mediaCache = new Map<string, { permalink: string | null; thumb: string | null; caption: string }>();

  constructor(
    @InjectRepository(Comment) private readonly comments: Repository<Comment>,
    @InjectRepository(AutoReplySetting) private readonly settingsRepo: Repository<AutoReplySetting>,
    @InjectRepository(AutoReplyRule) private readonly rulesRepo: Repository<AutoReplyRule>,
    @InjectRepository(CommentDmRule) private readonly commentDmRules: Repository<CommentDmRule>,
    private readonly graph: GraphClient,
    private readonly connection: InstagramConnectionService,
    private readonly ai: AiService,
  ) {}

  // ---------- reading ----------

  private async resolveOwner(ownerUsername?: string): Promise<string | null> {
    if (ownerUsername) return ownerUsername.trim().replace(/^@/, '').toLowerCase();
    const status: any = await this.connection.getStatus().catch(() => null);
    return status?.connected && status?.username ? String(status.username).trim().toLowerCase() : null;
  }

  async list(filter: 'all' | 'unreplied', ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    if (!own) return [];
    const whereBase: any = filter === 'unreplied' ? { parentId: IsNull(), repliedAt: IsNull(), isOwn: false, ownerUsername: own } : { parentId: IsNull(), ownerUsername: own };
    return this.comments.find({
      where: whereBase,
      order: { commentedAt: 'DESC' },
      take: 100,
    });
  }

  // Posts that Instagram says have comments, with how many of them the API has actually shared with us.
  async postsWithComments(ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    if (!own) return [];
    let mediaData: any[] = [];
    try {
      const media = await this.graph.get('/me/media', {
        fields: 'id,permalink,thumbnail_url,media_url,caption,timestamp,comments_count',
        limit: '30',
      });
      mediaData = media?.data ?? [];
    } catch (err) {
      this.logger.warn(`Failed to fetch media from Instagram for comments: ${(err as Error).message}`);
    }
    const qb = this.comments
      .createQueryBuilder('c')
      .select('c.media_id', 'mid')
      .addSelect('COUNT(*)', 'n')
      .where('c.parent_id IS NULL');
    if (own) {
      qb.andWhere('(c.ownerUsername = :own OR c.ownerUsername IS NULL)', { own });
    }
    const rows: { mid: string; n: string }[] = await qb.groupBy('c.media_id').getRawMany();
    const visible = new Map(rows.map((r) => [r.mid, Number(r.n)]));
    return mediaData
      .filter((m: any) => m.comments_count > 0)
      .map((m: any) => ({
        mediaId: m.id as string,
        permalink: (m.permalink ?? null) as string | null,
        thumb: (m.thumbnail_url ?? m.media_url ?? null) as string | null,
        caption: preview(String(m.caption ?? ''), 90),
        postedAt: m.timestamp as string,
        reported: m.comments_count as number,
        visible: visible.get(m.id) ?? 0,
      }));
  }

  // ---------- replying / moderating ----------

  async reply(id: string, rawText: string) {
    const text = String(rawText ?? '').trim();
    if (!text) throw new BadRequestException('Reply is empty.');
    if (text.length > 2200) throw new BadRequestException('Reply is too long (2200 characters max).');
    const c = await this.getOrThrow(id);
    try {
      return await this.sendReply(c, text, 'manual');
    } catch (err) {
      this.logger.warn(`Reply to @${c.username || c.id} FAILED: ${(err as Error).message}`);
      if (isGoneOnInstagram(err)) {
        throw new BadRequestException('This comment no longer exists on Instagram (likely deleted by the commenter) — it can\'t be replied to. You can hide it instead to clear it from the list.');
      }
      throw new BadGatewayException(`Instagram could not post the reply: ${(err as Error).message}`);
    }
  }

  // Post a top-level comment (e.g. hashtags, creator announcement) directly on an Instagram post/media
  async postMediaComment(mediaId: string, rawText: string) {
    const text = String(rawText ?? '').trim();
    if (!text) throw new BadRequestException('Comment is empty.');
    if (text.length > 2200) throw new BadRequestException('Comment is too long (2200 characters max).');
    try {
      const res = await this.graph.post(`/${mediaId}/comments`, { message: text });
      this.logger.log(`POSTED comment on media ${mediaId}: "${preview(text)}"`);
      this.sync().catch(() => {});
      return { success: true, id: res?.id };
    } catch (err) {
      this.logger.warn(`Post comment on media ${mediaId} FAILED: ${(err as Error).message}`);
      throw new BadGatewayException(`Instagram could not post the comment: ${(err as Error).message}`);
    }
  }

  async setHidden(id: string, hidden: boolean) {
    const c = await this.getOrThrow(id);
    try {
      await this.graph.post(`/${id}`, { hide: hidden ? 'true' : 'false' });
    } catch (err) {
      // A comment Instagram has already dropped can't be told to hide/unhide either — but there's nothing
      // left to show or hide at that point, so just reflect that locally instead of blocking the user on it.
      if (isGoneOnInstagram(err)) {
        this.logger.log(`Comment by @${c.username} is gone on Instagram — marking ${hidden ? 'hidden' : 'unhidden'} locally.`);
      } else {
        this.logger.warn(`${hidden ? 'Hide' : 'Unhide'} comment by @${c.username} FAILED: ${(err as Error).message}`);
        throw new BadGatewayException(`Instagram could not ${hidden ? 'hide' : 'unhide'} the comment: ${(err as Error).message}`);
      }
    }
    c.hidden = hidden;
    this.logger.log(`${hidden ? 'Hid' : 'Unhid'} comment by @${c.username}: "${preview(c.text, 50)}"`);
    return this.comments.save(c);
  }

  // Uses instagram_manage_engagement permission to like a comment
  async like(id: string) {
    const c = await this.getOrThrow(id);
    try {
      await this.graph.post(`/${id}/likes`, {});
      this.logger.log(`LIKED comment by @${c.username || c.id}: "${preview(c.text, 50)}"`);
      return { success: true, id };
    } catch (err) {
      this.logger.warn(`Like comment by @${c.username || c.id} FAILED: ${(err as Error).message}`);
      throw new BadGatewayException(`Instagram could not like the comment: ${(err as Error).message}`);
    }
  }

  // Uses instagram_manage_engagement permission to unlike a comment
  async unlike(id: string) {
    const c = await this.getOrThrow(id);
    try {
      await this.graph.delete(`/${id}/likes`);
      this.logger.log(`UNLIKED comment by @${c.username || c.id}`);
      return { success: true, id };
    } catch (err) {
      this.logger.warn(`Unlike comment by @${c.username || c.id} FAILED: ${(err as Error).message}`);
      throw new BadGatewayException(`Instagram could not unlike the comment: ${(err as Error).message}`);
    }
  }

  private async sendReply(c: Comment, text: string, kind: ReplyKind) {
    await this.graph.post(`/${c.id}/replies`, { message: text });
    c.myReply = text;
    c.repliedAt = new Date();
    c.replyKind = kind;
    this.logger.log(`REPLIED (${kind}) to @${c.username || c.id}: "${preview(text)}"`);
    return this.comments.save(c);
  }

  // ---------- automation settings ----------

  private async getSettings(ownerUsername?: string): Promise<AutoReplySetting> {
    const own = await this.resolveOwner(ownerUsername);
    let existing: AutoReplySetting | null = null;
    if (own) {
      existing = await this.settingsRepo
        .createQueryBuilder('s')
        .where('LOWER(s.ownerUsername) = :own', { own })
        .getOne();
    }
    if (!existing && !own) {
      existing = await this.settingsRepo.findOne({ where: { id: 1 } });
    }

    if (existing) {
      if (own && !existing.ownerUsername) {
        existing.ownerUsername = own;
        await this.settingsRepo.save(existing);
      }
      return existing;
    }

    const maxRow = await this.settingsRepo
      .createQueryBuilder('s')
      .select('MAX(s.id)', 'max')
      .getRawOne();
    const nextId = (Number(maxRow?.max) || 0) + 1;

    return this.settingsRepo.save(
      this.settingsRepo.create({
        id: nextId,
        ownerUsername: own,
        enabled: false,
        enabledAt: null,
        maxPerHour: 30,
        aiEnabled: false,
        aiInstructions: '',
      }),
    );
  }

  async getAutoReply(ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    const s = await this.getSettings(own ?? undefined);
    const rules = await this.rulesRepo.find({
      where: own ? { ownerUsername: own } : {},
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return {
      enabled: s.enabled,
      enabledAt: s.enabledAt,
      maxPerHour: s.maxPerHour,
      dryRun: process.env.AUTO_REPLY_DRY_RUN === '1',
      ai: { available: this.ai.available, model: this.ai.model, enabled: s.aiEnabled, instructions: s.aiInstructions },
      rules,
    };
  }

  async setAutoReply(body: { enabled?: boolean; maxPerHour?: number; aiEnabled?: boolean; aiInstructions?: string }, ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    const s = await this.getSettings(own ?? undefined);
    if (own && !s.ownerUsername) s.ownerUsername = own;
    const wasActive = s.enabled || s.aiEnabled;
    if (body.aiInstructions !== undefined) {
      if (String(body.aiInstructions).length > 3000) throw new BadRequestException('The business info is too long (3000 characters max).');
      s.aiInstructions = String(body.aiInstructions);
    }
    if (typeof body.aiEnabled === 'boolean' && body.aiEnabled !== s.aiEnabled) {
      if (body.aiEnabled && !this.ai.available) throw new BadRequestException('AI is not set up: add OPENROUTER_API_KEY to backend/.env and restart.');
      s.aiEnabled = body.aiEnabled;
      this.logger.log(`AI replies for comments (${own || 'default'}) ${body.aiEnabled ? `ENABLED (model ${this.ai.model})` : 'DISABLED'}.`);
    }
    if (typeof body.maxPerHour === 'number') {
      if (!Number.isInteger(body.maxPerHour) || body.maxPerHour < 1 || body.maxPerHour > 200) {
        throw new BadRequestException('Max replies per hour must be between 1 and 200.');
      }
      s.maxPerHour = body.maxPerHour;
    }
    if (typeof body.enabled === 'boolean' && body.enabled !== s.enabled) {
      s.enabled = body.enabled;
      this.logger.log(`Keyword rules for comments (${own || 'default'}) ${body.enabled ? 'ENABLED' : 'DISABLED'}.`);
    }
    // Automation is "on" if either the rules or the AI is on. Only comments made after it turned on are answered.
    if (!wasActive && (s.enabled || s.aiEnabled)) {
      s.enabledAt = new Date();
      this.logger.log(`AUTO-REPLY ACTIVE for comments (${own || 'default'}). Only comments made after ${s.enabledAt.toLocaleTimeString()} will be answered (cap ${s.maxPerHour}/hour).`);
    } else if (wasActive && !s.enabled && !s.aiEnabled) {
      this.logger.log(`AUTO-REPLY OFF for comments (${own || 'default'}).`);
    }
    await this.settingsRepo.save(s);
    return this.getAutoReply(own ?? undefined);
  }

  private validateRule(keywords: unknown, replyText: unknown) {
    const kw = String(keywords ?? '').trim();
    const text = String(replyText ?? '').trim();
    if (!text) throw new BadRequestException('The reply text is required.');
    if (text.length > 2200) throw new BadRequestException('The reply text is too long (2200 characters max).');
    if (kw.length > 500) throw new BadRequestException('Keywords are too long (500 characters max).');
    return { keywords: kw, replyText: text };
  }

  async addRule(body: { keywords?: string; replyText?: string }, ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    const v = this.validateRule(body.keywords, body.replyText);
    const last = await this.rulesRepo.find({
      where: own ? { ownerUsername: own } : {},
      order: { sortOrder: 'DESC' },
      take: 1,
    });
    const rule = await this.rulesRepo.save(
      this.rulesRepo.create({
        ...v,
        ownerUsername: own,
        enabled: true,
        sortOrder: (last[0]?.sortOrder ?? 0) + 1,
      }),
    );
    this.logger.log(`Auto-reply rule added (${own || 'default'}): ${v.keywords ? `keywords [${v.keywords}]` : 'any comment'} -> "${preview(v.replyText, 60)}"`);
    return rule;
  }

  async updateRule(id: string, body: { keywords?: string; replyText?: string; enabled?: boolean }, ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    const rule = await this.rulesRepo.findOne({
      where: own ? { id, ownerUsername: own } : { id },
    });
    if (!rule) throw new NotFoundException('Rule not found.');
    if (body.keywords !== undefined || body.replyText !== undefined) {
      const v = this.validateRule(body.keywords ?? rule.keywords, body.replyText ?? rule.replyText);
      rule.keywords = v.keywords;
      rule.replyText = v.replyText;
    }
    if (typeof body.enabled === 'boolean') rule.enabled = body.enabled;
    return this.rulesRepo.save(rule);
  }

  async deleteRule(id: string, ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    const rule = await this.rulesRepo.findOne({
      where: own ? { id, ownerUsername: own } : { id },
    });
    if (!rule) throw new NotFoundException('Rule not found.');
    await this.rulesRepo.remove(rule);
    this.logger.log(`Auto-reply rule deleted (${own || 'default'}).`);
    return { ok: true };
  }

  // ---------- ingesting comments (webhook + polling) ----------

  // Comment webhooks: entry[].changes[{ field: 'comments', value: { id, text, from: { username }, media: { id }, parent_id? } }]
  async handleWebhook(payload: any) {
    let touched = false;
    const touchedAccounts = new Set<string>();
    // Live-stream comments are logged by the webhook controller but not stored or auto-answered.
    for (const { ownId, field, value: v } of commentEvents(payload)) {
      const id = commentId(v);
      if (field !== 'comments' || !id) continue;
      try {
        const conn = await this.connection.getConnectionByIgUserId(ownId).catch(() => null);
        const ownerUsername = conn?.username?.toLowerCase();
        if (ownerUsername) touchedAccounts.add(ownerUsername);
        const media = v.media?.id ? await this.mediaInfo(String(v.media.id), ownerUsername) : { permalink: null, thumb: null };
        await this.ingest({
          id,
          text: String(v.text ?? ''),
          username: String(v.from?.username ?? ''),
          commentedAt: new Date(),
          likeCount: 0,
          hidden: false,
          mediaId: String(v.media?.id ?? ''),
          mediaPermalink: media.permalink,
          mediaThumb: media.thumb,
          parentId: v.parent_id ? String(v.parent_id) : null,
        }, ownerUsername);
        touched = true;
      } catch (err) {
        this.logger.error(`Could not store comment event: ${(err as Error).message}`);
      }
    }
    if (touched) {
      if (touchedAccounts.size > 0) {
        for (const acc of touchedAccounts) {
          await this.processAuto(acc);
        }
      } else {
        await this.processAuto();
      }
    }
  }

  private async mediaInfo(mediaId: string, account?: string) {
    const hit = this.mediaCache.get(mediaId);
    if (hit) return hit;
    const m = await this.graph.get(`/${mediaId}`, { fields: 'permalink,thumbnail_url,media_url,caption' }, { account }).catch(() => null);
    const info = { permalink: m?.permalink ?? null, thumb: m?.thumbnail_url ?? m?.media_url ?? null, caption: String(m?.caption ?? '') };
    if (m) this.mediaCache.set(mediaId, info);
    return info;
  }

  // Returns true when the comment was new.
  private async ingest(inc: Incoming, ownerUsername?: string): Promise<boolean> {
    const existing = await this.comments.findOne({ where: { id: inc.id } });
    const own = await this.resolveOwner(ownerUsername);
    if (existing) {
      if (own && !existing.ownerUsername) {
        existing.ownerUsername = own;
      }
      if (!existing.username && inc.username) {
        existing.username = inc.username;
        existing.isOwn = !!own && inc.username.toLowerCase() === own;
      }
      existing.text = inc.text || existing.text;
      existing.likeCount = inc.likeCount;
      existing.hidden = inc.hidden;
      if (inc.ownReplyAt && !existing.repliedAt) {
        existing.repliedAt = inc.ownReplyAt;
        existing.myReply = inc.ownReplyText ?? null;
        existing.replyKind = 'external';
        if (existing.autoState === 'new') {
          existing.autoState = 'skipped';
          existing.autoNote = 'already answered on Instagram';
        }
      }
      await this.comments.save(existing);
      return false;
    }

    const isOwn = !!own && inc.username.toLowerCase() === own;
    const s = await this.getSettings(own ?? undefined);
    let autoState: Comment['autoState'] = 'new';
    let autoNote: string | null = null;
    if (isOwn) [autoState, autoNote] = ['skipped', 'our own comment'];
    else if (inc.parentId) [autoState, autoNote] = ['skipped', 'reply inside a thread'];
    else if (!(s.enabled || s.aiEnabled) || !s.enabledAt) [autoState, autoNote] = ['skipped', 'auto-reply was off'];
    else if (inc.commentedAt < s.enabledAt) [autoState, autoNote] = ['skipped', 'made before auto-reply was turned on'];
    else if (inc.ownReplyAt) [autoState, autoNote] = ['skipped', 'already answered on Instagram'];

    await this.comments.save(
      this.comments.create({
        id: inc.id,
        ownerUsername: own,
        mediaId: inc.mediaId,
        mediaPermalink: inc.mediaPermalink,
        mediaThumb: inc.mediaThumb,
        parentId: inc.parentId,
        username: inc.username,
        text: inc.text,
        commentedAt: inc.commentedAt,
        likeCount: inc.likeCount,
        hidden: inc.hidden,
        myReply: inc.ownReplyText ?? null,
        repliedAt: inc.ownReplyAt ?? null,
        replyKind: inc.ownReplyAt ? 'external' : null,
        autoState,
        autoNote,
        isOwn,
      }),
    );
    this.logger.log(
      `NEW COMMENT by @${inc.username || 'unknown'} (${own || 'default'})${inc.parentId ? ' (reply in thread)' : ''} on ${inc.mediaPermalink ?? `post ${inc.mediaId}`}: "${preview(inc.text)}"${autoState === 'new' ? ' [queued for auto-reply]' : ''}`,
    );
    return true;
  }

  // ---------- polling fallback ----------

  // Webhooks for comments can be missed (e.g. a dead tunnel URL), so also look regularly as a safety net.
  @Cron('*/30 * * * * *')
  async scheduledSync() {
    const accounts = await this.connection.listConnectedAccounts();
    if (!accounts.length) {
      await this.sync().catch((err) => this.logger.warn(`Sync failed: ${(err as Error).message}`));
    } else {
      for (const a of accounts) {
        await this.sync(a.username).catch((err) => this.logger.warn(`Sync failed for @${a.username}: ${(err as Error).message}`));
      }
    }
  }

  async sync(ownerUsername?: string) {
    if (this.syncing) return { newComments: 0, reported: 0, returned: 0 };
    const own = await this.resolveOwner(ownerUsername);
    const status: any = await this.connection.getStatus(own ?? undefined);
    if (!status.connected) return { newComments: 0, reported: 0, returned: 0 };
    this.syncing = true;
    let newComments = 0;
    let reported = 0;
    let returned = 0;
    try {
      const media = await this.graph.get('/me/media', {
        fields: 'id,permalink,thumbnail_url,media_url,caption,comments_count',
        limit: '30',
      }, { account: own ?? undefined });
      for (const m of media.data ?? []) {
        if (!m.comments_count) continue;
        reported += m.comments_count;
        const info = { permalink: m.permalink ?? null, thumb: m.thumbnail_url ?? m.media_url ?? null, caption: String(m.caption ?? '') };
        this.mediaCache.set(m.id, info);
        let page: any;
        try {
          page = await this.graph.get(`/${m.id}/comments`, {
            // `username` is only returned for our own comments; everyone else's name is inside `from`.
            fields: 'id,text,username,from{id,username},timestamp,like_count,hidden,replies{id,username,from{id,username},text,timestamp}',
            limit: '50',
          }, { account: own ?? undefined });
        } catch {
          continue; // already logged by the API client
        }
        for (const c of page.data ?? []) {
          returned += 1;
          const nameOf = (x: any) => String(x?.username ?? x?.from?.username ?? '');
          const mine = (c.replies?.data ?? []).find((r: any) => nameOf(r).toLowerCase() === status.username.toLowerCase());
          const isNew = await this.ingest({
            id: String(c.id),
            text: String(c.text ?? ''),
            username: nameOf(c),
            commentedAt: c.timestamp ? new Date(c.timestamp) : new Date(),
            likeCount: c.like_count ?? 0,
            hidden: !!c.hidden,
            mediaId: String(m.id),
            mediaPermalink: info.permalink,
            mediaThumb: info.thumb,
            parentId: null,
            ownReplyText: mine?.text ?? null,
            ownReplyAt: mine?.timestamp ? new Date(mine.timestamp) : mine ? new Date() : null,
          }, own ?? undefined);
          if (isNew) newComments += 1;
        }
      }
      if (reported > returned && Date.now() - this.lastHiddenWarning > 30 * 60 * 1000) {
        this.lastHiddenWarning = Date.now();
        this.logger.warn(
          `Instagram reports ${reported} comment(s) on recent posts for @${status.username} but only returned ${returned}. ` +
            'While the Meta app is in Development mode, the API only returns comments from accounts that have a role on the app. Make the app Live to see all customers\' comments.',
        );
      }
      if (newComments) this.logger.log(`Sync (${own || 'default'}): ${newComments} new comment(s) found`);
      await this.processAuto();
    } finally {
      this.syncing = false;
    }
    return { newComments, reported, returned };
  }

  // ---------- auto-reply ----------

  private matchKeywordRule(rules: AutoReplyRule[], text: string) {
    const t = text.toLowerCase();
    for (const r of rules.filter((x) => x.enabled && x.keywords.trim())) {
      const kws = r.keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
      if (kws.some((k) => t.includes(k))) return r;
    }
    return null;
  }

  private async captionFor(mediaId: string): Promise<string> {
    return mediaId ? (await this.mediaInfo(mediaId)).caption : '';
  }

  private async findMatchingDmRule(c: Comment): Promise<CommentDmRule | null> {
    try {
      const active = await this.commentDmRules.find({ where: { enabled: true } });
      for (const r of active) {
        if (r.mediaId && c.mediaId !== r.mediaId) continue;
        const kws = r.keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
        if (kws.length === 0 || kws.some((k) => c.text.toLowerCase().includes(k))) return r;
      }
    } catch {
      // ignore
    }
    return null;
  }

  // "Try it" in the dashboard: what would the AI say to this comment? Nothing is posted.
  async aiTest(text: string, ownerUsername?: string) {
    const s = await this.getSettings(ownerUsername);
    if (!this.ai.available) throw new BadRequestException('AI is not set up: add OPENROUTER_API_KEY to backend/.env and restart.');
    const t = String(text ?? '').trim();
    if (!t) throw new BadRequestException('Type a customer comment to test.');
    try {
      const d = await this.ai.draft({ channel: 'comment', instructions: s.aiInstructions, customerName: 'riya.styles', text: t, maxChars: 220 }, { patient: false });
      return d.kind === 'reply'
        ? { ok: true, reply: `@riya.styles ${d.text}`, model: d.model, seconds: +(d.ms / 1000).toFixed(1) }
        : { ok: true, silent: true, reason: d.reason, model: d.model, seconds: +(d.ms / 1000).toFixed(1) };
    } catch (err) {
      throw new BadGatewayException((err as Error).message);
    }
  }

  async processAuto(ownerUsername?: string) {
    const where: any = { autoState: 'new', parentId: IsNull() };
    if (ownerUsername) {
      where.ownerUsername = ownerUsername.toLowerCase();
    }
    const pending = await this.comments.find({ where, order: { commentedAt: 'ASC' }, take: 20 });
    if (!pending.length) return;

    for (const c of pending) {
      // Claim it so the webhook and the poller can never both answer the same comment.
      const claim = await this.comments.update({ id: c.id, autoState: 'new' }, { autoState: 'processing' });
      if (!claim.affected) continue;

      const own = c.ownerUsername ? c.ownerUsername.toLowerCase() : null;
      const s = await this.getSettings(own ?? undefined);
      const rules = await this.rulesRepo.find({
        where: own ? { ownerUsername: own } : {},
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      });
      const sentWhere: any = { replyKind: 'auto', repliedAt: MoreThan(new Date(Date.now() - 3600_000)) };
      if (own) sentWhere.ownerUsername = own;
      let sentLastHour = await this.comments.count({ where: sentWhere });

      if (!(s.enabled || s.aiEnabled)) {
        await this.comments.update({ id: c.id }, { autoState: 'skipped', autoNote: 'auto-reply was turned off' });
        continue;
      }
      if (sentLastHour >= s.maxPerHour) {
        await this.comments.update({ id: c.id }, { autoState: 'new' }); // try again once the hour rolls over
        this.logger.warn(`Auto-reply paused (${own || 'default'}): hourly cap of ${s.maxPerHour} reached`);
        return;
      }

      // 1. A keyword rule always wins (the owner's exact wording). 
      // 2. Otherwise AI, if it is on, writes the reply (with awareness of Comment-to-DM triggers). 
      // 3. Otherwise (or if AI stays silent / skips / errors) the catch-all rule answers.
      // 4. If Comment-to-DM matched and no other rule handled it, confirm the DM publicly.
      const fill = (t: string) => t.replaceAll('{username}', c.username || 'there');
      const keywordRule = s.enabled ? this.matchKeywordRule(rules, c.text) : null;
      const catchAll = s.enabled ? rules.find((r) => r.enabled && !r.keywords.trim()) ?? null : null;
      const matchingDmRule = await this.findMatchingDmRule(c);
      const age = Date.now() - c.commentedAt.getTime();
      let text: string;
      let note: string;

      if (keywordRule) {
        text = fill(keywordRule.replyText);
        note = `rule: ${keywordRule.keywords}`;
      } else if (s.aiEnabled && this.ai.available) {
        if (age > AI_MAX_AGE_MS) {
          if (catchAll) {
            text = fill(catchAll.replyText);
            note = 'rule: any comment (comment was old for AI)';
          } else if (matchingDmRule) {
            text = `@${c.username} Sent you a DM! Check your inbox 📥`;
            note = `comment-dm: public confirmation ("${matchingDmRule.name}")`;
          } else {
            await this.comments.update({ id: c.id }, { autoState: 'skipped', autoNote: 'too old for the AI to answer now, left for you' });
            continue;
          }
        } else {
          // Limit how often one person gets automatic replies.
          const recentAuto = await this.comments.count({
            where: { username: c.username, replyKind: 'auto', repliedAt: MoreThan(new Date(Date.now() - 3600_000)) },
          });
          if (recentAuto >= AI_MAX_PER_PERSON_PER_HOUR) {
            if (catchAll) {
              text = fill(catchAll.replyText);
              note = 'rule: any comment (hourly AI cap reached)';
            } else if (matchingDmRule) {
              text = `@${c.username} Sent you a DM! Check your inbox 📥`;
              note = `comment-dm: public confirmation ("${matchingDmRule.name}")`;
            } else {
              await this.comments.update({ id: c.id }, { autoState: 'skipped', autoNote: `already auto-replied to @${c.username} ${recentAuto} times in the last hour` });
              continue;
            }
          } else {
            try {
              const caption = await this.captionFor(c.mediaId).catch(() => '');
              let context = caption ? `The post they commented on has this caption: ${caption.replace(/\s+/g, ' ').slice(0, 300)}` : '';
              if (matchingDmRule) {
                context += (context ? '\n' : '') + `A Comment-to-DM automation ("${matchingDmRule.name}") matched. A private DM with the requested link/details is already being sent to @${c.username}. Acknowledge their comment and warmly tell them to check their DMs or inbox.`;
              }
              const d = await this.ai.draft({
                channel: 'comment',
                instructions: s.aiInstructions,
                customerName: c.username || 'there',
                text: c.text,
                context,
                maxChars: 220,
              });
              if (d.kind === 'skip') {
                if (catchAll) {
                  this.logger.log(`Auto-reply: AI stayed silent (${d.reason}), using catch-all rule instead`);
                  text = fill(catchAll.replyText);
                  note = `rule: any comment (AI silent: ${d.reason})`;
                } else if (matchingDmRule) {
                  text = `@${c.username} Sent you a DM! Check your inbox 📥`;
                  note = `comment-dm: public confirmation ("${matchingDmRule.name}")`;
                } else {
                  await this.comments.update({ id: c.id }, { autoState: 'skipped', autoNote: `AI stayed silent: ${d.reason}` });
                  this.logger.log(`Auto-reply: AI stayed silent for @${c.username}'s comment (${d.reason})`);
                  continue;
                }
              } else {
                text = /^@/.test(d.text) ? d.text : `@${c.username} ${d.text}`;
                note = `AI (${d.model}, ${(d.ms / 1000).toFixed(1)}s)`;
              }
            } catch (err) {
              if (catchAll) {
                this.logger.warn(`${(err as Error).message}; using the catch-all rule instead`);
                text = fill(catchAll.replyText);
                note = 'AI unavailable, used the catch-all rule';
              } else if (matchingDmRule) {
                text = `@${c.username} Sent you a DM! Check your inbox 📥`;
                note = `comment-dm: public confirmation ("${matchingDmRule.name}")`;
              } else {
                await this.comments.update({ id: c.id }, { autoState: 'new' });
                this.logger.warn(`${(err as Error).message}. The comment will be retried for up to ${AI_MAX_AGE_MS / 60000} minutes.`);
                continue;
              }
            }
          }
        }
      } else if (catchAll) {
        text = fill(catchAll.replyText);
        note = 'rule: any comment';
      } else if (matchingDmRule) {
        text = `@${c.username} Sent you a DM! Check your inbox 📥`;
        note = `comment-dm: public confirmation ("${matchingDmRule.name}")`;
      } else {
        await this.comments.update({ id: c.id }, { autoState: 'skipped', autoNote: 'no matching rule' });
        this.logger.log(`Auto-reply: no rule matches @${c.username}'s comment, left for you`);
        continue;
      }

      // Check if duplicate on the SAME media within the last 15 minutes:
      const duplicateRecent = await this.comments.exists({
        where: {
          username: c.username,
          mediaId: c.mediaId,
          myReply: text,
          repliedAt: MoreThan(new Date(Date.now() - 15 * 60_000)),
        },
      });
      if (duplicateRecent) {
        const variations = ['✨', '💛', '🙌', '📥', '📩'];
        const chosen = variations[Math.floor(Math.random() * variations.length)];
        text = `${text.replace(/[✨💛🙌📥📩]+$/, '').trim()} ${chosen}`;
      }

      this.logger.log(`Auto-reply: ${note} for @${c.username}'s comment`);
      if (process.env.AUTO_REPLY_DRY_RUN === '1') {
        await this.comments.update({ id: c.id }, { autoState: 'done', autoNote: `dry run, not posted (${note}): ${text}` });
        this.logger.log(`REPLIED (auto) to @${c.username}: "${preview(text)}" [DRY RUN, not posted]`);
        continue;
      }
      try {
        c.autoState = 'done';
        c.autoNote = note;
        await this.sendReply(c, text, 'auto');
        sentLastHour += 1;
      } catch (err) {
        // Deliberately not retried: a failing reply must never turn into a reply storm.
        await this.comments.update({ id: c.id }, { autoState: 'failed', autoNote: (err as Error).message });
        this.logger.warn(`Auto-reply to @${c.username} FAILED (will not retry): ${(err as Error).message}`);
      }
    }
  }

  private async getOrThrow(id: string) {
    const c = await this.comments.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Comment not found.');
    return c;
  }
}
