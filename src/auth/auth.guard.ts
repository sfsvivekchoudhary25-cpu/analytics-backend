import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { User } from './user.entity';
import { resolveAccount } from '../common/current-account.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly dataSource: DataSource,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const [type, token] = (req.headers.authorization ?? '').split(' ');
    if (type !== 'Bearer' || !token) throw new UnauthorizedException();

    try {
      const payload = await this.jwt.verifyAsync(token);
      req.user = payload;
      const userId = req.user.sub || req.user.id;
      if (userId) {
        // The database is the source of truth for role and linked account, not the (30-day) token, so a role
        // change or account link takes effect immediately.
        const u = await this.dataSource.getRepository(User).findOne({ where: { id: userId }, select: { id: true, instagramHandle: true, role: true } });
        if (u) {
          req.user.role = u.role;
          req.user.instagramHandle = u.instagramHandle || undefined;
        }
      }
      resolveAccount(req);
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }
}
