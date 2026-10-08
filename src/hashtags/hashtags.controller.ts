import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
import { HashtagsService } from './hashtags.service';

@UseGuards(AuthGuard)
@Controller('hashtags')
export class HashtagsController {
  constructor(private readonly service: HashtagsService) {}

  @Get('search')
  search(@Query('q') query: string, @CurrentAccount() account?: string) {
    return this.service.search(query, account);
  }

  @Get('recently-searched')
  recentlySearched(@CurrentAccount() account?: string) {
    return this.service.getRecentlySearched(account);
  }

  @Get(':id/media')
  media(
    @Param('id') hashtagId: string,
    @Query('type') type?: 'top' | 'recent',
    @Query('limit') limit?: string,
    @CurrentAccount() account?: string,
  ) {
    const n = Number(limit);
    return this.service.getMedia(hashtagId, type === 'recent' ? 'recent' : 'top', n > 0 && n <= 50 ? n : 20, account);
  }
}
