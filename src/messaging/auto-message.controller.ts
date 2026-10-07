import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { AutoMessageService } from './auto-message.service';

@UseGuards(AuthGuard)
@Controller('messages/auto-reply')
export class AutoMessageController {
  constructor(private readonly service: AutoMessageService) {}

  @Get()
  get() {
    return this.service.getAutoReply();
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
  ) {
    return this.service.setAutoReply(body);
  }

  // Dashboard "Try it": what would the AI say to this message? Nothing is sent.
  @Post('ai-test')
  aiTest(@Body('text') text: string) {
    return this.service.aiTest(text);
  }

  // What automation did recently, including what it deliberately skipped and why.
  @Get('log')
  log() {
    return this.service.recent();
  }

  @Post('rules')
  addRule(@Body() body: { keywords?: string; replyText?: string }) {
    return this.service.addRule(body);
  }

  @Put('rules/:ruleId')
  updateRule(@Param('ruleId') ruleId: string, @Body() body: { keywords?: string; replyText?: string; enabled?: boolean }) {
    return this.service.updateRule(ruleId, body);
  }

  @Delete('rules/:ruleId')
  deleteRule(@Param('ruleId') ruleId: string) {
    return this.service.deleteRule(ruleId);
  }
}
