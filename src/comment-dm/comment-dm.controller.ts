import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CommentDmService } from './comment-dm.service';

@UseGuards(AuthGuard)
@Controller('comment-dm')
export class CommentDmController {
  constructor(private readonly service: CommentDmService) {}

  @Get('automations')
  list() {
    return this.service.list();
  }

  @Post('automations')
  create() {
    return this.service.create();
  }

  @Get('automations/:id')
  getOne(@Param('id') id: string) {
    return this.service.getOne(id);
  }

  @Get('automations/:id/logs')
  logs(@Param('id') id: string, @Query('limit') limit?: string) {
    const n = Number(limit);
    return this.service.logsForRule(id, n > 0 && n <= 200 ? n : 50);
  }

  @Put('automations/:id')
  update(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      enabled?: boolean;
      keywords?: string;
      dmText?: string;
      requireFollow?: boolean;
      followGateText?: string;
      templateType?: 'text' | 'button' | 'product' | 'file' | 'card';
      cardTitle?: string | null;
      cardSubtitle?: string | null;
      cardImageUrl?: string | null;
      cardFileUrl?: string | null;
      cardButtons?: any;
      mediaId?: string | null;
      mediaPermalink?: string | null;
      mediaThumb?: string | null;
    },
  ) {
    return this.service.update(id, body);
  }

  @Delete('automations/:id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Get('posts')
  posts() {
    return this.service.recentPosts();
  }

  // One combined dashboard across every automation, shown on the list page.
  @Get('stats')
  stats(@Query('days') days?: string) {
    const n = Number(days);
    return this.service.overallStats([7, 14, 30].includes(n) ? n : 30);
  }

  // Full detail bundle for a single post (comments + automations + stats + timeline).
  @Get('post/:mediaId')
  postDetail(@Param('mediaId') mediaId: string, @Query('days') days?: string) {
    const n = Number(days);
    return this.service.postDetail(mediaId, [7, 14, 30].includes(n) ? n : 30);
  }
}

