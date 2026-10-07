import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { InstagramConnectionModule } from '../instagram-connection/instagram-connection.module';
import { AutoReplyRule, AutoReplySetting, Comment } from './comment.entities';
import { CommentDmRule } from '../comment-dm/comment-dm.entities';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  imports: [TypeOrmModule.forFeature([Comment, AutoReplySetting, AutoReplyRule, CommentDmRule]), InstagramConnectionModule, AiModule],
  controllers: [CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
