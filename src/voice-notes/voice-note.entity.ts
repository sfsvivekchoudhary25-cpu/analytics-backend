import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type NoteCategory = 'idea' | 'todo' | 'reminder' | 'instagram_caption' | 'client_note' | 'journal';

export interface ActionItem {
  id: string;
  text: string;
  completed: boolean;
  dueDate?: string | null;
}

@Entity('voice_note')
export class VoiceNote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'owner_username', type: 'varchar', nullable: true })
  ownerUsername: string | null;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ name: 'cleaned_text', type: 'text' })
  cleanedText: string;

  @Column({ name: 'raw_transcript', type: 'text' })
  rawTranscript: string;

  @Column({ type: 'varchar', default: 'idea' })
  category: NoteCategory;

  @Column({ type: 'simple-array', default: '' })
  tags: string[];

  @Column({ type: 'jsonb', default: [] })
  actionItems: ActionItem[];

  @Column({ name: 'audio_url', type: 'text', nullable: true })
  audioUrl: string | null;

  @Column({ name: 'duration_seconds', type: 'int', default: 0 })
  durationSeconds: number;

  @Column({ name: 'language_code', type: 'varchar', default: 'en-US' })
  languageCode: string;

  @Column({ name: 'is_pinned', type: 'boolean', default: false })
  isPinned: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
