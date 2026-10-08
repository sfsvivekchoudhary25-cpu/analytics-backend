import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { CommentsService } from '../comments/comments.service';
import { AutoMessageService } from '../messaging/auto-message.service';
import { MessagingService } from '../messaging/messaging.service';
import { SubmissionsService } from '../submissions/submissions.service';
import { CommentDmService } from '../comment-dm/comment-dm.service';
import { InstagramConnectionService } from '../instagram-connection/instagram-connection.service';
import { commentEvents, describeEvent, messagingEvents } from './events';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Public on purpose: Meta calls these, not the admin panel. Both routes
// authenticate the caller themselves (verify token / payload signature).
@Controller('instagram/webhook')
export class InstagramWebhookController {
  private readonly logger = new Logger('Webhook');

  constructor(
    private readonly submissions: SubmissionsService,
    private readonly messaging: MessagingService,
    private readonly comments: CommentsService,
    private readonly autoMessages: AutoMessageService,
    private readonly commentDm: CommentDmService,
    private readonly connection: InstagramConnectionService,
  ) {}

  // Meta's one-time handshake when you click "Verify and save".
  @Get()
  @Header('Content-Type', 'text/plain')
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const expected =
      process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN ||
      'dfed4dff43bfe4c623eaee3cd7aafd9e493448ca3e877a3f';
    if (mode !== 'subscribe' || !expected || !safeEqual(String(token ?? ''), expected)) {
      this.logger.warn('Verification handshake REJECTED (wrong verify token or mode)');
      throw new ForbiddenException();
    }
    this.logger.log('Verification handshake OK');
    return String(challenge ?? '');
  }

  // Events (messages, comments, ...). Signed with the app secret.
  @Post()
  @HttpCode(200)
  receive(@Req() req: { rawBody?: Buffer; headers: Record<string, string> }) {
    const secret = process.env.INSTAGRAM_APP_SECRET ?? '';
    const signature = req.headers['x-hub-signature-256'] ?? '';
    const expected =
      'sha256=' + createHmac('sha256', secret).update(req.rawBody ?? Buffer.alloc(0)).digest('hex');
    if (!secret || !safeEqual(signature, expected)) {
      this.logger.warn(
        !secret
          ? 'Event REJECTED: INSTAGRAM_APP_SECRET is not set'
          : signature
            ? 'Event REJECTED: signature does not match INSTAGRAM_APP_SECRET (wrong secret, or not from Meta)'
            : 'Event REJECTED: no signature header (not from Meta)',
      );
      throw new UnauthorizedException();
    }

    const raw = req.rawBody?.toString('utf8') ?? '';
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.logger.warn('Event body was not valid JSON');
      return 'EVENT_RECEIVED';
    }

    const events = messagingEvents(payload);
    const comments = commentEvents(payload);
    for (const { ownId, field, value: v } of comments) {
      const text = String(v.text ?? '').replace(/\s+/g, ' ').trim();
      this.logger.log(
        `${field === 'live_comments' ? 'LIVE COMMENT' : 'COMMENT'} by @${v.from?.username ?? v.from?.id ?? 'unknown'}${v.parent_id ? ' (reply in thread)' : ''} on ${v.media?.media_product_type ?? 'post'} ${v.media?.id ?? '?'}: "${text.length > 80 ? text.slice(0, 80) + '…' : text}"  [account ${ownId}]`,
      );
    }
    if (events.length === 0 && comments.length === 0) {
      // Something we don't act on: show what it was so nothing is silently lost.
      const fields = (Array.isArray(payload) ? payload : [payload]).flatMap((r: any) =>
        (r?.entry ?? []).flatMap((e: any) => [...(e.changes ?? []).map((c: any) => c.field), e.field].filter(Boolean)),
      );
      this.logger.log(`Other payload (fields: ${fields.join(', ') || 'none'}) ${raw.slice(0, 300)}`);
    }
    for (const { ownId, ev } of events) {
      const { kind, line } = describeEvent(ev);
      this.logger.log(`${line}  [account ${ownId}]`);
      if (kind === 'unknown') this.logger.warn(`Raw event: ${JSON.stringify(ev).slice(0, 500)}`);
    }
    if (process.env.LOG_RAW_WEBHOOKS === '1') this.logger.debug(`Raw payload: ${raw}`);

    // Answer Meta right away; matching + replying happens in the background.
    void (async () => {
      // 1. Process comments immediately and trigger Comment-to-DM without waiting for cron
      if (comments.length > 0) {
        await this.comments.handleWebhook(payload);
        const touchedCommentAccounts = new Set<string>();
        for (const { ownId } of comments) {
          const conn = await this.connection.getConnectionByIgUserId(ownId).catch(() => null);
          if (conn?.username) touchedCommentAccounts.add(conn.username.toLowerCase());
        }
        if (touchedCommentAccounts.size > 0) {
          for (const acc of touchedCommentAccounts) {
            await this.commentDm.processAuto(acc);
          }
        } else {
          await this.commentDm.processAuto();
        }
      }

      // 2. Process messaging events (follow-gate confirmations, DM sync)
      if (events.length > 0) {
        await this.messaging.handleWebhook(payload);
        await this.submissions.handleWebhook(payload);
        await this.commentDm.handleMessageWebhook(payload); // matches follow-gate clicks, sends real DM or reminder
        
        const touchedMessageAccounts = new Set<string>();
        for (const { ownId } of events) {
          const conn = await this.connection.getConnectionByIgUserId(ownId).catch(() => null);
          if (conn?.username) touchedMessageAccounts.add(conn.username.toLowerCase());
        }
        if (touchedMessageAccounts.size > 0) {
          for (const acc of touchedMessageAccounts) {
            void this.autoMessages.processPending(acc).catch((err) => this.logger.error(`AutoMessage error: ${err.message}`));
          }
        } else {
          void this.autoMessages.processPending().catch((err) => this.logger.error(`AutoMessage error: ${err.message}`));
        }
      }
    })().catch((err) => this.logger.error(`Processing failed: ${err.message}`));
    return 'EVENT_RECEIVED';
  }
}
