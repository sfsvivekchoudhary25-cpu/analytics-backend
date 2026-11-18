import { Entity, Index, PrimaryGeneratedColumn, Column, UpdateDateColumn } from 'typeorm';
import { encryptedTransformer } from '../common/encrypted.transformer';

// Single-row table: this business only ever connects one Instagram account.
// If you later support multiple stores/accounts, add a unique key column
// instead of treating this as a singleton.
@Index('uq_instagram_connection_ig_user', ['igUserId'], { unique: true })
@Index('uq_instagram_connection_name', ['username'], { unique: true })
@Entity('instagram_connection')
export class InstagramConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'ig_user_id' })
  igUserId: string;

  @Column()
  username: string;

  // Encrypted at rest (AES-256-GCM) via TOKEN_ENCRYPTION_KEY.
  @Column({ name: 'access_token', type: 'text', transformer: encryptedTransformer })
  accessToken: string;

  @Column({ name: 'token_expires_at', type: 'timestamptz' })
  tokenExpiresAt: Date;

  // Comma-separated permissions Instagram reported at login. Null when connected with a pasted token
  // (Instagram gives no way to read them back from a token).
  @Column({ type: 'text', nullable: true })
  permissions: string | null;

  @Column({ name: 'profile_picture_url', type: 'text', nullable: true })
  profilePictureUrl: string | null;

  // Privacy switch. When false ("Don't store my messages") the text of customer DMs is never written to the
  // database: chats are read live from Instagram and automation works from a short in-memory copy.
  @Column({ name: 'store_messages', type: 'boolean', default: true })
  storeMessages: boolean;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
