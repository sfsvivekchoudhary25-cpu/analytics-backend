import { Controller, Get, Post } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  check() {
    return {
      status: 'ok',
      service: 'Fabroniee Instagram Commerce Engine',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      renderCooldownProtection: 'active',
      keepAlive: this.healthService.getStatus(),
    };
  }

  @Post('ping')
  async triggerPing() {
    return this.healthService.pingSelf();
  }
}
