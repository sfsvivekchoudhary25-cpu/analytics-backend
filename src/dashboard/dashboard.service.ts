import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, IsNull, MoreThan, Not, Repository } from 'typeorm';
import { Comment } from '../comments/comment.entities';
import { CommentDmLog } from '../comment-dm/comment-dm.entities';
import { Submission } from '../submissions/submission.entity';

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
    };
  }
}
