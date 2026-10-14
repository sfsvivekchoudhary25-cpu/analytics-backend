import { AsyncLocalStorage } from 'node:async_hooks';

export interface RlsContext {
  tenant?: string;
  userId?: string;
  userEmail?: string;
  role?: string;
  bypass?: boolean;
}

export const rlsStorage = new AsyncLocalStorage<RlsContext>();

export function runWithRlsContext<T>(ctx: RlsContext, fn: () => T): T {
  return rlsStorage.run(ctx, fn);
}

export function getRlsContext(): RlsContext | undefined {
  return rlsStorage.getStore();
}
