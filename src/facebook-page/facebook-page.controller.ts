import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { FacebookPageService } from './facebook-page.service';

@UseGuards(AuthGuard)
@Controller('facebook-page')
export class FacebookPageController {
  constructor(private readonly service: FacebookPageService) {}

  @Get()
  status() {
    return this.service.getStatus();
  }

  @Post('token')
  connectWithToken(@Body('accessToken') accessToken: string) {
    return this.service.connectWithToken(accessToken);
  }

  @Delete()
  disconnect() {
    return this.service.disconnect();
  }
}
