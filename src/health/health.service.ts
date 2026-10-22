import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class HealthService implements OnApplicationBootstrap {
  private readonly logger = new Logger('KeepAliveService');
  private lastPingAt: Date | null = null;
  private lastPingStatus: string = 'initialized';

  onApplicationBootstrap() {
    // Perform an initial warm-up ping 20 seconds after the app finishes bootstrapping
    setTimeout(() => {
      this.pingSelf().catch((err) => {
        this.logger.debug(`Initial warm-up ping notice: ${(err as Error).message}`);
      });
    }, 20_000);
  }

  // Ping every 12 minutes to prevent Render's 15-minute inactivity spin-down
  @Cron('*/12 * * * *')
  async keepAliveCron() {
    await this.pingSelf();
  }

  async pingSelf(): Promise<{ success: boolean; url: string; timestamp: string }> {
    const renderUrl =
      process.env.RENDER_EXTERNAL_URL ||
      process.env.PUBLIC_BASE_URL ||
      'https://analytics-backend-vxak.onrender.com';
    const targetUrl = `${renderUrl.replace(/\/$/, '')}/health`;

    try {
      this.logger.log(`[Keep-Alive] Dispatching anti-cooldown ping to ${targetUrl}...`);
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Render-AntiCooldown-KeepAlive/1.0',
          'X-Keep-Alive-Ping': 'true',
        },
        // 10 second timeout for the ping
        signal: AbortSignal.timeout(10_000),
      });

      this.lastPingAt = new Date();
      this.lastPingStatus = `HTTP ${response.status}`;

      if (response.ok) {
        this.logger.log(
          `[Keep-Alive] ✅ Render anti-cooldown ping succeeded (Status: ${response.status}, Uptime: ${Math.round(process.uptime())}s)`,
        );
        return { success: true, url: targetUrl, timestamp: this.lastPingAt.toISOString() };
      } else {
        this.logger.warn(
          `[Keep-Alive] ⚠️ Render ping responded with status ${response.status}`,
        );
        return { success: false, url: targetUrl, timestamp: this.lastPingAt.toISOString() };
      }
    } catch (err) {
      const errMsg = (err as Error).message;
      this.lastPingStatus = `Error: ${errMsg}`;
      // In local development or during transient DNS delays, log gracefully without throwing
      this.logger.warn(`[Keep-Alive] Ping notice for ${targetUrl}: ${errMsg}`);
      return { success: false, url: targetUrl, timestamp: new Date().toISOString() };
    }
  }

  getStatus() {
    return {
      status: 'active',
      schedule: 'Every 12 minutes (*/12 * * * *)',
      preventCooldownWindowMinutes: 15,
      lastPingAt: this.lastPingAt?.toISOString() || null,
      lastPingStatus: this.lastPingStatus,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
