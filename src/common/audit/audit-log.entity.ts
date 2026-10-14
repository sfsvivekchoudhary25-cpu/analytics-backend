import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  actorId?: string;

  @Column({ nullable: true })
  actorEmail?: string;

  @Column()
  action: string;

  @Column()
  targetResource: string;

  @Column({ nullable: true })
  targetId?: string;

  @Column({ nullable: true })
  ipAddress?: string;

  @Column({ nullable: true })
  userAgent?: string;

  @Column({ type: 'text', nullable: true })
  details?: string;

  @CreateDateColumn()
  createdAt: Date;
}
