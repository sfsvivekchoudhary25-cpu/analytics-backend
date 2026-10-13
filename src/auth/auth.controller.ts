import { Body, Controller, Get, Post, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  login(@Body() body: { email?: string; password: string }) {
    return this.authService.login(body);
  }

  @Post('register')
  register(
    @Body()
    body: {
      email: string;
      name: string;
      password: string;
      instagramHandle?: string;
    },
  ) {
    return this.authService.register(body);
  }

  @Post('forgot-password')
  forgotPassword(@Body('email') email: string) {
    return this.authService.forgotPassword(email);
  }

  @Post('reset-password')
  resetPassword(@Body() body: { email: string; code?: string; newPassword: string }) {
    return this.authService.resetPassword(body);
  }

  @UseGuards(AuthGuard)
  @Get('me')
  me(@Request() req: any) {
    const userId = req.user?.sub || req.user?.id;
    if (userId && userId !== 'dev-admin') {
      return this.authService.getProfile(userId);
    }
    return { ok: true, user: req.user };
  }

  @UseGuards(AuthGuard)
  @Post('onboarding')
  completeOnboarding(
    @Request() req: any,
    @Body()
    body: {
      creatorNiche?: string;
      monthlyVolume?: string;
      facebookPageName?: string;
      instagramHandle?: string;
      tiktokHandle?: string;
      youtubeChannel?: string;
    },
  ) {
    const userId = req.user?.sub || req.user?.id;
    return this.authService.completeOnboarding(userId, body);
  }
}
