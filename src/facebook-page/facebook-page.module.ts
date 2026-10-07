import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InstagramConnectionModule } from '../instagram-connection/instagram-connection.module';
import { FacebookOauthController } from './facebook-oauth.controller';
import { FacebookPageConnection } from './facebook-page.entity';
import { FacebookPageController } from './facebook-page.controller';
import { FacebookPageService } from './facebook-page.service';

import { User } from '../auth/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([FacebookPageConnection, User]), InstagramConnectionModule],
  controllers: [FacebookPageController, FacebookOauthController],
  providers: [FacebookPageService],
  exports: [FacebookPageService],
})
export class FacebookPageModule {}
