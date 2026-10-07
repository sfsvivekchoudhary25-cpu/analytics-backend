import { Controller, Get, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { StoriesService, StoryUpload } from './stories.service';

@UseGuards(AuthGuard)
@Controller('stories')
export class StoriesController {
  constructor(private readonly service: StoriesService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  @UseInterceptors(FileInterceptor('media', { limits: { fileSize: 100 * 1024 * 1024 } }))
  publish(@UploadedFile() file: StoryUpload) {
    return this.service.publish(file);
  }
}
