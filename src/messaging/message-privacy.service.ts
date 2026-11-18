import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { rlsStorage } from '../common/rls/rls.context';
import { InstagramConnectionService } from '../instagram-connection/instagram-connection.service';

// "Don't store my messages" mode.
// When an account turns this on, the text of its customer DMs is never written to the database. The database keeps
// only who / when / direction (enough for the 24-hour window, de-duplication and "has someone already answered").
// The text itself lives in this short-lived, in-memory copy so automation can answer, and the inbox reads chats live
// from Instagram. A server restart empties this memory; nothing here is ever persisted.
const FLAG_TTL_MS = 30_000;
const TEXT_TTL_MS = 24 * 3600_000; // matches Instagram's reply window
const MAX_TEXTS = 20_000;
const MAX_PER_CHAT = 30;

export type RememberedMessage = { id: string; mid: string | null; direction: 'in' | 'out'; text: string; at: number };
// A customer message waiting for automation. `id` is Instagram's message id (also what the automation log keys on).
export type QueuedInbound = { id: string; mid: string; owner: string; igsid: string; text: string; at: number };

@Injectable()
export class MessagePrivacyService {
  private readonly logger = new Logger('MessagePrivacy');
  private readonly flags = new Map<string, { noStore: boolean; at: number }>();
  private readonly byId = new Map<string, { text: string; at: number }>();
  private readonly chats = new Map<string, RememberedMessage[]>();

  constructor(
    private readonly connection: InstagramConnectionService,
    private readonly dataSource: DataSource,
  ) {}

  private clean(owner?: string | null) {
    return owner ? owner.trim().replace(/^@/, '').toLowerCase() : '';
  }

  async isNoStore(owner?: string | null): Promise<boolean> {
    const o = this.clean(owner);
    if (!o) return false;
    const hit = this.flags.get(o);
    if (hit && Date.now() - hit.at < FLAG_TTL_MS) return hit.noStore;
    try {
      const row = await this.connection.getConnectionRow(o);
      const noStore = !!row && row.storeMessages === false;
      this.flags.set(o, { noStore, at: Date.now() });
      return noStore;
    } catch {
      // If we cannot tell, keep the last known answer (the safer one for someone who chose not to store).
      return hit?.noStore ?? false;
    }
  }

  // ---- short-lived text memory ----

  remember(owner: string, igsid: string, m: RememberedMessage) {
    if (!m.text) return;
    this.byId.set(m.id, { text: m.text, at: Date.now() });
    const key = `${this.clean(owner)}|${igsid}`;
    const list = this.chats.get(key) ?? [];
    list.push(m);
    list.sort((a, b) => a.at - b.at);
    if (list.length > MAX_PER_CHAT) list.splice(0, list.length - MAX_PER_CHAT);
    this.chats.set(key, list);
    if (this.byId.size > MAX_TEXTS) this.sweep(true);
  }

  textOf(id: string): string | null {
    const v = this.byId.get(id);
    if (!v) return null;
    if (Date.now() - v.at > TEXT_TTL_MS) {
      this.byId.delete(id);
      return null;
    }
    return v.text;
  }

  updateText(id: string, text: string) {
    if (this.byId.has(id)) this.byId.set(id, { text, at: Date.now() });
    for (const list of this.chats.values()) for (const m of list) if (m.id === id) m.text = text;
  }

  recent(owner: string, igsid: string): RememberedMessage[] {
    const cutoff = Date.now() - TEXT_TTL_MS;
    return (this.chats.get(`${this.clean(owner)}|${igsid}`) ?? []).filter((m) => m.at >= cutoff);
  }

  lastText(owner: string, igsid: string): string | null {
    const list = this.recent(owner, igsid);
    return list.length ? list[list.length - 1].text : null;
  }

  // ---- message ids already handled (de-duplication without database rows) ----

  private readonly seen = new Map<string, number>();
  private readonly sent = new Map<string, { source: string; at: number }>();

  // True if this Instagram message id was already handled recently; otherwise marks it handled and returns false.
  seenMid(owner: string, mid?: string | null): boolean {
    if (!mid) return false;
    const key = `${this.clean(owner)}|${mid}`;
    const had = this.seen.has(key);
    this.seen.set(key, Date.now());
    if (this.seen.size > MAX_TEXTS) this.prune(this.seen, (v) => v);
    return had;
  }

  // A message we sent ourselves (so the webhook's echo of it is not mistaken for one typed in the Instagram app).
  markSent(owner: string, mid: string | undefined | null, source: string) {
    if (!mid) return;
    this.seenMid(owner, mid);
    this.sent.set(`${this.clean(owner)}|${mid}`, { source, at: Date.now() });
    if (this.sent.size > MAX_TEXTS) this.prune(this.sent, (v) => v.at);
  }

  sourceOf(owner: string, mid?: string | null): string | null {
    if (!mid) return null;
    return this.sent.get(`${this.clean(owner)}|${mid}`)?.source ?? null;
  }

  private prune<V>(map: Map<string, V>, at: (v: V) => number) {
    const cutoff = Date.now() - 2 * TEXT_TTL_MS;
    for (const [k, v] of map) if (at(v) < cutoff) map.delete(k);
    if (map.size > MAX_TEXTS) {
      let drop = map.size - Math.floor(MAX_TEXTS * 0.8);
      for (const k of map.keys()) {
        if (drop-- <= 0) break;
        map.delete(k);
      }
    }
  }

  // ---- inbox of customer messages waiting for automation (memory only, never persisted) ----

  private readonly queue = new Map<string, QueuedInbound>();

  enqueueInbound(q: QueuedInbound) {
    if (!q.text) return;
    this.queue.set(q.id, q);
    if (this.queue.size > 5000) {
      const oldest = [...this.queue.keys()].slice(0, this.queue.size - 4000);
      for (const k of oldest) this.queue.delete(k);
    }
  }

  // Waiting messages for one account (or all when no account is given), dropping any older than the reply window.
  queued(owner?: string | null): QueuedInbound[] {
    const o = this.clean(owner);
    const cutoff = Date.now() - TEXT_TTL_MS;
    const out: QueuedInbound[] = [];
    for (const [id, q] of this.queue) {
      if (q.at < cutoff) {
        this.queue.delete(id);
        continue;
      }
      if (!o || this.clean(q.owner) === o) out.push(q);
    }
    return out.sort((a, b) => a.at - b.at);
  }

  dequeue(id: string) {
    this.queue.delete(id);
  }

  // The text of an already-handled message by its Instagram id (used when a customer edits a message).
  updateTextByMid(owner: string, mid: string, text: string) {
    const o = this.clean(owner);
    const q = this.queue.get(mid);
    if (q && this.clean(q.owner) === o) q.text = text;
    for (const [key, list] of this.chats) {
      if (!key.startsWith(`${o}|`)) continue;
      for (const m of list) {
        if (m.mid === mid) {
          m.text = text;
          this.byId.set(m.id, { text, at: Date.now() });
        }
      }
    }
  }

  forgetChat(owner: string, igsid: string) {
    const key = `${this.clean(owner)}|${igsid}`;
    for (const m of this.chats.get(key) ?? []) this.byId.delete(m.id);
    this.chats.delete(key);
  }

  private sweep(force = false) {
    const cutoff = Date.now() - TEXT_TTL_MS;
    for (const [id, v] of this.byId) if (v.at < cutoff) this.byId.delete(id);
    if (force && this.byId.size > MAX_TEXTS) {
      let drop = this.byId.size - Math.floor(MAX_TEXTS * 0.8);
      for (const id of this.byId.keys()) {
        if (drop-- <= 0) break;
        this.byId.delete(id);
      }
    }
  }

  // ---- the switch ----

  // Turning it on also erases message text that was already stored for this account.
  async setStoreMessages(owner: string, store: boolean): Promise<{ storeMessages: boolean; scrubbed: number }> {
    const o = this.clean(owner);
    let scrubbed = 0;
    await rlsStorage.run({ bypass: true }, async () => {
      await this.dataSource.query(`UPDATE instagram_connection SET store_messages = $1 WHERE LOWER(username) = $2`, [store, o]);
      if (!store) {
        // Keep the one fact automation needs from the old rows (when/who last sent something) on the conversation,
        // then delete the rows themselves: this mode keeps no per-message records at all.
        await this.dataSource.query(
          `UPDATE conversation c SET last_outbound_at = x.t, last_outbound_source = x.s
             FROM (SELECT DISTINCT ON (igsid) igsid, created_at AS t, source AS s FROM message
                    WHERE direction = 'out' AND LOWER(owner_username) = $1 ORDER BY igsid, created_at DESC) x
            WHERE c.igsid = x.igsid AND LOWER(c.owner_username) = $1`,
          [o],
        );
        const del = await this.dataSource.query(`DELETE FROM message WHERE LOWER(owner_username) = $1 RETURNING id`, [o]);
        await this.dataSource.query(`UPDATE conversation SET last_text = '' WHERE LOWER(owner_username) = $1 AND last_text <> ''`, [o]);
        await this.dataSource.query(`UPDATE message_auto_log SET reply_text = NULL WHERE LOWER(owner_username) = $1 AND reply_text IS NOT NULL`, [o]);
        scrubbed = Array.isArray(del) ? (Array.isArray(del[0]) ? del[0].length : del.length) : 0;
      }
    });
    this.flags.set(o, { noStore: !store, at: Date.now() });
    this.logger.log(`@${o} ${store ? 'now stores' : 'no longer stores'} message text${!store ? ` (erased stored text from ${scrubbed} message(s))` : ''}`);
    return { storeMessages: store, scrubbed };
  }
}
