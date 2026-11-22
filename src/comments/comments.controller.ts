import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
import { CommentsService } from './comments.service';

@UseGuards(AuthGuard)
@Controller('comments')
export class CommentsController {
  constructor(private readonly service: CommentsService) {}

  @Get()
  list(@Query('filter') filter?: string, @CurrentAccount() account?: string) {
    return this.service.list(filter === 'unreplied' ? 'unreplied' : 'all', account);
  }

  @Get('auto-reply')
  getAutoReply(@CurrentAccount() account?: string) {
    return this.service.getAutoReply(account);
  }

  @Put('auto-reply')
  setAutoReply(
    @Body() body: { enabled?: boolean; maxPerHour?: number; aiEnabled?: boolean; aiInstructions?: string },
    @CurrentAccount() account?: string,
  ) {
    return this.service.setAutoReply(body, account);
  }

  // Dashboard "Try it": what would the AI say to this comment? Nothing is posted.
  @Post('auto-reply/ai-test')
  aiTest(@Body('text') text: string, @CurrentAccount() account?: string) {
    return this.service.aiTest(text, account);
  }

  @Post('auto-reply/rules')
  addRule(@Body() body: { keywords?: string; replyText?: string }, @CurrentAccount() account?: string) {
    return this.service.addRule(body, account);
  }

  @Put('auto-reply/rules/:ruleId')
  updateRule(
    @Param('ruleId') ruleId: string,
    @Body() body: { keywords?: string; replyText?: string; enabled?: boolean },
    @CurrentAccount() account?: string,
  ) {
    return this.service.updateRule(ruleId, body, account);
  }

  @Delete('auto-reply/rules/:ruleId')
  deleteRule(@Param('ruleId') ruleId: string, @CurrentAccount() account?: string) {
    return this.service.deleteRule(ruleId, account);
  }

  @Post('media-comment')
  postMediaCommentBody(@Body('mediaId') mediaId: string, @Body('message') message: string, @CurrentAccount() account?: string) {
    return this.service.postMediaComment(mediaId, message, account);
  }

  @Post('media/:mediaId/comment')
  postMediaComment(@Param('mediaId') mediaId: string, @Body('message') message: string, @CurrentAccount() account?: string) {
    return this.service.postMediaComment(mediaId, message, account);
  }

}
