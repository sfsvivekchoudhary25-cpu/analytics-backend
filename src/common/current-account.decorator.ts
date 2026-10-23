import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Resolves and memoizes the active Instagram handle onto req.account.
 * Can be called upfront in AuthGuard/middleware or lazily in @CurrentAccount.
 */
export function resolveAccount(req: any): string | undefined {
  if (!req) return undefined;
  if (req.account !== undefined) {
    return req.account;
  }

  const isAdmin = req.user?.role === 'admin';

  // 1. Only administrators / dev-admin can inspect or manage other accounts via query or header
  if (isAdmin) {
    const explicitAccount =
      req.query?.account ||
      req.query?.ownerUsername ||
      req.headers?.['x-instagram-account'];
    if (explicitAccount) {
      const sanitized = String(explicitAccount).trim().replace(/^@/, '').toLowerCase();
      req.account = sanitized;
      return sanitized;
    }
  }

  // 2. For regular users: strictly enforce the verified Instagram handle from session
  if (req.user?.instagramHandle) {
    const sanitized = String(req.user.instagramHandle).trim().replace(/^@/, '').toLowerCase();
    req.account = sanitized;
    return sanitized;
  }

  // 3. Fallback only if no authenticated session exists on public routes
  const fallback = req.query?.account || req.headers?.['x-instagram-account'];
  if (!req.user && fallback) {
    const sanitized = String(fallback).trim().replace(/^@/, '').toLowerCase();
    req.account = sanitized;
    return sanitized;
  }

  req.account = undefined;
  return undefined;
}

export const CurrentAccount = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest();
    return req?.account ?? resolveAccount(req);
  },
);

