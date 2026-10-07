import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InstagramConnection } from './instagram-connection.entity';
import { InstagramConnectionService } from './instagram-connection.service';
import { InstagramConnectionController } from './instagram-connection.controller';
import { InstagramOauthController } from './instagram-oauth.controller';
import { InstagramInsightsController } from './instagram-insights.controller';
import { GraphClient } from './graph-client.service';

@Module({
  imports: [TypeOrmModule.forFeature([InstagramConnection])],
  controllers: [InstagramConnectionController, InstagramOauthController, InstagramInsightsController],
  providers: [InstagramConnectionService, GraphClient],
  exports: [InstagramConnectionService, GraphClient], // posting, stories and messaging modules use these
})
export class InstagramConnectionModule {}
