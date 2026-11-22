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
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from './common/audit/audit.module';
import { AuditLog } from './common/audit/audit-log.entity';
import { RlsModule } from './common/rls/rls.module';
import { VoiceNotesModule } from './voice-notes/voice-notes.module';
import { VoiceNote } from './voice-notes/voice-note.entity';
import { HealthModule } from './health/health.module';
import { SavedReelsModule } from './saved-reels/saved-reels.module';
import { SavedReel } from './saved-reels/saved-reel.entity';
import { AccountModule } from './account/account.module';

@Module({
  imports: [
    // DISABLE_SCHEDULER=1 turns every @Cron job off (the @Cron decorators then do nothing). Used by a local
    // backend that shares the production database, so only ONE backend runs the automations.
    ...(process.env.DISABLE_SCHEDULER === '1' ? [] : [ScheduleModule.forRoot()]),
    RlsModule,
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 60 seconds
        limit: 120, // 120 requests per minute baseline
      },
    ]),
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      // Verified TLS for remote hosts (Supabase/Render); off for local dev.
      // If the server cert isn't trusted, set DATABASE_CA_CERT to the CA PEM
      // (Supabase dashboard -> Database -> SSL Configuration).
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')
        ? false
        : process.env.DATABASE_CA_CERT
          ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n') }
          : true,
      entities: [
        User,
        InstagramConnection,
        Submission,
        Conversation,
        Message,
        Story,
        Comment,
        AutoReplySetting,
        AutoReplyRule,
        MessageAutoSetting,
        MessageAutoRule,
        MessageAutoLog,
        CommentDmRule,
        CommentDmLog,
        FacebookPageConnection,
        AuditLog,
        VoiceNote,
        SavedReel,
      ],
      // MVP only: switch to migrations before production.
      // DB_SYNCHRONIZE=0 stops this process from altering the schema. A local backend sharing the production
      // database must set it, or its (possibly different) entities could add/drop production columns.
      synchronize: process.env.DB_SYNCHRONIZE !== '0',
      // Keep the pooler's limited connection slots for the live backend: a local process sets DB_POOL_MAX=2.
      extra: { max: Number(process.env.DB_POOL_MAX) || 10 },
    }),
    AuditModule,
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
    VoiceNotesModule,
    HealthModule,
    SavedReelsModule,
    AccountModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
