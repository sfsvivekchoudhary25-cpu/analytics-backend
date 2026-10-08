import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { timingSafeEqual } from 'crypto';
import { AuthGuard } from '../auth/auth.guard';
import { SubmissionsService, UploadedImage } from './submissions.service';

import { CurrentAccount } from '../common/current-account.decorator';

const upload = FileInterceptor('image', { limits: { fileSize: 8 * 1024 * 1024 } });

// Admin panel: review queue + Publish button.
@UseGuards(AuthGuard)
@Controller('submissions')
export class SubmissionsAdminController {
  constructor(private readonly service: SubmissionsService) {}

  @Get()
  list(@CurrentAccount() account?: string) {
    return this.service.list(account);
  }

  @Get('search-users')
  searchUsers(@Query('q') query?: string, @CurrentAccount() account?: string) {
    return this.service.searchUsers(query, account);
  }

  // Manual entry from the dashboard (same as the website intake, for testing).
  @Post()
  @UseInterceptors(upload)
  create(
    @UploadedFile() file: UploadedImage,
    @Body('username') username: string,
    @Body('caption') caption?: string,
    @CurrentAccount() account?: string,
  ) {
    return this.service.create(file, username, caption, account);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body('caption') caption?: string) {
    return this.service.updateCaption(id, caption);
  }

  @Post(':id/publish')
  publish(@Param('id') id: string, @Body('caption') caption?: string) {
    return this.service.publish(id, caption);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}

// Your website calls this. Authenticated with SUBMISSIONS_API_KEY, not the admin login.
@Controller('public/submissions')
export class SubmissionsPublicController {
  constructor(private readonly service: SubmissionsService) {}

  @Post()
  @UseInterceptors(upload)
  async create(
    @Headers('x-api-key') apiKey: string | undefined,
    @UploadedFile() file: UploadedImage,
    @Body('username') username: string,
    @Body('caption') caption?: string,
  ) {
    const expected = Buffer.from(process.env.SUBMISSIONS_API_KEY ?? '');
    const given = Buffer.from(apiKey ?? '');
    if (!expected.length || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new UnauthorizedException();
    }
    const view = await this.service.create(file, username, caption);
    const list = await this.service.list();
    const chatUrl = list.find((s) => s.id === view.id)?.chatUrl ?? null;
    return { id: view.id, chatUrl };
  }
}
