import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InstagramConnectionModule } from '../instagram-connection/instagram-connection.module';
import { MessagingModule } from '../messaging/messaging.module';
import { Submission } from './submission.entity';
import { SubmissionsAdminController, SubmissionsPublicController } from './submissions.controller';
import { SubmissionsService } from './submissions.service';

@Module({
  imports: [TypeOrmModule.forFeature([Submission]), InstagramConnectionModule, MessagingModule],
  controllers: [SubmissionsAdminController, SubmissionsPublicController],
  providers: [SubmissionsService],
  exports: [SubmissionsService],
})
export class SubmissionsModule {}
