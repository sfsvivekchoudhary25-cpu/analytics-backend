import { Module } from '@nestjs/common';
import { InstagramConnectionModule } from '../instagram-connection/instagram-connection.module';
import { FacebookPageModule } from '../facebook-page/facebook-page.module';
import { HashtagsController } from './hashtags.controller';
import { HashtagsService } from './hashtags.service';

@Module({
  imports: [InstagramConnectionModule, FacebookPageModule],
  controllers: [HashtagsController],
  providers: [HashtagsService],
  exports: [HashtagsService],
})
export class HashtagsModule {}
