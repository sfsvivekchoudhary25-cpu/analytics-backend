import { Module } from '@nestjs/common';
import { CommentsModule } from '../comments/comments.module';
import { MessagingModule } from '../messaging/messaging.module';
import { SubmissionsModule } from '../submissions/submissions.module';
import { CommentDmModule } from '../comment-dm/comment-dm.module';
import { InstagramConnectionModule } from '../instagram-connection/instagram-connection.module';
import { InstagramWebhookController } from './instagram-webhook.controller';

@Module({
  imports: [SubmissionsModule, MessagingModule, CommentsModule, CommentDmModule, InstagramConnectionModule],
  controllers: [InstagramWebhookController],
})
export class InstagramWebhookModule {}
