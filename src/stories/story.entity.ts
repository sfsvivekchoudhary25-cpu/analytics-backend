import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('story')
export class Story {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'owner_username', type: 'varchar', nullable: true })
  ownerUsername: string | null;

  @Column({ type: 'varchar' })
  kind: 'image' | 'video';

  @Column({ type: 'varchar' })
  file: string;

  @Column({ type: 'varchar', default: 'publishing' })
  status: 'publishing' | 'published' | 'failed';

  @Column({ name: 'media_id', type: 'varchar', nullable: true })
  mediaId: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
