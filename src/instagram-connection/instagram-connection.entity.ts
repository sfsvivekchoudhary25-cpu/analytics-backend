import { Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn } from 'typeorm';
import { encryptedTransformer } from '../common/encrypted.transformer';

// Single-row table: this business only ever connects one Instagram account.
// If you later support multiple stores/accounts, add a unique key column
// instead of treating this as a singleton.
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

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
