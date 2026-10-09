import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config(); // must run before AppModule is imported so decorators see the env

async function bootstrap() {
  const { NestFactory } = await import('@nestjs/core');
  const { Logger } = await import('@nestjs/common');
  const { AppModule } = await import('./app.module');
  const { UPLOAD_DIR } = await import('./submissions/paths');
  const { InstagramConnectionService } = await import('./instagram-connection/instagram-connection.service');
  const { GRAPH } = await import('./instagram-connection/graph-client.service');
  const { FacebookPageService } = await import('./facebook-page/facebook-page.service');

  // rawBody: needed to check webhook signatures
  const app = await NestFactory.create<import('@nestjs/platform-express').NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  // Meta fetches processed photos from here, so this must stay public.
  app.useStaticAssets(UPLOAD_DIR, { prefix: '/media/' });

  // One log line per API request. Successful GETs are skipped: the dashboard polls every few seconds.
  const http = new Logger('HTTP');
  app.use((req: any, res: any, next: () => void) => {
    const started = Date.now();
    res.on('finish', () => {
      const status: number = res.statusCode;
      if (req.method === 'GET' && status < 400 && !req.originalUrl.startsWith('/instagram/webhook')) return;
      if (req.originalUrl.startsWith('/media/')) return;
      const line = `${req.method} ${String(req.originalUrl).split('?')[0]} ${status} ${Date.now() - started}ms`;
      if (status >= 500) http.error(line);
      else if (status >= 400) http.warn(line);
      else http.log(line);
    });
    next();
  });

  const origins = [
    process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
    ...(process.env.PUBLIC_SITE_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  ];
  app.enableCors({
    origin: origins.length > 0 ? origins : true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-instagram-account', 'x-requested-with'],
    credentials: true,
  });

  const port = Number(process.env.PORT ?? 4000);

  // Ensure the port is always free so EADDRINUSE never crashes startup
  try {
    const { execSync } = await import('child_process');
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[1].endsWith(`:${port}`) && parts[3] === 'LISTENING') {
          const pid = Number(parts[4]);
          if (pid && pid !== process.pid) {
            try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {}
          }
        }
      }
    }
  } catch {}

  await app.listen(port);

  // Startup summary: everything needed to see at a glance whether the setup is complete.
  const log = new Logger('Startup');
  const yes = (v?: string) => (v ? 'set' : 'MISSING');
  const publicUrl = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  log.log(`Backend ready on http://localhost:${port}`);
  log.log(`Instagram API: ${GRAPH}`);
  log.log(`Public URL: ${publicUrl || 'MISSING (Instagram cannot reach webhooks or fetch photos)'}`);
  if (publicUrl) log.log(`Webhook callback: ${publicUrl}/instagram/webhook`);
  log.log(`Webhook verify token: ${yes(process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN)} | App secret: ${yes(process.env.INSTAGRAM_APP_SECRET)}${process.env.INSTAGRAM_APP_SECRET ? '' : ' (events will be rejected)'}`);
  const status: any = await app.get(InstagramConnectionService).getStatus();
  if (status.connected) {
    const days = Math.round((new Date(status.expiresAt).getTime() - Date.now()) / 86_400_000);
    log.log(`Instagram: connected as @${status.username} (token expires in ~${days} days)`);
  } else {
    log.warn('Instagram: NOT connected. Open the dashboard > Account > Connect with Instagram.');
  }

  // Only the Comment-to-DM automation's send depends on this — everything else in the app is unaffected.
  const fbRedirect = process.env.FACEBOOK_REDIRECT_URI || (publicUrl ? `${publicUrl}/facebook-page/oauth/callback` : '');
  if (fbRedirect) log.log(`Facebook Page OAuth redirect URI (add under Facebook Login for Business in the Meta dashboard): ${fbRedirect}`);
  const fbStatus: any = await app.get(FacebookPageService).getStatus();
  if (fbStatus.connected) {
    log.log(`Facebook Page: connected ("${fbStatus.pageName}") — Comment-to-DM automation can send.`);
  } else {
    log.warn('Facebook Page: NOT connected. Comment-to-DM automation cannot send until one is connected in Account settings.');
  }
}
bootstrap();
