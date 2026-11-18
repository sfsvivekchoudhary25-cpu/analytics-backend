import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { encryptedTextTransformer } from '../common/encrypted.transformer';

// One row per customer we've exchanged DMs with. Keyed by their Instagram-scoped ID.
@Index('ix_conversation_owner_last', ['ownerUsername', 'lastMessageAt'])
@Entity('conversation')
export class Conversation {
  @PrimaryColumn({ type: 'varchar' })
  igsid: string;

  @Index()
  @Column({ name: 'owner_username', type: 'varchar', nullable: true })
  ownerUsername: string | null;

  @Column({ type: 'varchar', nullable: true })
  username: string | null;

  @Column({ name: 'profile_pic', type: 'text', nullable: true })
  profilePic: string | null;

  // Encrypted at rest (a preview of the latest DM).
  @Column({ name: 'last_text', type: 'text', default: '', transformer: encryptedTextTransformer })
  lastText: string;

  @Index()
  @Column({ name: 'last_message_at', type: 'timestamptz' })
  lastMessageAt: Date;

  // Instagram only lets us reply within 24h of this.
  @Column({ name: 'last_inbound_at', type: 'timestamptz', nullable: true })
  lastInboundAt: Date | null;

  // When we (or the account owner) last sent something here, and who: 'app' (typed in Instagram), 'dashboard',
  // 'auto' or 'system'. Kept on the conversation so accounts that don't store message rows still know whether a
  // customer message was already answered, and whether a person took over.
  @Column({ name: 'last_outbound_at', type: 'timestamptz', nullable: true })
  lastOutboundAt: Date | null;

  @Column({ name: 'last_outbound_source', type: 'varchar', nullable: true })
  lastOutboundSource: string | null;

  @Column({ type: 'int', default: 0 })
  unread: number;
}

@Index('uq_message_owner_mid', ['ownerUsername', 'mid'], { unique: true, where: '"mid" IS NOT NULL' })
@Index('ix_message_owner_thread_time', ['ownerUsername', 'igsid', 'createdAt'])
@Entity('message')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'owner_username', type: 'varchar', nullable: true })
  ownerUsername: string | null;

  @Index()
  @Column({ type: 'varchar' })
  igsid: string;

  @Column({ type: 'varchar' })
  direction: 'in' | 'out';

  // The DM itself. Encrypted at rest.
  @Column({ type: 'text', default: '', transformer: encryptedTextTransformer })
  text: string;

  // e.g. "image", "story_mention"; shown as a label when there is no text.
  @Column({ name: 'attachment_type', type: 'varchar', nullable: true })
  attachmentType: string | null;

  @Column({ name: 'attachment_url', type: 'text', nullable: true, transformer: encryptedTextTransformer })
  attachmentUrl: string | null;

  // Who sent an outgoing message: 'app' = typed in the Instagram app, 'dashboard', 'auto' = automation,
  // 'system' = e.g. the photo thank-you. Null for incoming messages. Automation stays quiet after 'app'/'dashboard'.
  @Column({ type: 'varchar', nullable: true })
  source: 'app' | 'dashboard' | 'auto' | 'system' | null;

  // Instagram's message id; used to ignore duplicate webhook deliveries per tenant.
  @Index()
  @Column({ type: 'varchar', nullable: true })
  mid: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
