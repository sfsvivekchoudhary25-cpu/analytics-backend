import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
import { MessagingService } from './messaging.service';

@UseGuards(AuthGuard)
@Controller('messages')
export class MessagingController {
  constructor(private readonly service: MessagingService) {}

  // "Refresh from Instagram": import conversations and messages we don't have yet.
  @Post('sync')
  sync(@CurrentAccount() account?: string) {
    return this.service.syncFromInstagram(account);
  }

  @Get('conversations')
  list(@CurrentAccount() account?: string) {
    return this.service.listConversations(account);
  }

  // Opening a thread marks it as read.
  @Get('conversations/:igsid')
  thread(@Param('igsid') igsid: string, @CurrentAccount() account?: string) {
    return this.service.thread(igsid, account);
  }

  @Delete('conversations/:igsid')
  remove(@Param('igsid') igsid: string, @CurrentAccount() account?: string) {
    return this.service.deleteConversation(igsid, account);
  }

  @Post('conversations/:igsid/reply')
  reply(@Param('igsid') igsid: string, @Body('text') text: string, @CurrentAccount() account?: string) {
    return this.service.reply(igsid, text, account);
  }
}
