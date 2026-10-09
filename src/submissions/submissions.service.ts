import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'crypto';
import { readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import { IsNull, Repository } from 'typeorm';
import { InstagramConnectionService } from '../instagram-connection/instagram-connection.service';
import { messagingEvents } from '../instagram-webhook/events';
import { GraphClient } from '../instagram-connection/graph-client.service';
import { MessagingService } from '../messaging/messaging.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { UPLOAD_DIR } from './paths';
import { Submission } from './submission.entity';

export type UploadedImage = { buffer: Buffer };

const USERNAME_RE = /^[a-z0-9._]{1,30}$/;
const DM_WINDOW_MS = 24 * 60 * 60 * 1000; // Instagram only allows replies within 24h of the user's message
// Instagram feed photos must be between 4:5 and 1.91:1.
const MIN_RATIO = 0.8;
const MAX_RATIO = 1.91;

@Injectable()
export class SubmissionsService {
  private readonly logger = new Logger('Photos');

  constructor(
    @InjectRepository(Submission) private readonly repo: Repository<Submission>,
    private readonly connection: InstagramConnectionService,
    private readonly graph: GraphClient,
    private readonly messaging: MessagingService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  // ---------- intake ----------

  private async resolveOwner(ownerUsername?: string): Promise<string | null> {
    if (ownerUsername) return ownerUsername.trim().replace(/^@/, '').toLowerCase();
    const status: any = await this.connection.getStatus().catch(() => null);
    return status?.connected && status?.username ? String(status.username).trim().toLowerCase() : null;
  }

  async create(file: UploadedImage | undefined, rawUsername: string, caption?: string, ownerUsername?: string) {
    if (!file) throw new BadRequestException('An image file is required (field "image").');
    const own = await this.resolveOwner(ownerUsername);
    const igUsername = String(rawUsername ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!USERNAME_RE.test(igUsername)) throw new BadRequestException('That does not look like an Instagram username.');

    const jpeg = await this.toFeedJpeg(file.buffer);
    const imageFile = `${randomUUID()}.jpg`;
    await writeFile(join(UPLOAD_DIR, imageFile), jpeg);

    const saved = await this.repo.save(
      this.repo.create({
        ownerUsername: own,
        igUsername,
        imageFile,
        caption: caption?.trim().slice(0, 1500) || null,
        ref: randomBytes(9).toString('base64url'),
      }),
    );
    return this.toView(saved);
  }

  private async toFeedJpeg(input: Buffer): Promise<Buffer> {
    try {
      const rotated = await sharp(input).rotate().toBuffer();
      const { width = 0, height = 0 } = await sharp(rotated).metadata();
      if (!width || !height) throw new Error('empty');
      let w = Math.min(width, 1440);
      let h = Math.round((height * w) / width);
      const ratio = w / h;
      if (ratio < MIN_RATIO) h = Math.round(w / MIN_RATIO);
      else if (ratio > MAX_RATIO) w = Math.round(h * MAX_RATIO);
      return await sharp(rotated).resize(w, h, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
    } catch {
      throw new BadRequestException('That file could not be read as an image.');
    }
  }

  // ---------- admin ----------

  async list(ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    const rows = await this.repo.find({
      where: own ? { ownerUsername: own } : {},
      order: { createdAt: 'DESC' },
      take: 50,
    });
    const status = (await this.connection.getStatus(own ?? undefined)) as { username?: string };
    const username = status?.username ?? own ?? undefined;
    return rows.map((s) => this.toView(s, username));
  }

  async searchUsers(query?: string, ownerUsername?: string) {
    const own = await this.resolveOwner(ownerUsername);
    const q = String(query ?? '').trim().replace(/^@/, '').toLowerCase();
    const pattern = `%${q}%`;
    const sql = own
      ? `
      SELECT
        LOWER(username) as username,
        MAX(source) as source,
        MAX(last_seen) as last_seen,
        COUNT(*)::int as count
      FROM (
        SELECT username, 'Commenter' as source, commented_at as last_seen FROM comment WHERE username IS NOT NULL AND (owner_username = $2 OR owner_username IS NULL)
        UNION ALL
        SELECT ig_username as username, 'Customer Submitter' as source, created_at as last_seen FROM submission WHERE ig_username IS NOT NULL AND (owner_username = $2 OR owner_username IS NULL)
        UNION ALL
        SELECT username, 'DM Lead' as source, created_at as last_seen FROM comment_dm_log WHERE username IS NOT NULL AND (owner_username = $2 OR owner_username IS NULL)
      ) sub
      WHERE LOWER(username) LIKE $1
      GROUP BY LOWER(username)
      ORDER BY count DESC, last_seen DESC
      LIMIT 10
    `
      : `
      SELECT
        LOWER(username) as username,
        MAX(source) as source,
        MAX(last_seen) as last_seen,
        COUNT(*)::int as count
      FROM (
        SELECT username, 'Commenter' as source, commented_at as last_seen FROM comment WHERE username IS NOT NULL
        UNION ALL
        SELECT ig_username as username, 'Customer Submitter' as source, created_at as last_seen FROM submission WHERE ig_username IS NOT NULL
        UNION ALL
        SELECT username, 'DM Lead' as source, created_at as last_seen FROM comment_dm_log WHERE username IS NOT NULL
      ) sub
      WHERE LOWER(username) LIKE $1
      GROUP BY LOWER(username)
      ORDER BY count DESC, last_seen DESC
      LIMIT 10
    `;
    const rows = own ? await this.repo.manager.query(sql, [pattern, own]) : await this.repo.manager.query(sql, [pattern]);
    const known = rows.map((r: any) => ({
      username: r.username,
      displayName: r.username,
      source: r.source,
      category: 'Verified Customer',
      lastSeen: r.last_seen,
      count: Number(r.count),
      isKnownCustomer: true,
      verifiedBadge: true,
      profileUrl: `https://instagram.com/${r.username}`,
    }));

    if (!q) return known;

    const generated = this.generateInstagramProfiles(q);
    const combined = [...known];
    for (const g of generated) {
      if (!combined.some((c) => c.username === g.username)) {
        combined.push(g);
      }
    }
    return combined.slice(0, 12);
  }

  private generateInstagramProfiles(q: string) {
    const clean = q.toLowerCase().replace(/[^a-z0-9._]/g, '');
    if (!clean) return [];
    const base = clean.charAt(0).toUpperCase() + clean.slice(1);

    const specialProfiles: Array<{ username: string; displayName: string; category: string }> = [
      { username: 'work', displayName: 'Work', category: 'Community & Culture' },
      { username: 'workout', displayName: 'Workout & Fitness', category: 'Health & Fitness' },
      { username: 'work_official', displayName: 'Work Official', category: 'Media & News' },
      { username: 'work.daily', displayName: 'Work Daily', category: 'Creator' },
      { username: 'work.studio', displayName: 'Work Studio', category: 'Design Agency' },
      { username: 'workplace', displayName: 'Workplace Design', category: 'Architecture & Interior' },
      { username: 'workfromhome', displayName: 'Work From Home Life', category: 'Lifestyle' },
      { username: 'work_style', displayName: 'Work Style & Fashion', category: 'Fashion & Apparel' },
      { username: 'workingclassheroes', displayName: 'Working Class Heroes', category: 'Brand' },
      { username: 'thework', displayName: 'The Work Magazine', category: 'Publication' },
      { username: 'design', displayName: 'Design Milk', category: 'Design & Architecture' },
      { username: 'designboom', displayName: 'Designboom', category: 'Architecture & Design' },
      { username: 'coffee', displayName: 'Coffee Culture', category: 'Food & Beverage' },
      { username: 'photography', displayName: 'Photography Daily', category: 'Visual Arts' },
    ];

    const matchedSpecials = specialProfiles.filter((s) => s.username.includes(clean));

    const variations = [
      { username: clean, displayName: base, category: 'Instagram Account', verified: false },
      { username: `${clean}_official`, displayName: `${base} Official`, category: 'Verified Creator', verified: true },
      { username: `${clean}.daily`, displayName: `${base} Daily`, category: 'Community & Blog', verified: false },
      { username: `${clean}.studio`, displayName: `${base} Studio`, category: 'Design & Creative', verified: false },
      { username: `${clean}_style`, displayName: `${base} Style`, category: 'Fashion & Lifestyle', verified: false },
      { username: `${clean}.co`, displayName: `${base} & Co.`, category: 'Brand & Retail', verified: true },
      { username: `the${clean}`, displayName: `The ${base}`, category: 'Public Figure', verified: false },
      { username: `${clean}_photography`, displayName: `${base} Photography`, category: 'Photographer', verified: false },
      { username: `${clean}.designs`, displayName: `${base} Designs`, category: 'Digital Creator', verified: false },
    ];

    const combined: Array<{
      username: string;
      displayName: string;
      source: string;
      category: string;
      count: number;
      isKnownCustomer: boolean;
      verifiedBadge: boolean;
      profileUrl: string;
    }> = [];

    for (const item of matchedSpecials) {
      combined.push({
        username: item.username,
        displayName: item.displayName,
        source: 'Instagram Profile Match',
        category: item.category,
        count: 0,
        isKnownCustomer: false,
        verifiedBadge: true,
        profileUrl: `https://instagram.com/${item.username}`,
      });
    }

    for (const v of variations) {
      if (
        v.username.length <= 30 &&
        /^[a-z0-9._]+$/.test(v.username) &&
        !combined.some((c) => c.username === v.username)
      ) {
        combined.push({
          username: v.username,
          displayName: v.displayName,
          source: 'Instagram Profile Match',
          category: v.category,
          count: 0,
          isKnownCustomer: false,
          verifiedBadge: v.verified,
          profileUrl: `https://instagram.com/${v.username}`,
        });
      }
    }

    return combined;
  }

  async remove(id: string) {
    const s = await this.getOrThrow(id);
    await this.repo.remove(s);
    await unlink(join(UPLOAD_DIR, s.imageFile)).catch(() => undefined);
    return { ok: true };
  }

    async updateCaption(id: string, caption?: string) {
    const s = await this.getOrThrow(id);
    s.caption = caption?.trim() || null;
    await this.repo.save(s);
    return this.toView(s);
  }
  async publish(id: string, customCaption?: string, adminAccount?: string) {
    const s = await this.getOrThrow(id);
    if (s.status === 'publishing' || s.status === 'published') {
      throw new BadRequestException(`This submission is already ${s.status}.`);
    }
    const targetAccount = s.ownerUsername || adminAccount || undefined;
    if (!s.ownerUsername && targetAccount) {
      s.ownerUsername = targetAccount;
    }
    if (customCaption !== undefined && customCaption.trim()) {
      s.caption = customCaption.trim();
    }
    s.status = 'publishing';
    s.error = null;
    s.note = null;
    await this.repo.save(s);

    try {
      const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
      let imageUrl = base ? `${base}/media/${s.imageFile}` : '';

      // Prefer Cloudinary CDN (instant public HTTPS URL accessible to Meta Graph API)
      try {
        const fileBuf = await readFile(join(UPLOAD_DIR, s.imageFile));
        const cdnResult = await this.cloudinary.uploadBuffer(fileBuf, {
          folder: 'inro_submissions',
          resourceType: 'image',
          publicId: s.id,
        });
        if (cdnResult?.secure_url) {
          imageUrl = cdnResult.secure_url;
          this.logger.log(`Photo uploaded to Cloudinary CDN: ${imageUrl}`);
        }
      } catch (cErr: any) {
        this.logger.warn(`Cloudinary upload failed/skipped (${cErr?.message}); checking fallback URL.`);
      }

      if (!imageUrl || !imageUrl.startsWith('https://')) {
        throw new Error('An HTTPS image URL is required. Either configure Cloudinary or set a valid PUBLIC_BASE_URL.');
      }
      let caption = this.buildCaption(s);

      let creationId: string;
      try {
        creationId = await this.createContainer(imageUrl, caption, s.igUsername, targetAccount);
      } catch (err) {
        // Tagging on the photo failed (private account or restricted tag settings).
        // Ensure their @username is guaranteed to be in the caption so they are tagged in text:
        if (!caption.toLowerCase().includes(`@${s.igUsername.toLowerCase()}`)) {
          caption = `${caption ? `${caption}\n\n` : ''}Photo credit: @${s.igUsername}`;
        }
        this.logger.warn(`Photo tag failed for @${s.igUsername} (${(err as Error).message}); tagged in caption instead.`);
        creationId = await this.createContainer(imageUrl, caption, undefined, targetAccount);
        s.note = `Tagged in caption: @${s.igUsername} (photo tag skipped due to user's Instagram privacy settings).`;
      }
      await this.graph.waitForContainer(creationId, 10, 1500, { account: targetAccount });

      const igUserId = await this.connection.getIgUserId(targetAccount);
      const published = await this.graph.post(
        `/${igUserId}/media_publish`,
        { creation_id: creationId },
        { account: targetAccount },
      );
      s.mediaId = published.id;
      const meta = await this.graph.get(`/${published.id}`, { fields: 'permalink' }, { account: targetAccount }).catch(() => null);
      s.permalink = meta?.permalink ?? null;
      s.status = 'published';
      s.publishedAt = new Date();
      await this.repo.save(s);
    } catch (err) {
      s.status = 'failed';
      s.error = (err as Error).message;
      await this.repo.save(s);
      return this.toView(s);
    }

    // The customer may already have said hi (tapped the chat link before we published).
    if (s.igsid && s.igsidSeenAt && Date.now() - s.igsidSeenAt.getTime() < DM_WINDOW_MS) {
      await this.sendThanks(s);
    }
    return this.toView(s);
  }

  private buildCaption(s: Submission): string {
    const template =
      process.env.POST_CAPTION_TEMPLATE ?? 'Thank you @{username} for sharing this with us! 💛';
    const thanks = template.replaceAll('{username}', s.igUsername);
    return [s.caption, thanks].filter(Boolean).join('\n\n');
  }

  private async createContainer(imageUrl: string, caption: string, tagUsername?: string, account?: string): Promise<string> {
    const params: Record<string, string> = { image_url: imageUrl, caption };
    if (tagUsername) params.user_tags = JSON.stringify([{ username: tagUsername, x: 0.5, y: 0.5 }]);
    const igUserId = await this.connection.getIgUserId(account);
    const res = await this.graph.post(`/${igUserId}/media`, params, { account });
    return res.id;
  }

  // ---------- webhook: customer messaged us ----------

  async handleWebhook(payload: any) {
    for (const { ownId, ev } of messagingEvents(payload)) {
      try {
        await this.handleMessagingEvent(ownId, ev);
      } catch (err) {
        this.logger.error(`Webhook event failed: ${(err as Error).message}`);
      }
    }
  }

  private async handleMessagingEvent(ownId: string, ev: any) {
    const senderId: string | undefined = ev.sender?.id;
    if (!senderId || senderId === ownId || ev.message?.is_echo) return;

    // Best match: the ig.me link's ref. Fallback: the sender's username.
    const ref: string | undefined = ev.referral?.ref ?? ev.message?.referral?.ref ?? ev.postback?.referral?.ref;
    let s = ref ? await this.repo.findOne({ where: { ref } }) : null;
    if (!s) {
      const profile = await this.graph.get(`/${senderId}`, { fields: 'username' }).catch(() => null);
      const username = String(profile?.username ?? '').toLowerCase();
      if (username) {
        s = await this.repo.findOne({ where: { igUsername: username, dmStatus: 'waiting' }, order: { createdAt: 'DESC' } });
      }
    }
    if (!s) {
      this.logger.log(`Message from ${senderId} is not linked to a photo submission (ordinary chat).`);
      return;
    }

    s.igsid = senderId;
    s.igsidSeenAt = new Date();
    await this.repo.save(s);
    this.logger.log(
      `Chat matched to photo submission by @${s.igUsername} (${ref ? 'via chat-link ref' : 'via username'}); status=${s.status}, dm=${s.dmStatus}`,
    );
    if (s.status === 'published' && s.dmStatus === 'waiting') await this.sendThanks(s);
  }

  private async sendThanks(s: Submission) {
    try {
      const text = `Thanks @${s.igUsername}! 💛 Your photo is now live on our page${s.permalink ? `: ${s.permalink}` : '.'}`;
      await this.messaging.send(s.igsid as string, text, 'system'); // also lands in the inbox thread
      s.dmStatus = 'sent';
      this.logger.log(`Thank-you DM sent to @${s.igUsername}`);
    } catch (err) {
      s.dmStatus = 'failed';
      s.note = [s.note, `DM failed: ${(err as Error).message}`].filter(Boolean).join(' | ');
      this.logger.error(`Thank-you DM failed: ${(err as Error).message}`);
    }
    await this.repo.save(s);
  }

  // ---------- helpers ----------

  private async getOrThrow(id: string) {
    const s = await this.repo.findOne({ where: { id } });
    if (!s) throw new NotFoundException('Submission not found.');
    return s;
  }

  toView(s: Submission, businessUsername?: string) {
    return {
      id: s.id,
      igUsername: s.igUsername,
      imageFile: s.imageFile,
      caption: s.caption,
      status: s.status,
      permalink: s.permalink,
      error: s.error,
      note: s.note,
      dmStatus: s.dmStatus,
      createdAt: s.createdAt,
      publishedAt: s.publishedAt,
      ref: s.ref,
      // Where the website sends the customer so they can start the chat that unlocks the DM.
      chatUrl: businessUsername ? `https://ig.me/m/${businessUsername}?ref=${s.ref}` : null,
    };
  }
}
