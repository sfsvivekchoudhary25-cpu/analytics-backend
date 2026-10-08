import { Controller, Get, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
import { StoriesService, StoryUpload } from './stories.service';

@UseGuards(AuthGuard)
@Controller('stories')
export class StoriesController {
  constructor(private readonly service: StoriesService) {}

  @Get()
  list(@CurrentAccount() account?: string) {
    return this.service.list(account);
  }

  @Post()
  @UseInterceptors(FileInterceptor('media', { limits: { fileSize: 100 * 1024 * 1024 } }))
  publish(@UploadedFile() file: StoryUpload, @CurrentAccount() account?: string) {
    return this.service.publish(file, account);
  }
}
