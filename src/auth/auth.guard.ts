import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { User } from './user.entity';

import { InstagramConnection } from '../instagram-connection/instagram-connection.entity';

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

    // Allow dev bypass token for local development & testing
    if (token === 'dev-bypass-token' || token.startsWith('dev-')) {
      let handle = 'sfs.vivekchoudhary25';
      try {
        const connRepo = this.dataSource.getRepository(InstagramConnection);
        const latest = await connRepo.find({ order: { updatedAt: 'DESC' }, take: 1 });
        if (latest.length > 0 && latest[0]?.username) {
          handle = latest[0].username;
        }
      } catch {}
      req.user = { id: 'dev-admin', role: 'admin', name: 'Developer', email: 'dev@inro.local', instagramHandle: handle };
      return true;
    }

    try {
      const payload = await this.jwt.verifyAsync(token);
      req.user = payload;
      const userId = req.user.sub || req.user.id;
      if (!req.user.instagramHandle && userId) {
        const u = await this.dataSource.getRepository(User).findOne({ where: { id: userId }, select: { id: true, instagramHandle: true } });
        if (u?.instagramHandle) {
          req.user.instagramHandle = u.instagramHandle;
        }
      }
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }
}
