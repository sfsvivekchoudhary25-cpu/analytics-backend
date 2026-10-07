import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CommentsService } from './comments.service';

@UseGuards(AuthGuard)
@Controller('comments')
export class CommentsController {
  constructor(private readonly service: CommentsService) {}

  @Get()
  list(@Query('filter') filter?: string) {
    return this.service.list(filter === 'unreplied' ? 'unreplied' : 'all');
  }

  @Get('posts')
  posts() {
    return this.service.postsWithComments();
  }

  // "Refresh" button: fetch from Instagram right now instead of waiting for the 2-minute poll.
  @Post('sync')
  sync() {
    return this.service.sync();
  }

  @Get('auto-reply')
  getAutoReply() {
    return this.service.getAutoReply();
  }

  @Put('auto-reply')
  setAutoReply(@Body() body: { enabled?: boolean; maxPerHour?: number; aiEnabled?: boolean; aiInstructions?: string }) {
    return this.service.setAutoReply(body);
  }

  // Dashboard "Try it": what would the AI say to this comment? Nothing is posted.
  @Post('auto-reply/ai-test')
  aiTest(@Body('text') text: string) {
    return this.service.aiTest(text);
  }

  @Post('auto-reply/rules')
  addRule(@Body() body: { keywords?: string; replyText?: string }) {
    return this.service.addRule(body);
  }

  @Put('auto-reply/rules/:ruleId')
  updateRule(@Param('ruleId') ruleId: string, @Body() body: { keywords?: string; replyText?: string; enabled?: boolean }) {
    return this.service.updateRule(ruleId, body);
  }

  @Delete('auto-reply/rules/:ruleId')
  deleteRule(@Param('ruleId') ruleId: string) {
    return this.service.deleteRule(ruleId);
  }

  @Post(':id/reply')
  reply(@Param('id') id: string, @Body('text') text: string) {
    return this.service.reply(id, text);
  }

  @Post('media-comment')
  postMediaCommentBody(@Body('mediaId') mediaId: string, @Body('message') message: string) {
    return this.service.postMediaComment(mediaId, message);
  }

  @Post('media/:mediaId/comment')
  postMediaComment(@Param('mediaId') mediaId: string, @Body('message') message: string) {
    return this.service.postMediaComment(mediaId, message);
  }

  @Post(':id/hide')
  hide(@Param('id') id: string, @Body('hidden') hidden: boolean) {
    return this.service.setHidden(id, hidden !== false);
  }

  @Post(':id/like')
  like(@Param('id') id: string) {
    return this.service.like(id);
  }

  @Delete(':id/like')
  unlike(@Param('id') id: string) {
    return this.service.unlike(id);
  }
}
