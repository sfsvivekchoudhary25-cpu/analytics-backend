import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

export type AutoState = 'new' | 'processing' | 'done' | 'skipped' | 'failed';
export type ReplyKind = 'manual' | 'auto' | 'external';

// A top-level (or reply) comment on one of our posts. Keyed by Instagram's comment id.
@Entity('comment')
export class Comment {
  @PrimaryColumn({ type: 'varchar' })
  id: string;

  @Index()
  @Column({ name: 'media_id', type: 'varchar' })
  mediaId: string;

  @Column({ name: 'media_permalink', type: 'text', nullable: true })
  mediaPermalink: string | null;

  @Column({ name: 'media_thumb', type: 'text', nullable: true })
  mediaThumb: string | null;

  @Column({ name: 'parent_id', type: 'varchar', nullable: true })
  parentId: string | null;

  @Column({ type: 'varchar', default: '' })
  username: string;

  @Column({ type: 'text', default: '' })
  text: string;

  @Index()
  @Column({ name: 'commented_at', type: 'timestamptz' })
  commentedAt: Date;

  @Column({ name: 'like_count', type: 'int', default: 0 })
  likeCount: number;

  @Column({ type: 'boolean', default: false })
  hidden: boolean;

  // Our reply, whether typed in the dashboard, sent by automation, or made directly in the Instagram app.
  @Column({ name: 'my_reply', type: 'text', nullable: true })
  myReply: string | null;

  @Column({ name: 'replied_at', type: 'timestamptz', nullable: true })
  repliedAt: Date | null;

  @Column({ name: 'reply_kind', type: 'varchar', nullable: true })
  replyKind: ReplyKind | null;

  @Column({ name: 'auto_state', type: 'varchar', default: 'new' })
  autoState: AutoState;

  @Column({ name: 'auto_note', type: 'text', nullable: true })
  autoNote: string | null;

  // Comment written by our own account (never auto-replied to).
  @Column({ name: 'is_own', type: 'boolean', default: false })
  isOwn: boolean;

  @CreateDateColumn({ name: 'first_seen_at', type: 'timestamptz' })
  firstSeenAt: Date;
}

// Single row (id = 1): the master switch for comment automation.
@Entity('auto_reply_setting')
export class AutoReplySetting {
  @PrimaryColumn({ type: 'int' })
  id: number;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  // Only comments made after this moment are auto-replied to, so turning it on never answers old comments.
  @Column({ name: 'enabled_at', type: 'timestamptz', nullable: true })
  enabledAt: Date | null;

  @Column({ name: 'max_per_hour', type: 'int', default: 30 })
  maxPerHour: number;

  // AI writes the reply for anything the keyword rules do not cover, using only `aiInstructions` as facts.
  @Column({ name: 'ai_enabled', type: 'boolean', default: false })
  aiEnabled: boolean;

  @Column({ name: 'ai_instructions', type: 'text', default: '' })
  aiInstructions: string;
}

@Entity('auto_reply_rule')
export class AutoReplyRule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Comma-separated. Empty means "any comment" (a catch-all, tried last).
  @Column({ type: 'text', default: '' })
  keywords: string;

  // {username} is replaced with the commenter's handle.
  @Column({ name: 'reply_text', type: 'text' })
  replyText: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
