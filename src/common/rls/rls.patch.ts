import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner';
import { rlsStorage } from './rls.context';

const proto = PostgresQueryRunner.prototype as any;

// Every query must run with the caller's tenant/role settings applied to its database connection (Row-Level
// Security policies read them). Setting them costs a full network round trip, so the settings are remembered ON THE
// CONNECTION and only re-sent when they differ from what that connection already carries. A connection is never
// used for a query before its settings equal the caller's, so one request can never see another's tenant.
// (Previously every single query paid three round trips: set, query, reset. Now a reused connection pays one.)
const KEYS = ['app.bypass_rls', 'app.current_tenant', 'app.current_user_id', 'app.current_user_email', 'app.current_user_role'] as const;

function desiredSettings(): string[] {
  const store = rlsStorage.getStore();
  // Internal server tasks, cron schedules, or unauthenticated queries run in bypass mode.
  if (!store || store.bypass) return ['on', '', '', '', ''];
  return ['', store.tenant ?? '', store.userId ? String(store.userId) : '', store.userEmail ?? '', store.role ?? ''];
}

if (!proto._rlsPatched) {
  const origQuery = proto.query;

  proto.query = async function (query: string, parameters?: any[], useConsolePrefix?: boolean) {
    const conn = await this.connect(); // the underlying pg client (idempotent)
    const values = desiredSettings();
    const key = values.join('\u0001');
    if (conn.__rlsKey !== key) {
      // One statement sets all five (empty = off; every policy treats an empty value like an unset one).
      await origQuery.call(
        this,
        `SELECT ${KEYS.map((_, i) => `set_config('${KEYS[i]}', $${i + 1}, false)`).join(', ')};`,
        values,
      );
      conn.__rlsKey = key;
    }
    try {
      return await origQuery.call(this, query, parameters, useConsolePrefix);
    } finally {
      // A rolled-back transaction would also undo settings made inside it: forget what we cached, to be safe.
      if (/^\s*ROLLBACK\b/i.test(query)) conn.__rlsKey = undefined;
    }
  };

  proto._rlsPatched = true;
}
