import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { HashtagsService } from './hashtags.service';

@UseGuards(AuthGuard)
@Controller('hashtags')
export class HashtagsController {
  constructor(private readonly service: HashtagsService) {}

  @Get('search')
  search(@Query('q') query: string) {
    return this.service.search(query);
  }

  @Get('recently-searched')
  recentlySearched() {
    return this.service.getRecentlySearched();
  }

  @Get(':id/media')
  media(
    @Param('id') hashtagId: string,
    @Query('type') type?: 'top' | 'recent',
    @Query('limit') limit?: string,
  ) {
    const n = Number(limit);
    return this.service.getMedia(hashtagId, type === 'recent' ? 'recent' : 'top', n > 0 && n <= 50 ? n : 20);
  }
}
