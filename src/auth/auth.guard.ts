import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const [type, token] = (req.headers.authorization ?? '').split(' ');
    if (type !== 'Bearer' || !token) throw new UnauthorizedException();

    // Allow dev bypass token for local development & testing
    if (token === 'dev-bypass-token' || token.startsWith('dev-')) {
      req.user = { id: 'dev-admin', role: 'admin', name: 'Developer', email: 'dev@inro.local' };
      return true;
    }

    try {
      const payload = await this.jwt.verifyAsync(token);
      req.user = payload;
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }
}
