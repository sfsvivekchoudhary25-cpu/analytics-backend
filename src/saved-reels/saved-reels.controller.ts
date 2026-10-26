import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { CurrentAccount } from '../common/current-account.decorator';
import { SaveReelDto, SavedReelsService } from './saved-reels.service';

@Controller('saved-reels')
export class SavedReelsController {
  constructor(private readonly service: SavedReelsService) {}

  @Get()
  async findAll(@CurrentAccount() account?: string, @Req() req?: any) {
    const owner = account || req?.headers?.['x-instagram-account'];
    return this.service.findAll(owner);
  }

  @Post()
  async save(@Body() dto: SaveReelDto, @CurrentAccount() account?: string, @Req() req?: any) {
    const owner = account || req?.headers?.['x-instagram-account'];
    return this.service.save(dto, owner);
  }

  @Delete(':shortcode')
  async remove(@Param('shortcode') shortcode: string, @CurrentAccount() account?: string, @Req() req?: any) {
    const owner = account || req?.headers?.['x-instagram-account'];
    return this.service.remove(shortcode, owner);
  }

  @Post('sync')
  async syncBulk(@Body('items') items: SaveReelDto[], @CurrentAccount() account?: string, @Req() req?: any) {
    const owner = account || req?.headers?.['x-instagram-account'];
    return this.service.syncBulk(items, owner);
  }
}
