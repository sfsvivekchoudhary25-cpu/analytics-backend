import { Body, Controller, Get, Post, Req, Request, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: any) {
    const meta = { ip: req.ip || req.connection?.remoteAddress, userAgent: req.headers['user-agent'] };
    return this.authService.login(dto, meta);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('register')
  register(@Body() dto: RegisterDto, @Req() req: any) {
    const meta = { ip: req.ip || req.connection?.remoteAddress, userAgent: req.headers['user-agent'] };
    return this.authService.register(dto, meta);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @UseGuards(AuthGuard)
  @Get('me')
  me(@Request() req: any) {
    const userId = req.user?.sub || req.user?.id;
    if (userId) {
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
