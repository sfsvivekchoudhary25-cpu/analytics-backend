import { Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
import { InstagramConnectionService } from './instagram-connection.service';

@UseGuards(AuthGuard)
@Controller('instagram/connection')
export class InstagramConnectionController {
  constructor(private readonly service: InstagramConnectionService) {}

  @Get()
  status(@CurrentAccount() account?: string) {
    return this.service.getStatus(account);
  }

  @Delete()
  disconnect(@CurrentAccount() account?: string) {
    return this.service.disconnect(account);
  }

  @Post('wipe-data')
  wipeData(@CurrentAccount() account?: string) {
    return this.service.wipeAccountData(account);
  }

  @Post('sync-permissions')
  syncPermissions(@CurrentAccount() account?: string) {
    return this.service.syncLivePermissions(account);
  }

  @Post('sync-profile')
  async syncProfile(@CurrentAccount() account?: string) {
    await this.service.syncLiveProfile(true, account);
    return this.service.getStatus(account);
  }
}

