import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type SubmissionStatus = 'pending' | 'publishing' | 'published' | 'failed';
export type DmStatus = 'waiting' | 'sent' | 'failed';

// One customer photo submitted from the website, waiting for (or past) publishing.
@Entity('submission')
export class Submission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'ig_username', type: 'varchar' })
  igUsername: string;

  @Column({ name: 'image_file', type: 'varchar' })
  imageFile: string;

  @Column({ type: 'text', nullable: true })
  caption: string | null;

  @Column({ type: 'varchar', default: 'pending' })
  status: SubmissionStatus;

  @Column({ name: 'media_id', type: 'varchar', nullable: true })
  mediaId: string | null;

  @Column({ type: 'text', nullable: true })
  permalink: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  // Non-fatal remarks, e.g. "could not tag, mentioned in caption instead".
  @Column({ type: 'text', nullable: true })
  note: string | null;

  // Carried in the ig.me chat link so the webhook can match the DM back to this row.
  @Column({ type: 'varchar', unique: true })
  ref: string;

  @Column({ name: 'dm_status', type: 'varchar', default: 'waiting' })
  dmStatus: DmStatus;

  // Instagram-scoped ID of the customer; only known once they message us.
  @Column({ type: 'varchar', nullable: true })
  igsid: string | null;

  @Column({ name: 'igsid_seen_at', type: 'timestamptz', nullable: true })
  igsidSeenAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;
}
