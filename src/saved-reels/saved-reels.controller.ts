import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount, NO_ACCOUNT } from '../common/current-account.decorator';
import { SaveReelDto, SavedReelsService } from './saved-reels.service';

// Login required. Each user's vault is their own: keyed by their Instagram account, or by their email until they
// have one. There is no shared/"default" vault and the x-instagram-account header is never trusted on its own.
@UseGuards(AuthGuard)
@Controller('saved-reels')
export class SavedReelsController {
  constructor(private readonly service: SavedReelsService) {}

  private owner(account: string | undefined, req: any): string {
    if (account && account !== NO_ACCOUNT) return account;
    return String(req?.user?.email ?? '').trim().toLowerCase();
  }

  @Get()
  async findAll(@CurrentAccount() account?: string, @Req() req?: any) {
    return this.service.findAll(this.owner(account, req));
  }

  @Post()
  async save(@Body() dto: SaveReelDto, @CurrentAccount() account?: string, @Req() req?: any) {
    return this.service.save(dto, this.owner(account, req));
  }

  @Delete(':shortcode')
  async remove(@Param('shortcode') shortcode: string, @CurrentAccount() account?: string, @Req() req?: any) {
    return this.service.remove(shortcode, this.owner(account, req));
  }

  @Post('sync')
  async syncBulk(@Body('items') items: SaveReelDto[], @CurrentAccount() account?: string, @Req() req?: any) {
    return this.service.syncBulk(items, this.owner(account, req));
  }
}
