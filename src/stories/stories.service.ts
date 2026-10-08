import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import { IsNull, Repository } from 'typeorm';
import { GraphClient } from '../instagram-connection/graph-client.service';
import { InstagramConnectionService } from '../instagram-connection/instagram-connection.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { UPLOAD_DIR } from '../submissions/paths';
import { Story } from './story.entity';

export type StoryUpload = { buffer: Buffer; mimetype: string };

@Injectable()
export class StoriesService {
  constructor(
    @InjectRepository(Story) private readonly repo: Repository<Story>,
    private readonly graph: GraphClient,
    private readonly connection: InstagramConnectionService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  private async resolveOwner(ownerUsername?: string): Promise<string | null> {
    if (ownerUsername) return ownerUsername.trim().replace(/^@/, '').toLowerCase();
    const status: any = await this.connection.getStatus().catch(() => null);
    return status?.connected && status?.username ? String(status.username).trim().toLowerCase() : null;
  }

  async list(ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    return this.repo.find({
      where: own ? { ownerUsername: own } : {},
      order: { createdAt: 'DESC' },
      take: 30,
    });
  }

  // Uploads and publishes immediately (images take seconds, videos up to ~2 minutes).
  async publish(file: StoryUpload | undefined, ownerUsername?: string) {
    if (!file) throw new BadRequestException('Choose an image or video (field "media").');

    const own = await this.resolveOwner(ownerUsername);
    let kind: Story['kind'];
    let name: string;
    if (file.mimetype.startsWith('image/')) {
      kind = 'image';
      name = `${randomUUID()}.jpg`;
      await writeFile(join(UPLOAD_DIR, name), await this.toStoryJpeg(file.buffer));
    } else if (file.mimetype === 'video/mp4' || file.mimetype === 'video/quicktime') {
      // No transcoding here: Instagram wants H.264 video / AAC audio, ideally 9:16 and under 60s.
      kind = 'video';
      name = `${randomUUID()}.${file.mimetype === 'video/mp4' ? 'mp4' : 'mov'}`;
      await writeFile(join(UPLOAD_DIR, name), file.buffer);
    } else {
      throw new BadRequestException('Only images, MP4 or MOV videos can be posted as stories.');
    }

    const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
    let mediaUrl = base ? `${base}/media/${name}` : '';

    // Prefer Cloudinary CDN (instant public HTTPS URL accessible to Meta Graph API)
    try {
      const cdnResult = await this.cloudinary.uploadBuffer(file.buffer, {
        folder: 'inro_stories',
        resourceType: kind === 'video' ? 'video' : 'image',
      });
      if (cdnResult?.secure_url) {
        mediaUrl = cdnResult.secure_url;
      }
    } catch {
      // Fallback to local media URL via PUBLIC_BASE_URL
    }

    if (!mediaUrl || !mediaUrl.startsWith('https://')) {
      throw new BadRequestException('PUBLIC_BASE_URL must be a public https URL or Cloudinary must be configured so Instagram can fetch the file.');
    }

    const story = await this.repo.save(this.repo.create({ kind, file: name, status: 'publishing', ownerUsername: own }));
    try {
      const igUserId = await this.connection.getIgUserId(own ?? undefined);
      const container = await this.graph.post(
        `/${igUserId}/media`,
        {
          media_type: 'STORIES',
          ...(kind === 'image' ? { image_url: mediaUrl } : { video_url: mediaUrl }),
        },
        { account: own ?? undefined },
      );
      if (kind === 'video') await this.graph.waitForContainer(container.id, 60, 2000);
      else await this.graph.waitForContainer(container.id);
      const published = await this.graph.post(
        `/${igUserId}/media_publish`,
        { creation_id: container.id },
        { account: own ?? undefined },
      );
      story.mediaId = published.id;
      story.status = 'published';
    } catch (err) {
      story.status = 'failed';
      story.error = (err as Error).message;
    }
    return this.repo.save(story);
  }

  // 1080x1920 (9:16). The photo is kept whole and centred over a blurred, darkened copy of itself.
  private async toStoryJpeg(input: Buffer): Promise<Buffer> {
    try {
      const rotated = await sharp(input).rotate().toBuffer();
      const bg = await sharp(rotated).resize(1080, 1920, { fit: 'cover' }).blur(40).modulate({ brightness: 0.7 }).toBuffer();
      const fg = await sharp(rotated).resize(1080, 1920, { fit: 'inside' }).toBuffer();
      return await sharp(bg).composite([{ input: fg, gravity: 'center' }]).jpeg({ quality: 90 }).toBuffer();
    } catch {
      throw new BadRequestException('That file could not be read as an image.');
    }
  }
}
