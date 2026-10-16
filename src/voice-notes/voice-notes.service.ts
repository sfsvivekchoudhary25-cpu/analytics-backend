import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';
import { AiService } from '../ai/ai.service';
import { InstagramConnectionService } from '../instagram-connection/instagram-connection.service';
import { UPLOAD_DIR } from '../submissions/paths';
import { ActionItem, NoteCategory, VoiceNote } from './voice-note.entity';

export interface CreateVoiceNoteDto {
  rawTranscript: string;
  cleanedText?: string;
  title?: string;
  category?: NoteCategory;
  tags?: string[];
  actionItems?: ActionItem[];
  durationSeconds?: number;
  languageCode?: string;
  isPinned?: boolean;
}

export interface AudioUploadFile {
  buffer: Buffer;
  mimetype: string;
}

const VOICE_NOTES_DIR = join(UPLOAD_DIR, 'voice-notes');
try {
  mkdirSync(VOICE_NOTES_DIR, { recursive: true });
} catch {}

@Injectable()
export class VoiceNotesService {
  private readonly logger = new Logger('VoiceNotesService');

  constructor(
    @InjectRepository(VoiceNote) private readonly repo: Repository<VoiceNote>,
    private readonly aiService: AiService,
    private readonly connection: InstagramConnectionService,
  ) {}

  private async resolveOwner(ownerUsername?: string): Promise<string | null> {
    if (ownerUsername) return ownerUsername.trim().replace(/^@/, '').toLowerCase();
    const status: any = await this.connection.getStatus().catch(() => null);
    return status?.connected && status?.username ? String(status.username).trim().toLowerCase() : null;
  }

  // Fast AI cleanup preview (e.g., when the user finishes speaking, before saving)
  async previewCleanup(rawTranscript: string, languageCode = 'en-US') {
    if (!rawTranscript || !rawTranscript.trim()) {
      throw new BadRequestException('Raw transcript is required for cleanup.');
    }
    return this.aiService.cleanVoiceNote(rawTranscript, languageCode);
  }

  // Create & persist voice note
  async create(dto: CreateVoiceNoteDto, file?: AudioUploadFile, ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    const raw = (dto.rawTranscript || '').trim();

    if (!raw && !file) {
      throw new BadRequestException('Either voice transcript or audio recording is required.');
    }

    // 1. If cleaned text or title were not explicitly provided, run AI cleanup
    let finalTitle = dto.title?.trim();
    let finalCleaned = dto.cleanedText?.trim();
    let finalCategory = dto.category;
    let finalTags = dto.tags ?? [];
    let finalActionItems = dto.actionItems ?? [];

    if (!finalCleaned || !finalTitle) {
      const aiResult = await this.aiService.cleanVoiceNote(raw, dto.languageCode ?? 'en-US');
      if (!finalTitle) finalTitle = aiResult.title;
      if (!finalCleaned) finalCleaned = aiResult.cleanedText;
      if (!finalCategory) finalCategory = aiResult.category;
      if (!finalTags || finalTags.length === 0) finalTags = aiResult.tags;
      if (!finalActionItems || finalActionItems.length === 0) finalActionItems = aiResult.actionItems;
    }

    // 2. Handle Audio File Storage if uploaded
    let audioUrl: string | null = null;
    if (file && file.buffer) {
      try {
        const ext = file.mimetype.includes('mp4') ? 'mp4' : file.mimetype.includes('ogg') ? 'ogg' : file.mimetype.includes('wav') ? 'wav' : 'webm';
        const fileName = `${randomUUID()}.${ext}`;
        const filePath = join(VOICE_NOTES_DIR, fileName);
        await writeFile(filePath, file.buffer);
        audioUrl = `/media/voice-notes/${fileName}`;
      } catch (err) {
        this.logger.error(`Failed to store voice note audio: ${(err as Error).message}`);
      }
    }

    // 3. Build & save entity
    const note = this.repo.create({
      ownerUsername: own,
      title: finalTitle || 'Voice Note',
      cleanedText: finalCleaned || raw,
      rawTranscript: raw,
      category: finalCategory || 'idea',
      tags: finalTags,
      actionItems: finalActionItems,
      audioUrl,
      durationSeconds: dto.durationSeconds ? Math.round(Number(dto.durationSeconds)) : 0,
      languageCode: dto.languageCode || 'en-US',
      isPinned: !!dto.isPinned,
    });

    return this.repo.save(note);
  }

  // List voice notes with search, category filters, and tag filters
  async findAll(
    query?: { search?: string; category?: string; tag?: string; pinnedOnly?: boolean },
    ownerUsername?: string,
  ) {
    const own = await this.resolveOwner(ownerUsername);
    const qb = this.repo.createQueryBuilder('vn');

    if (own) {
      qb.where('vn.owner_username = :own', { own });
    }

    if (query?.category && query.category !== 'all') {
      qb.andWhere('vn.category = :cat', { cat: query.category });
    }

    if (query?.pinnedOnly) {
      qb.andWhere('vn.is_pinned = true');
    }

    if (query?.tag) {
      qb.andWhere(':tag = ANY(vn.tags)', { tag: query.tag.toLowerCase().trim() });
    }

    if (query?.search && query.search.trim()) {
      const term = `%${query.search.trim().toLowerCase()}%`;
      qb.andWhere(
        '(LOWER(vn.title) LIKE :term OR LOWER(vn.cleaned_text) LIKE :term OR LOWER(vn.raw_transcript) LIKE :term)',
        { term },
      );
    }

    qb.orderBy('vn.is_pinned', 'DESC')
      .addOrderBy('vn.created_at', 'DESC')
      .take(100);

    const notes = await qb.getMany();

    // Summary statistics
    const totalCount = notes.length;
    let totalTasks = 0;
    let completedTasks = 0;
    notes.forEach((n) => {
      (n.actionItems || []).forEach((t) => {
        totalTasks++;
        if (t.completed) completedTasks++;
      });
    });

    return {
      notes,
      stats: {
        totalNotes: totalCount,
        totalTasks,
        completedTasks,
        pendingTasks: totalTasks - completedTasks,
      },
    };
  }

  async findOne(id: string, ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    const where: FindOptionsWhere<VoiceNote> = { id };
    if (own) where.ownerUsername = own;

    const note = await this.repo.findOne({ where });
    if (!note) throw new NotFoundException('Voice note not found.');
    return note;
  }

  async update(id: string, dto: Partial<CreateVoiceNoteDto>, ownerUsername?: string) {
    const note = await this.findOne(id, ownerUsername);

    if (dto.title !== undefined) note.title = dto.title.trim() || 'Untitled Note';
    if (dto.cleanedText !== undefined) note.cleanedText = dto.cleanedText;
    if (dto.category !== undefined) note.category = dto.category;
    if (dto.tags !== undefined) note.tags = dto.tags;
    if (dto.actionItems !== undefined) note.actionItems = dto.actionItems;
    if (dto.isPinned !== undefined) note.isPinned = !!dto.isPinned;

    return this.repo.save(note);
  }

  // Toggle checklist item completion
  async toggleActionItem(id: string, itemId: string, completed: boolean, ownerUsername?: string) {
    const note = await this.findOne(id, ownerUsername);
    let found = false;

    note.actionItems = (note.actionItems || []).map((item) => {
      if (item.id === itemId) {
        found = true;
        return { ...item, completed };
      }
      return item;
    });

    if (!found) {
      throw new NotFoundException('Action item not found in this note.');
    }

    return this.repo.save(note);
  }

  async remove(id: string, ownerUsername?: string) {
    const note = await this.findOne(id, ownerUsername);

    // Delete audio file from disk if present
    if (note.audioUrl && note.audioUrl.startsWith('/media/voice-notes/')) {
      const fileName = note.audioUrl.replace('/media/voice-notes/', '');
      const filePath = join(VOICE_NOTES_DIR, fileName);
      unlink(filePath).catch(() => {});
    }

    await this.repo.remove(note);
    return { success: true, id };
  }
}
