// Instagram delivers events in several shapes (see Meta's "Webhook notification examples"):
//   entry.messaging[]                          classic messaging payload
//   entry.changes[{ field, value }]            Facebook Login shape, and the dashboard "Test" button
//   entry.field + entry.value                  Business Login for Instagram comments (value sits directly on the entry)
// The helpers below normalise all of them.

const MESSAGING_FIELDS = new Set([
  'messages',
  'message_edit',
  'message_reactions',
  'messaging_seen',
  'messaging_postbacks',
  'messaging_referral',
  'messaging_optins',
]);
const COMMENT_FIELDS = new Set(['comments', 'live_comments']);

export type MessagingEvent = { ownId: string; ev: any };
export type CommentEvent = { ownId: string; field: 'comments' | 'live_comments'; value: any };

// A webhook body is one object; tolerate an array of them too.
const roots = (payload: any): any[] => (Array.isArray(payload) ? payload : payload ? [payload] : []);

// [{ field, value }] pairs of an entry, from either `changes` or the entry itself.
function fieldValues(entry: any): { field: string; value: any }[] {
  const out: { field: string; value: any }[] = (entry.changes ?? []).map((c: any) => ({ field: c?.field, value: c?.value }));
  if (entry.field && entry.value) out.push({ field: entry.field, value: entry.value });
  return out.filter((fv) => fv.value && typeof fv.value === 'object');
}

export function messagingEvents(payload: any): MessagingEvent[] {
  const out: MessagingEvent[] = [];
  for (const root of roots(payload)) {
    for (const entry of root?.entry ?? []) {
      const ownId = String(entry.id);
      for (const ev of entry.messaging ?? []) out.push({ ownId, ev });
      for (const { field, value } of fieldValues(entry)) {
        if (MESSAGING_FIELDS.has(field)) out.push({ ownId, ev: value });
      }
    }
  }
  return out;
}

export function commentEvents(payload: any): CommentEvent[] {
  const out: CommentEvent[] = [];
  for (const root of roots(payload)) {
    for (const entry of root?.entry ?? []) {
      for (const { field, value } of fieldValues(entry)) {
        if (COMMENT_FIELDS.has(field)) out.push({ ownId: String(entry.id), field: field as CommentEvent['field'], value });
      }
    }
  }
  return out;
}

// The comment id is `id` for Business Login and `comment_id` for Facebook Login.
export const commentId = (v: any): string | null => (v?.id ?? v?.comment_id ?? null) ? String(v.id ?? v.comment_id) : null;

// Instagram sends milliseconds in `messaging` events but seconds (as a string) in `changes` events.
export function eventDate(timestamp: unknown): Date {
  const n = Number(timestamp);
  if (!n) return new Date();
  return new Date(n < 1e12 ? n * 1000 : n);
}

export type EventKind =
  | 'message'
  | 'echo'
  | 'self'
  | 'deleted'
  | 'edit'
  | 'read'
  | 'reaction'
  | 'postback'
  | 'referral'
  | 'unknown';

// One-line, human-readable summary of an event for the terminal log.
export function describeEvent(ev: any): { kind: EventKind; line: string } {
  const from = ev.sender?.id ?? '?';
  const to = ev.recipient?.id ?? '?';
  const preview = (t: unknown) => {
    const s = String(t ?? '').replace(/\s+/g, ' ').trim();
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  };
  if (ev.message_edit) {
    return {
      kind: 'edit',
      line: `EDIT from ${from}: "${preview(ev.message_edit.text)}" (edit #${ev.message_edit.num_edit ?? '?'}, message ...${String(ev.message_edit.mid ?? '').slice(-8)})`,
    };
  }
  if (ev.message) {
    const m = ev.message;
    if (m.is_self) return { kind: 'self', line: `SELF-TEST message (Meta's test message to your own account): "${preview(m.text)}"` };
    if (m.is_deleted) return { kind: 'deleted', line: `DELETED message from ${from} (message ...${String(m.mid ?? '').slice(-8)})` };
    const att = m.attachments?.length ? ` +${m.attachments.length} attachment(s) [${m.attachments.map((a: any) => a.type).join(', ')}]` : '';
    const flags = [m.is_unsupported && 'unsupported media', m.reply_to?.story && 'reply to your story', m.reply_to?.mid && 'inline reply', m.quick_reply && 'quick reply', m.referral && 'from an ad']
      .filter(Boolean)
      .join(', ');
    const echo = !!m.is_echo;
    return {
      kind: echo ? 'echo' : 'message',
      line: `${echo ? 'ECHO (sent from the Instagram app)' : 'MESSAGE'} ${echo ? `to ${to}` : `from ${from}`}: "${preview(m.text)}"${att}${flags ? ` (${flags})` : ''}`,
    };
  }
  if (ev.read) return { kind: 'read', line: `READ receipt (mid ...${String(ev.read.mid ?? '').slice(-8)})` };
  if (ev.reaction) return { kind: 'reaction', line: `REACTION ${ev.reaction.action ?? ''} ${ev.reaction.reaction ?? ''} from ${from}` };
  if (ev.postback) return { kind: 'postback', line: `POSTBACK from ${from}: ${ev.postback.title ?? ev.postback.payload ?? ''}` };
  if (ev.referral) return { kind: 'referral', line: `REFERRAL from ${from} ref=${ev.referral.ref ?? '?'}` };
  return { kind: 'unknown', line: `UNRECOGNISED event from ${from}` };
}
