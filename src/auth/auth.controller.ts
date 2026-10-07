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

  @UseGuards(AuthGuard)
  @Get('me')
  me(@Request() req: any) {
    return { ok: true, user: req.user };
  }
}
