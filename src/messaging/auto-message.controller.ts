import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
import { AutoMessageService } from './auto-message.service';

@UseGuards(AuthGuard)
@Controller('messages/auto-reply')
export class AutoMessageController {
  constructor(private readonly service: AutoMessageService) {}

  @Get()
  get(@CurrentAccount() account?: string) {
    return this.service.getAutoReply(account);
  }

  @Put()
  set(
    @Body()
    body: {
      enabled?: boolean;
      maxPerHour?: number;
      aiEnabled?: boolean;
      aiInstructions?: string;
      fallbackEnabled?: boolean;
      fallbackText?: string;
    },
    @CurrentAccount() account?: string,
  ) {
    return this.service.setAutoReply(body, account);
  }

  // Dashboard "Try it": what would the AI say to this message? Nothing is sent.
  @Post('ai-test')
  aiTest(@Body('text') text: string) {
    return this.service.aiTest(text);
  }

  // What automation did recently, including what it deliberately skipped and why.
  @Get('log')
  log(@CurrentAccount() account?: string) {
    return this.service.recent(account);
  }

  @Post('rules')
  addRule(@Body() body: { keywords?: string; replyText?: string }, @CurrentAccount() account?: string) {
    return this.service.addRule(body, account);
  }

  @Put('rules/:ruleId')
  updateRule(
    @Param('ruleId') ruleId: string,
    @Body() body: { keywords?: string; replyText?: string; enabled?: boolean },
    @CurrentAccount() account?: string,
  ) {
    return this.service.updateRule(ruleId, body, account);
  }

  @Delete('rules/:ruleId')
  deleteRule(@Param('ruleId') ruleId: string, @CurrentAccount() account?: string) {
    return this.service.deleteRule(ruleId, account);
  }
}
