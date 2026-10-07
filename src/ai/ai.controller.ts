import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { AiService } from './ai.service';

@UseGuards(AuthGuard)
@Controller('ai')
export class AiController {
  constructor(private readonly service: AiService) {}

  @Post('diagnose-post')
  diagnosePost(@Body() body: any) {
    return this.service.diagnosePost(body);
  }

  @Post('optimize-caption')
  optimizeCaption(@Body() body: { caption: string; mediaType?: string; username?: string }) {
    return this.service.optimizeCaption(body);
  }

  @Post('auto-tune-triggers')
  autoTuneTriggers(@Body() body: { comments: string[]; currentKeywords: string[] }) {
    return this.service.autoTuneTriggers(body);
  }

  @Post('generate-reply')
  generateReply(@Body() body: { username: string; commentText: string; caption?: string }) {
    return this.service.generateCommentReply(body);
  }

  @Post('generate-hashtags')
  generateHashtags(@Body() body: { caption: string; collaborator?: string }) {
    return this.service.generateHashtags(body.caption, body.collaborator);
  }

  @Post('story-reshare')
  storyReshare(@Body() body: { caption?: string; discussionDensity?: number; topComment?: string; lifecyclePhase?: string }) {
    return this.service.generateStoryReshare(body);
  }
}
