import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { InstagramConnectionModule } from './instagram-connection/instagram-connection.module';
import { InstagramWebhookModule } from './instagram-webhook/instagram-webhook.module';
import { SubmissionsModule } from './submissions/submissions.module';
import { MessagingModule } from './messaging/messaging.module';
import { Conversation, Message } from './messaging/messaging.entities';
import { MessageAutoLog, MessageAutoRule, MessageAutoSetting } from './messaging/auto-message.entities';
import { StoriesModule } from './stories/stories.module';
import { LegalModule } from './legal/legal.module';
import { CommentsModule } from './comments/comments.module';
import { AutoReplyRule, AutoReplySetting, Comment } from './comments/comment.entities';
import { CommentDmModule } from './comment-dm/comment-dm.module';
import { CommentDmLog, CommentDmRule } from './comment-dm/comment-dm.entities';
import { DashboardModule } from './dashboard/dashboard.module';
import { FacebookPageModule } from './facebook-page/facebook-page.module';
import { FacebookPageConnection } from './facebook-page/facebook-page.entity';
import { Story } from './stories/story.entity';
import { Submission } from './submissions/submission.entity';
import { InstagramConnection } from './instagram-connection/instagram-connection.entity';

import { User } from './auth/user.entity';
import { CloudinaryModule } from './cloudinary/cloudinary.module';
import { AiModule } from './ai/ai.module';
import { HashtagsModule } from './hashtags/hashtags.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [User, InstagramConnection, Submission, Conversation, Message, Story, Comment, AutoReplySetting, AutoReplyRule, MessageAutoSetting, MessageAutoRule, MessageAutoLog, CommentDmRule, CommentDmLog, FacebookPageConnection],
      synchronize: true, // MVP only: switch to migrations before production
    }),
    CloudinaryModule,
    AuthModule,
    AiModule,
    InstagramConnectionModule,
    InstagramWebhookModule,
    SubmissionsModule,
    MessagingModule,
    StoriesModule,
    LegalModule,
    CommentsModule,
    CommentDmModule,
    DashboardModule,
    FacebookPageModule,
    HashtagsModule,
  ],
})
export class AppModule {}
