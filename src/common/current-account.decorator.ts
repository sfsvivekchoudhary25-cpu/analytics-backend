import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentAccount = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest();
    const isAdmin = req.user?.role === 'admin';

    // 1. Only administrators / dev-admin can inspect or manage other accounts via query or header
    if (isAdmin) {
      const explicitAccount =
        req.query?.account ||
        req.query?.ownerUsername ||
        req.headers['x-instagram-account'];
      if (explicitAccount) {
        return String(explicitAccount).trim().replace(/^@/, '').toLowerCase();
      }
    }

    // 2. For regular users: strictly enforce the verified Instagram handle from session
    if (req.user?.instagramHandle) {
      return String(req.user.instagramHandle).trim().replace(/^@/, '').toLowerCase();
    }

    // 3. Fallback only if no authenticated session exists on public routes
    const fallback = req.query?.account || req.headers['x-instagram-account'];
    if (!req.user && fallback) {
      return String(fallback).trim().replace(/^@/, '').toLowerCase();
    }

    return undefined;
  },
);
