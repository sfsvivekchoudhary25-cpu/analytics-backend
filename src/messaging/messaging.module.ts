import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { InstagramConnectionModule } from '../instagram-connection/instagram-connection.module';
import { AutoMessageController } from './auto-message.controller';
import { MessageAutoLog, MessageAutoRule, MessageAutoSetting } from './auto-message.entities';
import { AutoMessageService } from './auto-message.service';
import { CommentDmLog } from '../comment-dm/comment-dm.entities';
import { Conversation, Message } from './messaging.entities';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, Message, MessageAutoSetting, MessageAutoRule, MessageAutoLog, CommentDmLog]),
    InstagramConnectionModule,
    AiModule,
  ],
  controllers: [MessagingController, AutoMessageController],
  providers: [MessagingService, AutoMessageService],
  exports: [MessagingService, AutoMessageService],
})
export class MessagingModule {}
