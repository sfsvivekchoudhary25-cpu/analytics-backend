import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentAccount = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest();
    // 1. The authenticated user's Instagram handle (from verified JWT session)
    if (req.user?.instagramHandle) {
      return String(req.user.instagramHandle).trim().replace(/^@/, '').toLowerCase();
    }
    // 2. Dev-admin bypass mode for local automated testing
    if (req.user?.id === 'dev-admin' || req.user?.role === 'admin') {
      const headerAccount = req.headers['x-instagram-account'];
      if (headerAccount) {
        return String(headerAccount).trim().replace(/^@/, '').toLowerCase();
      }
    }
    return undefined;
  },
);
