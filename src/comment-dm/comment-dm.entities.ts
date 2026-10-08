import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type DmLogStatus = 'sent' | 'failed' | 'invited' | 'follow_gate' | 'follow_verified';

export const DEFAULT_FOLLOW_GATE_TEXT =
  "Oh no! It seems you're not following me 👀\nVisit my profile and hit that follow button 😁.\nOnce you do, I'll send you what you asked for!";

// A "comment triggers a DM" automation. Sends a real private reply directly via the Facebook Page's
// /messages endpoint (recipient.comment_id) — confirmed directly against Facebook's API. 'invited' is a
// legacy status from an earlier public-reply-plus-ig.me-link workaround, kept only so old rows still
// display sensibly; new rows go straight to 'sent' or 'failed'.
@Entity('comment_dm_rule')
export class CommentDmRule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'owner_username', type: 'varchar', nullable: true })
  ownerUsername: string | null;

  @Column({ type: 'varchar', default: 'Comment-to-DM Automation' })
  name: string;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  // Comma-separated; empty means "any comment" on the chosen post triggers it.
  @Column({ type: 'text', default: '' })
  keywords: string;

  // Only comments on this one post/reel trigger the DM. Null = any post on the account.
  @Column({ name: 'media_id', type: 'varchar', nullable: true })
  mediaId: string | null;

  @Column({ name: 'media_permalink', type: 'text', nullable: true })
  mediaPermalink: string | null;

  @Column({ name: 'media_thumb', type: 'text', nullable: true })
  mediaThumb: string | null;

  // Sent directly as a private reply to the matching comment.
  @Column({ name: 'dm_text', type: 'text', default: 'Hey! 👋 Thanks for your comment.' })
  dmText: string;

  // When enabled, we check if the commenter follows us before sending dmText.
  // If they don't follow yet, we send followGateText first and wait for them to confirm.
  @Column({ name: 'require_follow', type: 'boolean', default: false })
  requireFollow: boolean;

  // The message sent when the user is not following us yet.
  @Column({
    name: 'follow_gate_text',
    type: 'text',
    default: '',
  })
  followGateText: string;

  // Template type: 'text' (default), 'button' (text with buttons), 'product' (product card), 'file' (downloadable file/resource), or 'card' (custom media card)
  @Column({ name: 'template_type', type: 'varchar', default: 'text' })
  templateType: 'text' | 'button' | 'product' | 'file' | 'card';

  @Column({ name: 'card_title', type: 'text', nullable: true })
  cardTitle: string | null;

  @Column({ name: 'card_subtitle', type: 'text', nullable: true })
  cardSubtitle: string | null;

  @Column({ name: 'card_image_url', type: 'text', nullable: true })
  cardImageUrl: string | null;

  @Column({ name: 'card_file_url', type: 'text', nullable: true })
  cardFileUrl: string | null;

  @Column({ name: 'card_buttons', type: 'jsonb', nullable: true })
  cardButtons: { type: 'web_url' | 'postback'; title: string; url?: string; payload?: string }[] | null;

  // Only comments made after this moment trigger a reply, so turning it on never messages people about old comments.
  @Column({ name: 'enabled_at', type: 'timestamptz', nullable: true })
  enabledAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

// One row per comment a rule actually matched (its trigger firing). A comment is attempted at most once
// (comment_id is unique) — a public "check your DMs" reply is posted once, never retried.
@Entity('comment_dm_log')
export class CommentDmLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'owner_username', type: 'varchar', nullable: true })
  ownerUsername: string | null;

  @Index()
  @Column({ name: 'rule_id', type: 'uuid' })
  ruleId: string;

  @Index({ unique: true })
  @Column({ name: 'comment_id', type: 'varchar' })
  commentId: string;

  @Column({ type: 'varchar', default: '' })
  username: string;

  // Legacy: carried the ig.me link's ?ref= for the old workaround. Null on new (direct-send) rows.
  @Index({ unique: true })
  @Column({ type: 'varchar', nullable: true })
  ref: string | null;

  // The recipient's Instagram-scoped ID, returned directly by the send call — no longer something we have
  // to wait on and match later.
  @Column({ type: 'varchar', nullable: true })
  igsid: string | null;

  // Whether the private reply was sent successfully.
  @Column({ type: 'varchar' })
  status: DmLogStatus;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  // Set as soon as the send call succeeds.
  @Column({ name: 'dm_sent_at', type: 'timestamptz', nullable: true })
  dmSentAt: Date | null;

  // Set when the follow-gate message was sent (i.e. user was not following when comment matched).
  @Column({ name: 'follow_gate_sent_at', type: 'timestamptz', nullable: true })
  followGateSentAt: Date | null;

  // True while we are waiting for the user to confirm they followed (tapped "I'm following" or messaged in).
  @Column({ name: 'pending_follow_gate', type: 'boolean', default: false })
  pendingFollowGate: boolean;

  // Set once the customer sends any message after that, so "Replied" reflects a real reply, not a guess.
  @Column({ name: 'replied_at', type: 'timestamptz', nullable: true })
  repliedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
