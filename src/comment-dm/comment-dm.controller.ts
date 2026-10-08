import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
import { CommentDmService } from './comment-dm.service';

@UseGuards(AuthGuard)
@Controller('comment-dm')
export class CommentDmController {
  constructor(private readonly service: CommentDmService) {}

  @Get('automations')
  list(@CurrentAccount() account?: string) {
    return this.service.list(account);
  }

  @Post('automations')
  create(@CurrentAccount() account?: string) {
    return this.service.create(account);
  }

  @Get('automations/:id')
  getOne(@Param('id') id: string, @CurrentAccount() account?: string) {
    return this.service.getOne(id, account);
  }

  @Get('automations/:id/logs')
  logs(@Param('id') id: string, @Query('limit') limit?: string, @CurrentAccount() account?: string) {
    const n = Number(limit);
    return this.service.logsForRule(id, n > 0 && n <= 200 ? n : 50, account);
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
    @CurrentAccount() account?: string,
  ) {
    return this.service.update(id, body, account);
  }

  @Delete('automations/:id')
  remove(@Param('id') id: string, @CurrentAccount() account?: string) {
    return this.service.remove(id, account);
  }

  @Get('posts')
  posts(@CurrentAccount() account?: string) {
    return this.service.recentPosts(account);
  }

  // One combined dashboard across every automation, shown on the list page.
  @Get('stats')
  stats(@Query('days') days?: string, @CurrentAccount() account?: string) {
    const n = Number(days);
    return this.service.overallStats([7, 14, 30].includes(n) ? n : 30, account);
  }

  // Full detail bundle for a single post (comments + automations + stats + timeline).
  @Get('post/:mediaId')
  postDetail(@Param('mediaId') mediaId: string, @Query('days') days?: string, @CurrentAccount() account?: string) {
    const n = Number(days);
    return this.service.postDetail(mediaId, [7, 14, 30].includes(n) ? n : 30, account);
  }
}

