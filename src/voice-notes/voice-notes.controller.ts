import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
import { AudioUploadFile, CreateVoiceNoteDto, VoiceNotesService } from './voice-notes.service';

@UseGuards(AuthGuard)
@Controller('voice-notes')
export class VoiceNotesController {
  constructor(private readonly service: VoiceNotesService) {}

  // Instant AI structuring preview (does not persist note yet)
  @Post('cleanup-preview')
  cleanupPreview(
    @Body() body: { rawTranscript: string; languageCode?: string },
  ) {
    return this.service.previewCleanup(body.rawTranscript, body.languageCode);
  }

  // Create voice note with optional audio file and raw transcript
  @Post()
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 25 * 1024 * 1024 } }))
  create(
    @UploadedFile() file: AudioUploadFile | undefined,
    @Body() body: any,
    @CurrentAccount() account?: string,
  ) {
    // If multipart/form-data sends JSON strings, parse them safely
    let actionItems = body.actionItems;
    if (typeof actionItems === 'string') {
      try {
        actionItems = JSON.parse(actionItems);
      } catch {}
    }

    let tags = body.tags;
    if (typeof tags === 'string') {
      try {
        tags = JSON.parse(tags);
      } catch {
        tags = tags.split(',').map((t: string) => t.trim()).filter(Boolean);
      }
    }

    const dto: CreateVoiceNoteDto = {
      rawTranscript: body.rawTranscript || '',
      cleanedText: body.cleanedText,
      title: body.title,
      category: body.category,
      tags,
      actionItems,
      durationSeconds: body.durationSeconds ? Number(body.durationSeconds) : 0,
      languageCode: body.languageCode || 'en-US',
      isPinned: body.isPinned === 'true' || body.isPinned === true,
    };

    return this.service.create(dto, file, account);
  }

  // List notes with search and filters
  @Get()
  findAll(
    @Query('search') search?: string,
    @Query('category') category?: string,
    @Query('tag') tag?: string,
    @Query('pinnedOnly') pinnedOnly?: string,
    @CurrentAccount() account?: string,
  ) {
    return this.service.findAll(
      {
        search,
        category,
        tag,
        pinnedOnly: pinnedOnly === 'true',
      },
      account,
    );
  }

  // Get note by ID
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentAccount() account?: string) {
    return this.service.findOne(id, account);
  }

  // Update note title, text, or category
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: Partial<CreateVoiceNoteDto>,
    @CurrentAccount() account?: string,
  ) {
    return this.service.update(id, body, account);
  }

  // Toggle checklist task item completion
  @Patch(':id/action-items/:itemId')
  toggleActionItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body('completed') completed: boolean,
    @CurrentAccount() account?: string,
  ) {
    return this.service.toggleActionItem(id, itemId, completed, account);
  }

  // Delete voice note
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentAccount() account?: string) {
    return this.service.remove(id, account);
  }
}
