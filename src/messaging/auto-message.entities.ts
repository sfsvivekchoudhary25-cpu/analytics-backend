import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

// Row per account: master switch and safety limits for automatic replies to direct messages.
@Entity('message_auto_setting')
export class MessageAutoSetting {
  @PrimaryColumn({ type: 'int' })
  id: number;

  @Index()
  @Column({ name: 'owner_username', type: 'varchar', nullable: true })
  ownerUsername: string | null;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  // Only messages received after this moment are answered, so turning it on never replies to old chats.
  @Column({ name: 'enabled_at', type: 'timestamptz', nullable: true })
  enabledAt: Date | null;

  @Column({ name: 'max_per_hour', type: 'int', default: 30 })
  maxPerHour: number;

  // AI writes the reply for anything the keyword rules do not cover, using only `aiInstructions` as facts.
  @Column({ name: 'ai_enabled', type: 'boolean', default: false })
  aiEnabled: boolean;

  @Column({ name: 'ai_instructions', type: 'text', default: '' })
  aiInstructions: string;

  // When the AI stays silent (not confident, message too sensitive, ...), send this instead of nothing at
  // all, so the customer sees an acknowledgement rather than what looks like being ignored.
  @Column({ name: 'fallback_enabled', type: 'boolean', default: true })
  fallbackEnabled: boolean;

  // The friendly default text lives in the service's row-creation code, not here — a DEFAULT clause with an
  // apostrophe in it breaks TypeORM's generated DDL (`syntax error at or near 've'`), so this stays plain ''.
  @Column({ name: 'fallback_text', type: 'text', default: '' })
  fallbackText: string;
}

@Entity('message_auto_rule')
export class MessageAutoRule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'owner_username', type: 'varchar', nullable: true })
  ownerUsername: string | null;

  // Comma-separated. Empty means "any message" (a catch-all, tried last).
  @Column({ type: 'text', default: '' })
  keywords: string;

  // {username} is replaced with the customer's handle.
  @Column({ name: 'reply_text', type: 'text' })
  replyText: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

// One row per incoming message we have considered. The unique message id is what guarantees
// that a single message can never be answered twice, even if two workers pick it up at once.
@Entity('message_auto_log')
export class MessageAutoLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'owner_username', type: 'varchar', nullable: true })
  ownerUsername: string | null;

  @Index({ unique: true })
  @Column({ name: 'message_id', type: 'varchar' })
  messageId: string;

  @Column({ type: 'varchar' })
  igsid: string;

  @Column({ type: 'varchar', nullable: true })
  username: string | null;

  @Column({ type: 'varchar', default: 'processing' })
  outcome: 'processing' | 'sent' | 'skipped' | 'failed';

  // Who wrote a sent reply: one of your rules, the AI, or the holding message sent when the AI stayed silent.
  @Column({ type: 'varchar', default: 'rule' })
  kind: 'rule' | 'ai' | 'fallback';

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ name: 'reply_text', type: 'text', nullable: true })
  replyText: string | null;

  @Index()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
