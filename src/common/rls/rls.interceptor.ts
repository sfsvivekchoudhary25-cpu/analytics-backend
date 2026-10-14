import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { rlsStorage } from './rls.context';

@Injectable()
export class RlsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const httpCtx = context.switchToHttp();
    const req = httpCtx.getRequest();

    // If not HTTP (e.g. RPC or WebSockets), pass through
    if (!req) return next.handle();

    const path: string = req.path || req.originalUrl || '';
    const isWebhook = path.startsWith('/instagram-webhook') || path.startsWith('/instagram/webhook');
    const isAuth = path.startsWith('/auth');

    const user = req.user;
    let tenant: string | undefined = undefined;
    let role = user?.role || 'user';
    let userId = user?.id || user?.sub;
    let userEmail = user?.email;
    const bypass = isWebhook || isAuth;

    if (!bypass && user) {
      if (role === 'admin') {
        const explicit = (req.query?.account || req.headers['x-instagram-account'])?.toString()?.trim();
        if (explicit) {
          tenant = explicit.replace(/^@/, '').toLowerCase();
        }
      }

      if (!tenant && user.instagramHandle) {
        tenant = String(user.instagramHandle).trim().replace(/^@/, '').toLowerCase();
      }

      if (!tenant && user.email) {
        tenant = String(user.email).trim().toLowerCase();
      }
    }

    return new Observable((observer) => {
      rlsStorage.run({ tenant, userId, userEmail, role, bypass }, () => {
        const subscription = next.handle().subscribe(observer);
        return () => subscription.unsubscribe();
      });
    });
  }
}
