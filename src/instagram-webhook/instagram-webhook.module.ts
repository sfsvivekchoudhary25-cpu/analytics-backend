import { Module } from '@nestjs/common';
import { CommentsModule } from '../comments/comments.module';
import { MessagingModule } from '../messaging/messaging.module';
import { SubmissionsModule } from '../submissions/submissions.module';
import { CommentDmModule } from '../comment-dm/comment-dm.module';
import { InstagramWebhookController } from './instagram-webhook.controller';

@Module({
  imports: [SubmissionsModule, MessagingModule, CommentsModule, CommentDmModule],
  controllers: [InstagramWebhookController],
})
export class InstagramWebhookModule {}
