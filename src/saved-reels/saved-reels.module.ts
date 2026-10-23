import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SavedReel } from './saved-reel.entity';
import { SavedReelsController } from './saved-reels.controller';
import { SavedReelsService } from './saved-reels.service';

@Module({
  imports: [TypeOrmModule.forFeature([SavedReel])],
  controllers: [SavedReelsController],
  providers: [SavedReelsService],
  exports: [SavedReelsService],
})
export class SavedReelsModule {}
