import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { InstagramConnectionModule } from '../instagram-connection/instagram-connection.module';
import { VoiceNotesController } from './voice-notes.controller';
import { VoiceNotesService } from './voice-notes.service';
import { VoiceNote } from './voice-note.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([VoiceNote]),
    AiModule,
    InstagramConnectionModule,
  ],
  controllers: [VoiceNotesController],
  providers: [VoiceNotesService],
  exports: [VoiceNotesService],
})
export class VoiceNotesModule {}
