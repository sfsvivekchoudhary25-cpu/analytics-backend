import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from './audit-log.entity';

@Injectable()
export class AuditService {
  private readonly logger = new Logger('AuditService');

  constructor(
    @InjectRepository(AuditLog)
    private readonly repo: Repository<AuditLog>,
  ) {}

  async log(entry: {
    actorId?: string;
    actorEmail?: string;
    action: string;
    targetResource: string;
    targetId?: string;
    ipAddress?: string;
    userAgent?: string;
    details?: string | Record<string, any>;
  }): Promise<AuditLog | null> {
    try {
      const detailsStr =
        typeof entry.details === 'object'
          ? JSON.stringify(entry.details)
          : entry.details;

      const record = this.repo.create({
        actorId: entry.actorId,
        actorEmail: entry.actorEmail,
        action: entry.action,
        targetResource: entry.targetResource,
        targetId: entry.targetId,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        details: detailsStr,
      });

      const saved = await this.repo.save(record);
      this.logger.log(`[AUDIT] ${entry.action} on ${entry.targetResource} by ${entry.actorEmail || entry.actorId || 'system'}`);
      return saved;
    } catch (err: any) {
      this.logger.error(`Failed to record audit log: ${err?.message}`);
      return null;
    }
  }

  async getRecent(limit = 100): Promise<AuditLog[]> {
    return this.repo.find({
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 500),
    });
  }
}
