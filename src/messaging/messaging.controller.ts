import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
import { MessagingService } from './messaging.service';

@UseGuards(AuthGuard)
@Controller('messages')
export class MessagingController {
  constructor(private readonly service: MessagingService) {}

  // The "Don't store my messages" switch.
  @Get('privacy')
  getPrivacy(@CurrentAccount() account?: string) {
    return this.service.getPrivacy(account);
  }

  @Post('privacy')
  setPrivacy(@Body('storeMessages') storeMessages: boolean, @CurrentAccount() account?: string) {
    return this.service.setPrivacy(account, storeMessages !== false);
  }
}
