import { Controller, Delete, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
import { FacebookPageService } from './facebook-page.service';

// Everything here is scoped to the caller's own Instagram account. A user with no account sees "not connected".
// A Page is connected only through Facebook login (facebook-oauth.controller.ts); pasting a token is not supported.
@UseGuards(AuthGuard)
@Controller('facebook-page')
export class FacebookPageController {
  constructor(private readonly service: FacebookPageService) {}

  @Get()
  status(@CurrentAccount() account?: string) {
    return this.service.getStatus(account);
  }

  @Delete()
  disconnect(@CurrentAccount() account?: string) {
    return this.service.disconnect(account);
  }
}
