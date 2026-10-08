import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentAccount = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest();
    const headerAccount = req.headers['x-instagram-account'];
    if (headerAccount) {
      return String(headerAccount).trim().replace(/^@/, '').toLowerCase();
    }
    if (req.user?.instagramHandle) {
      return String(req.user.instagramHandle).trim().replace(/^@/, '').toLowerCase();
    }
    return undefined;
  },
);
