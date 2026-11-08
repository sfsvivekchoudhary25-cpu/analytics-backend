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
    // Routes with no user session by design: OAuth redirects from Meta (the callback
    // resolves the tenant from the verified Instagram/Facebook identity itself) and the
    // website submission endpoint (authenticated by SUBMISSIONS_API_KEY in the handler).
    const isOAuthCallback = /^\/(instagram|facebook-page)\/oauth\/callback\/?$/.test(path);
    const isPublicSubmission = /^\/public\/submissions\/?$/.test(path);

    const user = req.user;
    let tenant: string | undefined = undefined;
    let role = user?.role || 'user';
    let userId = user?.id || user?.sub;
    let userEmail = user?.email;
    const bypass = isWebhook || isAuth || isOAuthCallback || isPublicSubmission;

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
