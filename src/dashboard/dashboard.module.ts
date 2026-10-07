import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Comment } from '../comments/comment.entities';
import { CommentDmLog } from '../comment-dm/comment-dm.entities';
import { MessageAutoLog } from '../messaging/auto-message.entities';
import { Conversation, Message } from '../messaging/messaging.entities';
import { Submission } from '../submissions/submission.entity';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [TypeOrmModule.forFeature([Comment, CommentDmLog, MessageAutoLog, Conversation, Message, Submission])],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
