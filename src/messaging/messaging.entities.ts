import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

// One row per customer we've exchanged DMs with. Keyed by their Instagram-scoped ID.
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

  @Column({ name: 'last_text', type: 'text', default: '' })
  lastText: string;

  @Index()
  @Column({ name: 'last_message_at', type: 'timestamptz' })
  lastMessageAt: Date;

  // Instagram only lets us reply within 24h of this.
  @Column({ name: 'last_inbound_at', type: 'timestamptz', nullable: true })
  lastInboundAt: Date | null;

  @Column({ type: 'int', default: 0 })
  unread: number;
}

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

  @Column({ type: 'text', default: '' })
  text: string;

  // e.g. "image", "story_mention"; shown as a label when there is no text.
  @Column({ name: 'attachment_type', type: 'varchar', nullable: true })
  attachmentType: string | null;

  @Column({ name: 'attachment_url', type: 'text', nullable: true })
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
