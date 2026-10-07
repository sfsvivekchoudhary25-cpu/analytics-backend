import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { InstagramConnectionService } from './instagram-connection.service';

@UseGuards(AuthGuard)
@Controller('instagram/connection')
export class InstagramConnectionController {
  constructor(private readonly service: InstagramConnectionService) {}

  @Post()
  connect(@Body('accessToken') accessToken: string) {
    return this.service.connect(accessToken);
  }

  @Get()
  status() {
    return this.service.getStatus();
  }

  @Post('sync-permissions')
  syncPermissions() {
    return this.service.syncLivePermissions();
  }

  @Post('sync-profile')
  async syncProfile() {
    await this.service.syncLiveProfile(true);
    return this.service.getStatus();
  }
}
