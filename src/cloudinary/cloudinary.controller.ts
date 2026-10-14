import {
  BadRequestException,
  Controller,
  Get,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { CloudinaryService, CloudinaryHealth } from './cloudinary.service';

@UseGuards(AuthGuard)
@Controller('integrations/cloudinary')
export class CloudinaryController {
  constructor(private readonly cloudinaryService: CloudinaryService) {}

  @Get()
  async getHealth(): Promise<CloudinaryHealth> {
    return this.cloudinaryService.getHealth();
  }

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 15 * 1024 * 1024 }, // Up to 15MB
    }),
  )
  async uploadImage(@UploadedFile() file?: { buffer: Buffer; mimetype?: string }) {
    if (!file || !file.buffer) {
      throw new BadRequestException('No image file provided for upload.');
    }

    if (file.mimetype && !file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Uploaded file must be a valid image (JPG, PNG, WebP, GIF).');
    }

    try {
      const result = await this.cloudinaryService.uploadBuffer(file.buffer, {
        folder: 'inro_automation',
        resourceType: 'image',
      });

      return {
        success: true,
        url: result.secure_url || result.url,
        publicId: result.public_id,
        format: result.format,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
      };
    } catch (err: any) {
      throw new BadRequestException(err?.message || 'Failed to upload image to Cloudinary.');
    }
  }
}

