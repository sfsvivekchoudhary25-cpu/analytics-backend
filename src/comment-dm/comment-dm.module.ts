import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InstagramConnectionModule } from '../instagram-connection/instagram-connection.module';
import { AutoReplyRule, AutoReplySetting, Comment } from '../comments/comment.entities';
import { Conversation, Message } from '../messaging/messaging.entities';
import { MessagingModule } from '../messaging/messaging.module';
import { FacebookPageModule } from '../facebook-page/facebook-page.module';
import { CommentDmController } from './comment-dm.controller';
import { CommentDmLog, CommentDmRule } from './comment-dm.entities';
import { CommentDmService } from './comment-dm.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([CommentDmRule, CommentDmLog, Comment, Message, Conversation, AutoReplyRule, AutoReplySetting]),
    InstagramConnectionModule,
    MessagingModule,
    FacebookPageModule,
  ],
  controllers: [CommentDmController],
  providers: [CommentDmService],
  exports: [CommentDmService],
})
export class CommentDmModule {}
