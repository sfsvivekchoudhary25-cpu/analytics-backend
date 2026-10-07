import { Injectable, Logger } from '@nestjs/common';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

export interface CloudinaryHealth {
  status: 'operational' | 'degraded' | 'error' | 'not_configured';
  healthy: boolean;
  latencyMs: number;
  cloudName: string;
  cdnUrl: string;
  apiVerified: boolean;
  edgeDelivery: boolean;
  message: string;
  features: string[];
  timestamp: string;
}

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);
  private isConfigured = false;
  private cloudName: string = '';

  constructor() {
    this.init();
  }

  private init() {
    this.cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'hrnqhbaa';
    const apiKey = process.env.CLOUDINARY_API_KEY || '641864532532992';
    const apiSecret = process.env.CLOUDINARY_API_SECRET || 'TPuBbWT8rjKREWAkEGuvx64mXP4';

    if (this.cloudName && apiKey && apiSecret) {
      cloudinary.config({
        cloud_name: this.cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      });
      this.isConfigured = true;
      this.logger.log(`Cloudinary configured for cloud_name: ${this.cloudName}`);
    } else {
      this.logger.warn('Cloudinary environment variables not fully set.');
    }
  }

  getCloudName(): string {
    return this.cloudName;
  }

  async getHealth(): Promise<CloudinaryHealth> {
    const t0 = Date.now();
    const cloudName = this.cloudName || 'demo';

    try {
      // 1. Check CDN Edge
      const cdnUrl = `https://res.cloudinary.com/${cloudName}`;
      const cdnSampleUrl = `${cdnUrl}/image/upload/sample.jpg`;
      const edgeRes = await fetch(cdnSampleUrl, { method: 'HEAD' }).catch(() => null);
      const edgeOk = edgeRes ? edgeRes.status >= 200 && edgeRes.status < 400 : false;

      // 2. Check Admin API Ping
      let apiVerified = false;
      let authError = '';

      if (this.isConfigured) {
        try {
          const pingResult = await cloudinary.api.ping();
          if (pingResult && pingResult.status === 'ok') {
            apiVerified = true;
          }
        } catch (err: any) {
          authError = err?.message || 'API verification failed';
          this.logger.warn(`Cloudinary ping failed: ${authError}`);
        }
      }

      const latencyMs = Date.now() - t0;
      const healthy = apiVerified || edgeOk;
      const status = healthy ? 'operational' : 'degraded';

      return {
        status,
        healthy,
        latencyMs,
        cloudName,
        cdnUrl,
        apiVerified,
        edgeDelivery: edgeOk,
        message: healthy
          ? (apiVerified
              ? `Cloudinary API & Global CDN fully operational (${latencyMs}ms)`
              : `Cloudinary Edge CDN reachable (${latencyMs}ms)`)
          : (authError ? `Credentials error: ${authError}` : 'CDN edge unreachable'),
        features: [
          'f_auto (Smart Format: WebP/AVIF)',
          'q_auto (Intelligent Compression)',
          'Global Edge CDN Acceleration',
          'Direct HTTPS Meta Graph API Ingestion',
        ],
        timestamp: new Date().toISOString(),
      };
    } catch (err: any) {
      const latencyMs = Date.now() - t0;
      return {
        status: 'error',
        healthy: false,
        latencyMs,
        cloudName,
        cdnUrl: `https://res.cloudinary.com/${cloudName}`,
        apiVerified: false,
        edgeDelivery: false,
        message: err?.message || 'Cloudinary health check error',
        features: [],
        timestamp: new Date().toISOString(),
      };
    }
  }

  async uploadBuffer(
    buffer: Buffer,
    options: {
      folder?: string;
      resourceType?: 'image' | 'video' | 'auto';
      publicId?: string;
    } = {},
  ): Promise<UploadApiResponse> {
    const { folder = 'inro_social', resourceType = 'auto', publicId } = options;

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: resourceType,
          public_id: publicId,
          overwrite: true,
        },
        (error, result) => {
          if (error || !result) {
            this.logger.error('Cloudinary upload error:', error);
            return reject(error || new Error('Upload failed with no result'));
          }
          resolve(result);
        },
      );

      uploadStream.end(buffer);
    });
  }
}
