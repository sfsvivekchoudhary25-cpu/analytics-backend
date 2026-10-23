import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SavedReel } from './saved-reel.entity';

export interface SaveReelDto {
  id?: string;
  shortcode: string;
  url: string;
  videoUrl?: string | null;
  thumbnail?: string | null;
  caption?: string;
  author?: string;
  authorName?: string;
  authorUrl?: string;
  likes?: number;
  comments?: number;
  views?: number;
  quality?: string | null;
  duration?: number | null;
  uploadDate?: string | null;
  savedAt?: number;
}

@Injectable()
export class SavedReelsService {
  private readonly logger = new Logger(SavedReelsService.name);

  constructor(
    @InjectRepository(SavedReel)
    private readonly repo: Repository<SavedReel>,
  ) {}

  /**
   * Resolve owner username, defaulting to 'default' if not authenticated
   */
  private resolveOwner(ownerUsername?: string): string {
    return (ownerUsername || 'default').trim().replace(/^@/, '').toLowerCase();
  }

  /**
   * Fetch all saved reels for the given owner
   */
  async findAll(ownerUsername?: string): Promise<SavedReel[]> {
    const owner = this.resolveOwner(ownerUsername);
    return this.repo.find({
      where: [
        { ownerUsername: owner },
        { ownerUsername: 'default' }, // Fallback to shared/default vault
      ],
      order: { savedAt: 'DESC' },
    });
  }

  /**
   * Save or upsert a reel into the database vault
   */
  async save(dto: SaveReelDto, ownerUsername?: string): Promise<SavedReel> {
    const owner = this.resolveOwner(ownerUsername);
    const shortcode = String(dto.shortcode || '').trim();

    if (!shortcode) {
      throw new Error('Shortcode is required to save a reel');
    }

    let existing = await this.repo.findOne({
      where: {
        shortcode,
        ownerUsername: owner,
      },
    });

    if (existing) {
      existing.url = dto.url || existing.url;
      existing.videoUrl = dto.videoUrl !== undefined ? dto.videoUrl : existing.videoUrl;
      existing.thumbnail = dto.thumbnail !== undefined ? dto.thumbnail : existing.thumbnail;
      existing.caption = dto.caption !== undefined ? dto.caption : existing.caption;
      existing.author = dto.author || existing.author;
      existing.authorName = dto.authorName || existing.authorName;
      existing.authorUrl = dto.authorUrl || existing.authorUrl;
      existing.likes = Number(dto.likes ?? existing.likes);
      existing.comments = Number(dto.comments ?? existing.comments);
      existing.views = Number(dto.views ?? existing.views);
      existing.quality = dto.quality !== undefined ? dto.quality : existing.quality;
      existing.duration = dto.duration !== undefined ? dto.duration : existing.duration;
      existing.uploadDate = dto.uploadDate || existing.uploadDate;
      existing.savedAt = Number(dto.savedAt || Date.now());
      return this.repo.save(existing);
    }

    const newRecord = this.repo.create({
      ownerUsername: owner,
      shortcode,
      url: dto.url,
      videoUrl: dto.videoUrl || null,
      thumbnail: dto.thumbnail || null,
      caption: dto.caption || '',
      author: dto.author || 'instagram_user',
      authorName: dto.authorName || 'Instagram Creator',
      authorUrl: dto.authorUrl || `https://www.instagram.com/${dto.author || ''}`,
      likes: Number(dto.likes || 0),
      comments: Number(dto.comments || 0),
      views: Number(dto.views || 0),
      quality: dto.quality || '1080p',
      duration: dto.duration || null,
      uploadDate: dto.uploadDate || null,
      savedAt: Number(dto.savedAt || Date.now()),
    });

    return this.repo.save(newRecord);
  }

  /**
   * Delete a saved reel by shortcode
   */
  async remove(shortcode: string, ownerUsername?: string): Promise<{ success: boolean; shortcode: string }> {
    const owner = this.resolveOwner(ownerUsername);
    await this.repo.delete({
      shortcode,
      ownerUsername: owner,
    });
    return { success: true, shortcode };
  }

  /**
   * Bulk import / sync items (useful for migrating localStorage reels into the DB)
   */
  async syncBulk(items: SaveReelDto[], ownerUsername?: string): Promise<{ count: number }> {
    if (!Array.isArray(items) || items.length === 0) {
      return { count: 0 };
    }
    let count = 0;
    for (const item of items) {
      if (item && item.shortcode) {
        await this.save(item, ownerUsername);
        count++;
      }
    }
    return { count };
  }
}
