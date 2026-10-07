import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InstagramConnectionModule } from '../instagram-connection/instagram-connection.module';
import { Story } from './story.entity';
import { StoriesController } from './stories.controller';
import { StoriesService } from './stories.service';

@Module({
  imports: [TypeOrmModule.forFeature([Story]), InstagramConnectionModule],
  controllers: [StoriesController],
  providers: [StoriesService],
})
export class StoriesModule {}
