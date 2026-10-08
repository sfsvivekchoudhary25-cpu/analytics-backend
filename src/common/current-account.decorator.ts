import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentAccount = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest();
    // 1. Explicit query parameter ?account= or ?ownerUsername=
    const queryAccount = req.query?.account || req.query?.ownerUsername;
    if (queryAccount) {
      return String(queryAccount).trim().replace(/^@/, '').toLowerCase();
    }
    // 2. Explicit header: x-instagram-account
    const headerAccount = req.headers['x-instagram-account'];
    if (headerAccount) {
      return String(headerAccount).trim().replace(/^@/, '').toLowerCase();
    }
    // 3. The authenticated user's Instagram handle (from verified JWT session)
    if (req.user?.instagramHandle) {
      return String(req.user.instagramHandle).trim().replace(/^@/, '').toLowerCase();
    }
    return undefined;
  },
);
