import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import { AiService } from '../ai/ai.service';
import { InstagramConnectionService } from '../instagram-connection/instagram-connection.service';
import { MessageAutoLog, MessageAutoRule, MessageAutoSetting } from './auto-message.entities';
import { CommentDmLog } from '../comment-dm/comment-dm.entities';
import { Conversation, Message } from './messaging.entities';
import { MessagingService } from './messaging.service';

const HOUR = 3600_000;
const WINDOW_GUARD_MS = 23 * HOUR; // Instagram allows replies for 24h; leave a safety margin
const AI_MAX_AGE_MS = 45 * 60_000; // a late AI answer to an old message reads oddly; leave those for a person
// Accounts that must never receive an automatic reply.
const ALWAYS_IGNORED = ['meta.ai'];
const DEFAULT_FALLBACK_TEXT = "Thanks for reaching out! We've got your message and someone from our team will get back to you shortly. 🙏";

const preview = (t: string, n = 60) => (t.length > n ? `${t.slice(0, n)}…` : t);

type Decision =
  | { outcome: 'sent' | 'skipped' | 'failed'; note: string; replyText?: string; kind?: 'rule' | 'ai' | 'fallback' }
  | 'retry-later' // hourly cap reached: stop for now
  | 'retry-ai'; // the AI is unavailable or this person needs a moment: try this message again on a later tick

@Injectable()
export class AutoMessageService {
  private readonly logger = new Logger('AutoMessage');
  private running = false;
  private lastCapWarning = 0;
  private lastAiWarning = 0;

  constructor(
    @InjectRepository(MessageAutoSetting) private readonly settingsRepo: Repository<MessageAutoSetting>,
    @InjectRepository(MessageAutoRule) private readonly rulesRepo: Repository<MessageAutoRule>,
    @InjectRepository(MessageAutoLog) private readonly logs: Repository<MessageAutoLog>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(CommentDmLog) private readonly commentDmLogs: Repository<CommentDmLog>,
    private readonly messaging: MessagingService,
    private readonly connection: InstagramConnectionService,
    private readonly ai: AiService,
  ) {}

  // ---------- settings & rules ----------

  private async resolveOwner(ownerUsername?: string): Promise<string | null> {
    if (ownerUsername) return ownerUsername.trim().replace(/^@/, '').toLowerCase();
    const status: any = await this.connection.getStatus().catch(() => null);
    return status?.connected && status?.username ? String(status.username).trim().toLowerCase() : null;
  }

  private async getSettings(ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    let existing: MessageAutoSetting | null = null;
    if (own) {
      existing = await this.settingsRepo
        .createQueryBuilder('s')
        .where('LOWER(s.ownerUsername) = :own', { own })
        .getOne();
    }

    if (existing) {
      if (own && !existing.ownerUsername) {
        existing.ownerUsername = own;
        await this.settingsRepo.save(existing);
      }
      if (!existing.fallbackText.trim()) {
        existing.fallbackText = DEFAULT_FALLBACK_TEXT;
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
        fallbackEnabled: true,
        fallbackText: DEFAULT_FALLBACK_TEXT,
      }),
    );
  }

  private get dryRun() {
    return process.env.AUTO_REPLY_DRY_RUN === '1';
  }

  async getAutoReply(ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    const s = await this.getSettings(own ?? undefined);
    const rules = own
      ? await this.rulesRepo
          .createQueryBuilder('r')
          .where('LOWER(r.ownerUsername) = :own', { own })
          .orderBy('r.sortOrder', 'ASC')
          .addOrderBy('r.createdAt', 'ASC')
          .getMany()
      : [];
    return {
      enabled: s.enabled,
      enabledAt: s.enabledAt,
      maxPerHour: s.maxPerHour,
      dryRun: this.dryRun,
      ai: {
        available: this.ai.available,
        model: this.ai.model,
        enabled: s.aiEnabled,
        instructions: s.aiInstructions,
        pausedUntil: this.ai.pausedUntilDate,
        fallbackEnabled: s.fallbackEnabled,
        fallbackText: s.fallbackText,
      },
      rules,
    };
  }

  async setAutoReply(
    body: {
      enabled?: boolean;
      maxPerHour?: number;
      aiEnabled?: boolean;
      aiInstructions?: string;
      fallbackEnabled?: boolean;
      fallbackText?: string;
    },
    ownerUsername?: string,
  ) {
    const own = await this.resolveOwner(ownerUsername);
    const s = await this.getSettings(own ?? undefined);
    if (own && !s.ownerUsername) s.ownerUsername = own;
    const wasActive = s.enabled || s.aiEnabled;

    if (body.aiInstructions !== undefined) {
      if (String(body.aiInstructions).length > 3000) throw new BadRequestException('The business info is too long (3000 characters max).');
      s.aiInstructions = String(body.aiInstructions);
    }
    if (typeof body.fallbackEnabled === 'boolean') s.fallbackEnabled = body.fallbackEnabled;
    if (body.fallbackText !== undefined) {
      const text = String(body.fallbackText).trim();
      if (!text) throw new BadRequestException('The holding message is required.');
      if (text.length > 500) throw new BadRequestException('The holding message is too long (500 characters max).');
      s.fallbackText = text;
    }
    if (typeof body.aiEnabled === 'boolean' && body.aiEnabled !== s.aiEnabled) {
      if (body.aiEnabled && !this.ai.available) throw new BadRequestException('AI is not set up: add OPENROUTER_API_KEY to backend/.env and restart.');
      s.aiEnabled = body.aiEnabled;
      this.logger.log(`AI replies for messages (${own || 'default'}) ${body.aiEnabled ? `ENABLED (model ${this.ai.model})` : 'DISABLED'}.`);
    }
    const num = (v: unknown, min: number, max: number, label: string) => {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
        throw new BadRequestException(`${label} must be a whole number from ${min} to ${max}.`);
      }
      return v;
    };
    if (body.maxPerHour !== undefined) s.maxPerHour = num(body.maxPerHour, 1, 200, 'Max replies per hour');
    if (typeof body.enabled === 'boolean' && body.enabled !== s.enabled) {
      s.enabled = body.enabled;
      this.logger.log(`Keyword rules for messages (${own || 'default'}) ${body.enabled ? 'ENABLED' : 'DISABLED'}.`);
    }

    // Automation is "on" if either the rules or the AI is on. Only messages after it turned on are answered.
    if (!wasActive && (s.enabled || s.aiEnabled)) {
      s.enabledAt = new Date();
      this.logger.log(
        `AUTO-REPLY ACTIVE for messages (${own || 'default'})${this.dryRun ? ' (DRY RUN: nothing will actually be sent)' : ''}. Only messages received after ${s.enabledAt.toLocaleTimeString()} will be answered.`,
      );
    } else if (wasActive && !s.enabled && !s.aiEnabled) {
      this.logger.log(`AUTO-REPLY OFF for messages (${own || 'default'}).`);
    }
    await this.settingsRepo.save(s);
    return this.getAutoReply(own ?? undefined);
  }

  private validateRule(keywords: unknown, replyText: unknown) {
    const kw = String(keywords ?? '').trim();
    const text = String(replyText ?? '').trim();
    if (!text) throw new BadRequestException('The reply text is required.');
    if (text.length > 1000) throw new BadRequestException('The reply text is too long (1000 characters max for a message).');
    if (kw.length > 500) throw new BadRequestException('Keywords are too long (500 characters max).');
    return { keywords: kw, replyText: text };
  }

  async addRule(body: { keywords?: string; replyText?: string }, ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    if (!own) throw new BadRequestException('Connected Instagram account required to add automation rules.');
    const v = this.validateRule(body.keywords, body.replyText);
    const last = await this.rulesRepo
      .createQueryBuilder('r')
      .where('LOWER(r.ownerUsername) = :own', { own })
      .orderBy('r.sortOrder', 'DESC')
      .take(1)
      .getOne();
    const rule = await this.rulesRepo.save(
      this.rulesRepo.create({
        ...v,
        ownerUsername: own,
        enabled: true,
        sortOrder: (last?.sortOrder ?? 0) + 1,
      }),
    );
    this.logger.log(`Message rule added (${own}): ${v.keywords ? `keywords [${v.keywords}]` : 'any message'} -> "${preview(v.replyText)}"`);
    return rule;
  }

  async updateRule(id: string, body: { keywords?: string; replyText?: string; enabled?: boolean }, ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    if (!own) throw new NotFoundException('Rule not found.');
    const rule = await this.rulesRepo
      .createQueryBuilder('r')
      .where('r.id = :id AND LOWER(r.ownerUsername) = :own', { id, own })
      .getOne();
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
    if (!own) throw new NotFoundException('Rule not found.');
    const rule = await this.rulesRepo
      .createQueryBuilder('r')
      .where('r.id = :id AND LOWER(r.ownerUsername) = :own', { id, own })
      .getOne();
    if (!rule) throw new NotFoundException('Rule not found.');
    await this.rulesRepo.remove(rule);
    this.logger.log(`Message rule deleted (${own}).`);
    return { ok: true };
  }

  async recent(ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    if (!own) return [];
    return this.logs
      .createQueryBuilder('l')
      .where('LOWER(l.ownerUsername) = :own', { own })
      .orderBy('l.createdAt', 'DESC')
      .take(50)
      .getMany();
  }

  // ---------- doing the work ----------

  // The webhook calls processPending() right after storing a message. This timer is the safety net for when
  // the webhook misses one: it pulls from Instagram AND processes replies in the same pass, back to back, so a
  // message caught by the fallback sync isn't left waiting for a separately-timed tick on top of that.
  @Cron('*/10 * * * * *')
  async tick() {
    const accounts = await this.connection.listConnectedAccounts().catch(() => []);
    if (accounts.length === 0) {
      await this.messaging.syncFromInstagram().catch((err) => this.logger.warn(`Fallback sync failed: ${(err as Error).message}`));
      await this.processPending().catch((err) => this.logger.error(`Processing failed: ${(err as Error).message}`));
    } else {
      for (const acc of accounts) {
        await this.messaging.syncFromInstagram(acc.username).catch((err) => this.logger.warn(`Fallback sync failed for @${acc.username}: ${(err as Error).message}`));
        await this.processPending(acc.username).catch((err) => this.logger.error(`Processing failed for @${acc.username}: ${(err as Error).message}`));
      }
    }
  }

  async processPending(ownerUsername?: string) {
    if (this.running) return;
    this.running = true;
    try {
      // A claim that never finished (for example the backend restarted in the middle of it) must not stay open
      // forever. It is closed rather than retried, because we cannot know whether the reply had already gone out.
      await this.logs.update(
        { outcome: 'processing', createdAt: LessThan(new Date(Date.now() - 10 * 60_000)) },
        { outcome: 'failed', note: 'interrupted while processing; not retried, to avoid replying twice' },
      );
      const s = await this.getSettings(ownerUsername);
      if (!(s.enabled || s.aiEnabled) || !s.enabledAt) return;
      const own = await this.resolveOwner(ownerUsername);

      const qb = this.messages
        .createQueryBuilder('m')
        .where("m.direction = 'in'")
        .andWhere('m.createdAt >= :since', { since: s.enabledAt })
        .andWhere('NOT EXISTS (SELECT 1 FROM message_auto_log l WHERE l.message_id = CAST(m.id AS text))');

      if (own) {
        qb.andWhere('LOWER(m.ownerUsername) = :own', { own });
      }

      const pending = await qb
        .orderBy('m.createdAt', 'ASC')
        .limit(20)
        .getMany();
      if (!pending.length) return;
      const rules = await this.rulesRepo.find({
        where: own ? { ownerUsername: own } : {},
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      });

      const deadline = Date.now() + 90_000; // the AI can be slow; whatever is left is picked up on the next tick
      for (const m of pending) {
        if (Date.now() > deadline) break;
        // Claim the message first: the unique id means only one worker can ever answer it.
        try {
          await this.logs.insert({ messageId: m.id, igsid: m.igsid, ownerUsername: own, outcome: 'processing' });
        } catch {
          continue;
        }
        const conv = await this.conversations.findOne({
          where: own ? { igsid: m.igsid, ownerUsername: own } : { igsid: m.igsid },
        });
        let decision: Decision;
        try {
          decision = await this.decide(m, conv, s, rules, own);
        } catch (err) {
          decision = { outcome: 'failed', note: (err as Error).message };
        }
        if (decision === 'retry-later') {
          await this.logs.delete({ messageId: m.id }); // release it; try again once the hourly cap has room
          return;
        }
        if (decision === 'retry-ai') {
          await this.logs.delete({ messageId: m.id }); // nothing was sent, so it is safe to try again later
          continue;
        }
        await this.logs.update(
          { messageId: m.id },
          {
            outcome: decision.outcome,
            note: decision.note,
            replyText: decision.replyText ?? null,
            username: conv?.username ?? null,
            kind: decision.kind ?? 'rule',
          },
        );
        const who = conv?.username ? `@${conv.username}` : m.igsid;
        if (decision.outcome === 'sent') {
          const label = decision.kind === 'ai' ? ', AI' : decision.kind === 'fallback' ? ', fallback' : '';
          this.logger.log(`REPLIED (auto${label}) to ${who}: "${preview(decision.replyText ?? '')}"${this.dryRun ? ' [DRY RUN, not sent]' : ''}`);
        }
        else if (decision.outcome === 'failed') this.logger.warn(`Auto-reply to ${who} FAILED (will not retry): ${decision.note}`);
        else this.logger.log(`Auto-reply skipped for ${who}: ${decision.note}`);
      }
    } finally {
      this.running = false;
    }
  }

  private async decide(m: Message, conv: Conversation | null, s: MessageAutoSetting, rules: MessageAutoRule[], own: string | null): Promise<Decision> {
    const username = (conv?.username ?? '').toLowerCase();
    const skip = (note: string): Decision => ({ outcome: 'skipped', note });
    const rulesOn = s.enabled;
    const aiOn = s.aiEnabled && this.ai.available;
    if (!rulesOn && !aiOn) return skip('automation is off');

    // ---- Guards that apply to every automatic reply, whoever writes it ----
    if (own && username === own) return skip('our own account');
    // Guard against replying to ANY connected tenant in the platform to prevent bot-to-bot loops
    const connectedAccounts = await this.connection.listConnectedAccounts().catch(() => []);
    const connectedUsernames = connectedAccounts.map((a) => a.username.toLowerCase());
    if (username && connectedUsernames.includes(username)) {
      return skip(`sender is another connected tenant account (@${username})`);
    }
    const ignored = [...ALWAYS_IGNORED, ...(process.env.AUTO_REPLY_IGNORE_USERNAMES ?? '').split(',')]
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (username && ignored.includes(username)) return skip('account is on the ignore list');

    const text = m.text.trim();
    if (!text || /^\[.*\]$/.test(text)) return skip('no text to answer (attachment or system message)');
    if (Date.now() - m.createdAt.getTime() > WINDOW_GUARD_MS) return skip("outside Instagram's 24-hour window");

    // Do not auto-reply to users who are in the middle of a follow-gate verification,
    // or who clicked the "I'm following ✅" button / sent follow confirmation.
    if (
      text === 'CONFIRM_FOLLOW' ||
      text.toLowerCase().includes('following') ||
      (await this.commentDmLogs.exists({ where: { igsid: m.igsid, pendingFollowGate: true } }))
    ) {
      return skip('pending follow-gate verification');
    }

    // Someone already answered after this message: nothing left for automation to do.
    const answeredWhere: any = { igsid: m.igsid, direction: 'out', createdAt: MoreThan(m.createdAt) };
    if (own) answeredWhere.ownerUsername = own;
    if (await this.messages.exists({ where: answeredWhere })) {
      return skip('already answered');
    }
    // Global hourly cap per tenant account (rules and AI together).
    const capWhere: any = { outcome: 'sent', createdAt: MoreThan(new Date(Date.now() - HOUR)) };
    if (own) capWhere.ownerUsername = own;
    const sentLastHour = await this.logs.count({ where: capWhere });
    if (sentLastHour >= s.maxPerHour) {
      if (Date.now() - this.lastCapWarning > 10 * 60_000) {
        this.lastCapWarning = Date.now();
        this.logger.warn(`Auto-reply paused: hourly cap of ${s.maxPerHour} reached`);
      }
      return 'retry-later';
    }

    // ---- Who writes the reply ----
    // 1. A keyword rule (only while rules are switched on) always wins: it is the owner's exact wording.
    // 2. Otherwise, if AI is on, it writes the reply, or stays silent when unsure. This works with rules off or no rules at all.
    // 3. Otherwise the catch-all rule (only while rules are on) answers.
    const name = conv?.username || 'there';
    const fill = (t: string) => t.replaceAll('{username}', name);
    const keywordRule = rulesOn ? this.matchKeywordRule(rules, text) : null;
    const catchAll = rulesOn ? rules.find((r) => r.enabled && !r.keywords.trim()) ?? null : null;

    const viaRule = (rule: MessageAutoRule, label: string): Promise<Decision> => this.deliver(m, fill(rule.replyText), label, 'rule', own);

    if (keywordRule) return viaRule(keywordRule, `rule: ${keywordRule.keywords}`);

    if (aiOn) {
      const age = Date.now() - m.createdAt.getTime();
      if (age > AI_MAX_AGE_MS) return skip('too old for the AI to answer now, left for a person');

      try {
        const d = await this.ai.draft({
          channel: 'message',
          instructions: s.aiInstructions,
          customerName: name,
          text,
          context: await this.threadContext(m),
          maxChars: 500,
        });
        if (d.kind === 'skip') {
          // The AI declined to answer the actual question, but staying completely silent reads as being
          // ignored. Send a short holding reply instead (unless turned off) — it doesn't answer anything,
          // just acknowledges the message so a person can follow up without the customer wondering if it
          // was even seen.
          if (s.fallbackEnabled && s.fallbackText.trim()) {
            return this.deliver(m, fill(s.fallbackText), `AI stayed silent (${d.reason}); sent the holding reply instead`, 'fallback', own);
          }
          return skip(`AI stayed silent: ${d.reason}`);
        }
        return this.deliver(m, d.text, `AI (${d.model}, ${(d.ms / 1000).toFixed(1)}s)`, 'ai', own);
      } catch (err) {
        // The AI service is down or rate limited. Nothing has been sent, so this is safe to retry.
        if (catchAll) {
          this.logger.warn(`${(err as Error).message}; using the catch-all rule instead`);
          return viaRule(catchAll, 'AI unavailable, used the catch-all rule');
        }
        if (Date.now() - this.lastAiWarning > 5 * 60_000) {
          this.lastAiWarning = Date.now();
          this.logger.warn(`${(err as Error).message}. Messages wait and are retried for up to ${AI_MAX_AGE_MS / 60000} minutes.`);
        }
        return 'retry-ai';
      }
    }

    if (catchAll) return viaRule(catchAll, 'rule: any message');
    return skip('no matching rule');
  }

  // Sends the reply, or in dry-run mode only reports it. Throws on failure; the caller records it and does not retry.
  private async deliver(m: Message, reply: string, note: string, kind: 'rule' | 'ai' | 'fallback', own?: string | null): Promise<Decision> {
    if (this.dryRun) return { outcome: 'sent', note: `dry run, not actually sent (${note})`, replyText: reply, kind };
    await this.messaging.send(m.igsid, reply, 'auto', undefined, undefined, own ?? m.ownerUsername ?? undefined);
    return { outcome: 'sent', note, replyText: reply, kind };
  }

  private matchKeywordRule(rules: MessageAutoRule[], text: string) {
    const t = text.toLowerCase();
    for (const r of rules.filter((x) => x.enabled && x.keywords.trim())) {
      const kws = r.keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
      if (kws.some((k) => t.includes(k))) return r;
    }
    return null;
  }

  // The last few messages before this one, so the AI understands what the customer is replying to.
  private async threadContext(m: Message) {
    const priorWhere: any = { igsid: m.igsid, createdAt: LessThan(m.createdAt) };
    if (m.ownerUsername) priorWhere.ownerUsername = m.ownerUsername;
    const prior = await this.messages.find({
      where: priorWhere,
      order: { createdAt: 'DESC' },
      take: 6,
    });
    if (!prior.length) return '';
    const lines = prior
      .reverse()
      .filter((x) => x.text.trim() && !/^\[.*\]$/.test(x.text.trim()))
      .map((x) => `${x.direction === 'in' ? 'Customer' : 'Business'}: ${x.text.replace(/\s+/g, ' ').slice(0, 300)}`);
    return lines.length ? `Recent conversation (oldest first):\n${lines.join('\n')}` : '';
  }

  // "Try it" in the dashboard: shows what the AI would say, without sending anything.
  async aiTest(text: string) {
    const s = await this.getSettings();
    if (!this.ai.available) throw new BadRequestException('AI is not set up: add OPENROUTER_API_KEY to backend/.env and restart.');
    const t = String(text ?? '').trim();
    if (!t) throw new BadRequestException('Type a customer message to test.');
    try {
      const d = await this.ai.draft({ channel: 'message', instructions: s.aiInstructions, customerName: 'riya.styles', text: t, maxChars: 500 }, { patient: false });
      return d.kind === 'reply'
        ? { ok: true, reply: d.text, model: d.model, seconds: +(d.ms / 1000).toFixed(1) }
        : { ok: true, silent: true, reason: d.reason, model: d.model, seconds: +(d.ms / 1000).toFixed(1) };
    } catch (err) {
      throw new BadGatewayException((err as Error).message);
    }
  }
}
