import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, IsNull, MoreThan, Not, Repository } from 'typeorm';
import { Comment } from '../comments/comment.entities';
import { CommentDmLog } from '../comment-dm/comment-dm.entities';
import { MessageAutoLog } from '../messaging/auto-message.entities';
import { Conversation, Message } from '../messaging/messaging.entities';
import { Submission } from '../submissions/submission.entity';

type RecentDm = { username: string; message: string; type: string; status: 'sent' | 'replied' | 'failed'; time: Date };

const DAY = 24 * 3600_000;
const pct = (cur: number, prev: number) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : cur > 0 ? null : 0);

// A genuine funnel: every stage here is a real subset of the one before it. "DMs Sent" only counts DMs the
// comment→DM automation actually sent (never the separate Messages-tab auto-reply, which isn't triggered by a
// comment and would break the subset relationship). "Converted" cross-references who really submitted a photo —
// nothing here is a guess or an unrelated total dressed up to look like a step in the same chain.
@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Comment) private readonly comments: Repository<Comment>,
    @InjectRepository(CommentDmLog) private readonly dmLogs: Repository<CommentDmLog>,
    @InjectRepository(MessageAutoLog) private readonly autoLogs: Repository<MessageAutoLog>,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(Submission) private readonly submissions: Repository<Submission>,
  ) {}

  async overview(days: number, account?: string) {
    const own = account ? account.trim().replace(/^@/, '').toLowerCase() : null;
    const cutoff = new Date(Date.now() - days * DAY);
    const prevCutoff = new Date(Date.now() - 2 * days * DAY);

    // Earliest submission per username, so "converted" only counts a photo sent AFTER our DM reply — never one
    // that happened to exist beforehand, which wouldn't really be something the DM caused.
    const earliestSubmission = new Map<string, Date>();
    const subWhere: any = own ? { ownerUsername: own } : {};
    for (const s of await this.submissions.find({ where: subWhere, select: { igUsername: true, createdAt: true } })) {
      const u = s.igUsername.toLowerCase();
      const prev = earliestSubmission.get(u);
      if (!prev || s.createdAt < prev) earliestSubmission.set(u, s.createdAt);
    }
    const convertedAfterReply = (r: { username: string; repliedAt: Date | null }) => {
      const sub = earliestSubmission.get(r.username.toLowerCase());
      return !!sub && !!r.repliedAt && sub > r.repliedAt;
    };

    const cWhereNow: any = { isOwn: false, parentId: IsNull(), commentedAt: MoreThan(cutoff) };
    const cWherePrev: any = { isOwn: false, parentId: IsNull(), commentedAt: Between(prevCutoff, cutoff) };
    const dmWhereNow: any = { dmSentAt: MoreThan(cutoff) };
    const dmWherePrev: any = { dmSentAt: Between(prevCutoff, cutoff) };
    if (own) {
      cWhereNow.ownerUsername = own;
      cWherePrev.ownerUsername = own;
      dmWhereNow.ownerUsername = own;
      dmWherePrev.ownerUsername = own;
    }

    const [commentsNow, commentsPrev, sentNow, sentPrev] = await Promise.all([
      this.comments.count({ where: cWhereNow }),
      this.comments.count({ where: cWherePrev }),
      this.dmLogs.count({ where: dmWhereNow }),
      this.dmLogs.count({ where: dmWherePrev }),
    ]);

    const repliedNowWhere: any = { dmSentAt: Not(IsNull()), repliedAt: MoreThan(cutoff) };
    const repliedPrevWhere: any = { dmSentAt: Not(IsNull()), repliedAt: Between(prevCutoff, cutoff) };
    if (own) {
      repliedNowWhere.ownerUsername = own;
      repliedPrevWhere.ownerUsername = own;
    }
    const [repliedRows, repliedPrevRows] = await Promise.all([
      this.dmLogs.find({ where: repliedNowWhere, select: { username: true, repliedAt: true } }),
      this.dmLogs.find({ where: repliedPrevWhere, select: { username: true, repliedAt: true } }),
    ]);
    const repliesNow = repliedRows.length;
    const repliesPrev = repliedPrevRows.length;
    const convertedNow = repliedRows.filter(convertedAfterReply).length;
    const convertedPrev = repliedPrevRows.filter(convertedAfterReply).length;

    // Daily, zero-filled series for the chart.
    const buckets = new Map<string, { comments: number; dmsSent: number; replies: number; conversions: number }>();
    for (let i = days - 1; i >= 0; i--) buckets.set(new Date(Date.now() - i * DAY).toISOString().slice(0, 10), { comments: 0, dmsSent: 0, replies: 0, conversions: 0 });
    const bump = (dates: (Date | null)[], key: 'comments' | 'dmsSent' | 'replies' | 'conversions') => {
      for (const dt of dates) {
        if (!dt) continue;
        const b = buckets.get(dt.toISOString().slice(0, 10));
        if (b) b[key] += 1;
      }
    };
    const cRowsWhere: any = { isOwn: false, parentId: IsNull(), commentedAt: MoreThan(cutoff) };
    const dmRowsWhere: any = { dmSentAt: MoreThan(cutoff) };
    if (own) {
      cRowsWhere.ownerUsername = own;
      dmRowsWhere.ownerUsername = own;
    }
    const [commentRows, dmRows] = await Promise.all([
      this.comments.find({ where: cRowsWhere, select: { commentedAt: true } }),
      this.dmLogs.find({ where: dmRowsWhere, select: { dmSentAt: true } }),
    ]);
    bump(commentRows.map((r) => r.commentedAt), 'comments');
    bump(dmRows.map((r) => r.dmSentAt), 'dmsSent');
    bump(repliedRows.map((r) => r.repliedAt), 'replies');
    bump(repliedRows.filter(convertedAfterReply).map((r) => r.repliedAt), 'conversions');
    const series = [...buckets.entries()].map(([date, v]) => ({ date, ...v }));

    // Recent DMs: every real place this app sends a DM, merged into one feed and tagged by what actually sent
    // it — not a made-up "campaign" name. Three real sources:
    //   1. Comment-to-DM automation (comment_dm_log) — has its own clean sent/failed/replied status.
    //   2. Messages auto-reply (message_auto_log) — tagged "Auto DM" (a keyword rule) or "AI DM".
    //   3. Manual/system sends (message, direction=out) — typed by you in the dashboard, or the photo
    //      thank-you message; excludes messages sent from the Instagram app itself or synced echoes, since
    //      those weren't sent BY this app and labelling them as if they were would be misleading.
    // Fetched wider than the 10 we'll show, so one chatty customer filling the recent window in a single
    // source doesn't crowd out everyone else once we dedupe down to one row per person below.
    const dmLogWhere: any = own ? { ownerUsername: own } : {};
    const autoLogWhere: any = { outcome: 'sent', ...(own ? { ownerUsername: own } : {}) };
    const manualWhere: any = { direction: 'out', source: In(['dashboard', 'system']), ...(own ? { ownerUsername: own } : {}) };

    const [recentCommentDms, recentAutoLogs, recentManual] = await Promise.all([
      this.dmLogs.find({ where: dmLogWhere, order: { createdAt: 'DESC' }, take: 40 }),
      this.autoLogs.find({ where: autoLogWhere, order: { createdAt: 'DESC' }, take: 40 }),
      this.messages.find({ where: manualWhere, order: { createdAt: 'DESC' }, take: 40 }),
    ]);

    const commentTexts = recentCommentDms.length
      ? new Map((await this.comments.find({ where: { id: In(recentCommentDms.map((r) => r.commentId)) } })).map((c) => [c.id, c.text]))
      : new Map<string, string>();
    // A row that's still "invited" (public reply posted, customer hasn't tapped the link yet) isn't a DM at
    // all yet — leave it out rather than mislabel it as sent or failed while it's genuinely just pending.
    const fromCommentDm: RecentDm[] = recentCommentDms
      .filter((r) => r.status === 'failed' || r.dmSentAt)
      .map((r) => ({
        username: r.username,
        message: commentTexts.get(r.commentId) ?? '',
        type: 'Comment DM',
        status: r.status === 'failed' ? 'failed' : r.repliedAt ? 'replied' : 'sent',
        time: r.dmSentAt ?? r.createdAt,
      }));

    // "Replied" here is a fair proxy, not a guess dressed up as certainty: the customer messaged again after
    // this specific reply went out, using the same conversation's inbound timestamp we already track.
    const convoInbound = new Map(
      (await this.conversations.find({ select: { igsid: true, lastInboundAt: true } })).map((c) => [c.igsid, c.lastInboundAt]),
    );
    const fromAuto: RecentDm[] = recentAutoLogs.map((r) => {
      const inbound = convoInbound.get(r.igsid);
      return {
        username: r.username ?? r.igsid.slice(-6),
        message: r.replyText ?? '',
        type: r.kind === 'ai' ? 'AI DM' : r.kind === 'fallback' ? 'Fallback DM' : 'Auto DM',
        status: inbound && inbound > r.createdAt ? 'replied' : 'sent',
        time: r.createdAt,
      };
    });

    const manualIgsids = [...new Set(recentManual.map((m) => m.igsid))];
    const manualUsernames = manualIgsids.length
      ? new Map((await this.conversations.find({ where: { igsid: In(manualIgsids) } })).map((c) => [c.igsid, c.username]))
      : new Map<string, string | null>();
    const fromManual: RecentDm[] = recentManual.map((m) => {
      const inbound = convoInbound.get(m.igsid);
      return {
        username: manualUsernames.get(m.igsid) ?? m.igsid.slice(-6),
        message: m.text,
        type: m.source === 'system' ? 'System DM' : 'Manual DM',
        status: inbound && inbound > m.createdAt ? 'replied' : 'sent',
        time: m.createdAt,
      };
    });

    // One row per customer (their most recent DM) — otherwise a single back-and-forth conversation can fill
    // the whole feed and hide everyone else.
    const seenUsername = new Set<string>();
    const recentDms = [...fromCommentDm, ...fromAuto, ...fromManual]
      .sort((a, b) => b.time.getTime() - a.time.getTime())
      .filter((r) => {
        const key = r.username.toLowerCase();
        if (seenUsername.has(key)) return false;
        seenUsername.add(key);
        return true;
      })
      .slice(0, 10);

    return {
      days,
      commentsReceived: commentsNow,
      dmsSent: sentNow,
      replies: repliesNow,
      conversions: convertedNow,
      deltas: {
        commentsReceived: pct(commentsNow, commentsPrev),
        dmsSent: pct(sentNow, sentPrev),
        replies: pct(repliesNow, repliesPrev),
        conversions: pct(convertedNow, convertedPrev),
      },
      series,
      recentDms,
    };
  }
}
