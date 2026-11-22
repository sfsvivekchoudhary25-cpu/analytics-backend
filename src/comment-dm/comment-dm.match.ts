import type { CommentDmLog, CommentDmRule } from './comment-dm.entities';

// The ONE place that decides which Comment-to-DM automation (if any) answers a comment. The DM sender and the
// public auto-reply both use it, so they can never disagree about whether a DM is on its way.

// Comments from this long before a rule was switched on still count, to catch test comments posted just before.
const GRACE_MS = 10 * 60_000;
// How long the public reply waits for the DM to be sent before giving up on promising one.
export const DM_WAIT_MS = 3 * 60_000;

const escapeRegex = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Matchable = { mediaId: string; text: string; commentedAt: Date };

function textMatches(rule: CommentDmRule, c: Matchable): boolean {
  if (rule.mediaId && c.mediaId !== rule.mediaId) return false;
  const kws = rule.keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (kws.length === 0) return true; // any comment on the chosen post
  // Whole words only, so "price" does not fire on "priceless". shortcut: plurals ("links") need their own keyword.
  return kws.some((k) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(k)}(?![\\p{L}\\p{N}])`, 'iu').test(c.text));
}

// A rule for one post beats an any-post rule, a keyword rule beats a catch-all, ties go to the oldest (stable sort).
export function pickRule(rules: CommentDmRule[], c: Matchable): CommentDmRule | undefined {
  return rules
    .filter((r) => r.enabled && r.enabledAt)
    .sort((a, b) => Number(!!b.mediaId) - Number(!!a.mediaId) || Number(!!b.keywords.trim()) - Number(!!a.keywords.trim()))
    .find((r) => c.commentedAt.getTime() > r.enabledAt!.getTime() - GRACE_MS && textMatches(r, c));
}

// Should the public reply promise "check your DMs"?
//   wait    = a DM is expected but has not gone out yet: hold the public reply and look again shortly
//   promise = the DM (or the follow-gate message) really is in the customer's inbox
//   none    = no DM is coming (no rule, it failed, or it was cancelled): do not promise one
export type DmGate = 'wait' | 'promise' | 'none';
export function dmGate(rule: CommentDmRule | null, log: Pick<CommentDmLog, 'status'> | null, commentAgeMs: number): DmGate {
  if (!rule) return 'none';
  if (!log || log.status === 'processing') return commentAgeMs < DM_WAIT_MS ? 'wait' : 'none';
  return log.status === 'sent' || log.status === 'follow_gate' || log.status === 'follow_verified' ? 'promise' : 'none';
}
