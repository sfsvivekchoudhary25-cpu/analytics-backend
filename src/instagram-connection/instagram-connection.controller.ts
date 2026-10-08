import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
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
  status(@CurrentAccount() account?: string) {
    return this.service.getStatus(account);
  }

  @Get('accounts')
  accounts() {
    return this.service.listConnectedAccounts();
  }

  @Post('switch')
  switchAccount(@Body('username') username: string) {
    return this.service.touchAccount(username);
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
