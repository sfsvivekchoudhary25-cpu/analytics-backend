import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
import { getRlsContext } from '../common/rls/rls.context';
import { DashboardService } from './dashboard.service';

// The overview is a handful of counts over many rows, and the same person opens it again and again.
// A short copy per user + account + range spares the database; ?fresh=1 (the Refresh button) skips it.
const TTL_MS = 45_000;
const MAX_ENTRIES = 200;
type Entry = { at: number; value?: unknown; pending?: Promise<unknown> };

@UseGuards(AuthGuard)
@Controller('dashboard')
export class DashboardController {
  private readonly cache = new Map<string, Entry>();

  constructor(private readonly service: DashboardService) {}

  @Get('overview')
  async overview(@Query('days') days?: string, @Query('fresh') fresh?: string, @CurrentAccount() account?: string) {
    const n = [7, 14, 30].includes(Number(days)) ? Number(days) : 7;
    const ctx = getRlsContext();
    // Without a known user there is nothing safe to key the copy on, so go straight to the database.
    if (!ctx?.userId) return this.service.overview(n, account);

    const key = `${ctx.userId}|${ctx.tenant ?? ''}|${account ?? ''}|${n}`;
    const hit = this.cache.get(key);
    if (hit && !fresh) {
      if (hit.pending) return hit.pending;
      if (Date.now() - hit.at < TTL_MS) return hit.value;
    }

    // Two calls at once (two tabs, a quick refresh) share one trip to the database.
    const pending = this.service.overview(n, account).then(
      (value) => {
        this.cache.set(key, { at: Date.now(), value });
        this.trim();
        return value;
      },
      (e) => {
        this.cache.delete(key);
        throw e;
      },
    );
    this.cache.set(key, { at: Date.now(), pending });
    return pending;
  }

  private trim() {
    if (this.cache.size <= MAX_ENTRIES) return;
    const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, this.cache.size - MAX_ENTRIES);
    for (const [k] of oldest) this.cache.delete(k);
  }
}
