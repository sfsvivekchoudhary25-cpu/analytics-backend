import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('app_users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255, name: 'password_hash' })
  passwordHash: string;

  @Column({ type: 'varchar', length: 255, name: 'instagram_handle', nullable: true })
  instagramHandle: string | null;

  @Column({ type: 'varchar', length: 50, default: 'admin', nullable: true })
  role: string;

  @Column({ type: 'varchar', length: 10, name: 'reset_code', nullable: true })
  resetCode: string | null;

  @Column({ type: 'timestamptz', name: 'reset_code_expires_at', nullable: true })
  resetCodeExpiresAt: Date | null;

  @Column({ type: 'varchar', length: 255, name: 'facebook_page_name', nullable: true })
  facebookPageName: string | null;

  @Column({ type: 'varchar', length: 255, name: 'tiktok_handle', nullable: true })
  tiktokHandle: string | null;

  @Column({ type: 'varchar', length: 255, name: 'youtube_channel', nullable: true })
  youtubeChannel: string | null;

  @Column({ type: 'varchar', length: 100, name: 'creator_niche', nullable: true })
  creatorNiche: string | null;

  @Column({ type: 'varchar', length: 100, name: 'monthly_volume', nullable: true })
  monthlyVolume: string | null;

  @Column({ type: 'boolean', name: 'onboarding_completed', default: false, nullable: true })
  onboardingCompleted: boolean;

  @Column({ type: 'varchar', length: 500, name: 'openrouter_api_key_encrypted', nullable: true })
  openrouterApiKeyEncrypted: string | null;

  @Column({ type: 'varchar', length: 64, name: 'openrouter_api_key_iv', nullable: true })
  openrouterApiKeyIv: string | null;

  @Column({ type: 'varchar', length: 64, name: 'openrouter_api_key_tag', nullable: true })
  openrouterApiKeyTag: string | null;

  @Column({ type: 'varchar', length: 10, name: 'openrouter_key_last4', nullable: true })
  openrouterKeyLast4: string | null;

  @Column({ type: 'varchar', length: 120, name: 'openrouter_model', nullable: true, default: 'nvidia/nemotron-3-ultra' })
  openrouterModel: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', nullable: true })
  updatedAt: Date;
}
