import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
import { InstagramConnectionService } from './instagram-connection.service';

@UseGuards(AuthGuard)
@Controller('instagram/connection')
export class InstagramConnectionController {
  constructor(private readonly service: InstagramConnectionService) {}

  @Post()
  async connect(@Body('accessToken') accessToken: string, @Req() req: any) {
    const res = await this.service.connect(accessToken);
    await this.service.linkUserInstagramHandle(req.user?.id, res.username);
    return res;
  }

  @Get()
  status(@CurrentAccount() account?: string) {
    return this.service.getStatus(account);
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
