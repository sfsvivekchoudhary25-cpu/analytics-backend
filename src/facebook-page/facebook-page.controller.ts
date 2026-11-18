import { Body, Controller, Delete, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount, NO_ACCOUNT } from '../common/current-account.decorator';
import { InstagramConnectionService } from '../instagram-connection/instagram-connection.service';
import { FacebookPageService } from './facebook-page.service';

// Everything here is scoped to the caller's own Instagram account. A user with no account sees "not connected".
@UseGuards(AuthGuard)
@Controller('facebook-page')
export class FacebookPageController {
  constructor(
    private readonly service: FacebookPageService,
    private readonly instagram: InstagramConnectionService,
  ) {}

  @Get()
  status(@CurrentAccount() account?: string) {
    return this.service.getStatus(account);
  }

  @Post('token')
  async connectWithToken(@Body('accessToken') accessToken: string, @CurrentAccount() account?: string, @Req() req?: any) {
    const res = await this.service.connectWithToken(accessToken, account);
    // A brand-new user (no linked Instagram yet) now owns the account Meta says this Page belongs to.
    if (account === NO_ACCOUNT && req?.user?.sub) {
      await this.instagram.linkUserInstagramHandle(req.user.sub, res.ownerUsername);
    }
    return { pageName: res.pageName };
  }

  @Delete()
  disconnect(@CurrentAccount() account?: string) {
    return this.service.disconnect(account);
  }
}
