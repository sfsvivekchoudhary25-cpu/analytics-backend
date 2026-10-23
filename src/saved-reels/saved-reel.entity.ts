import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('saved_reels')
export class SavedReel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'owner_username', type: 'varchar', length: 120, nullable: true })
  ownerUsername: string | null;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  shortcode: string;

  @Column({ type: 'text' })
  url: string;

  @Column({ name: 'video_url', type: 'text', nullable: true })
  videoUrl: string | null;

  @Column({ type: 'text', nullable: true })
  thumbnail: string | null;

  @Column({ type: 'text', default: '' })
  caption: string;

  @Column({ type: 'varchar', length: 255, default: 'instagram_user' })
  author: string;

  @Column({ name: 'author_name', type: 'varchar', length: 255, default: 'Instagram Creator' })
  authorName: string;

  @Column({ name: 'author_url', type: 'text', default: '' })
  authorUrl: string;

  @Column({ type: 'int', default: 0 })
  likes: number;

  @Column({ type: 'int', default: 0 })
  comments: number;

  @Column({ type: 'int', default: 0 })
  views: number;

  @Column({ type: 'varchar', length: 32, nullable: true })
  quality: string | null;

  @Column({ type: 'float', nullable: true })
  duration: number | null;

  @Column({ name: 'upload_date', type: 'varchar', length: 64, nullable: true })
  uploadDate: string | null;

  @Column({ name: 'saved_at', type: 'bigint' })
  savedAt: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
