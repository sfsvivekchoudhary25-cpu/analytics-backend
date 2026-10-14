import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner';
import { rlsStorage } from './rls.context';

const proto = PostgresQueryRunner.prototype as any;

if (!proto._rlsPatched) {
  const origQuery = proto.query;
  const origRelease = proto.release;

  proto.query = async function (query: string, parameters?: any[], useConsolePrefix?: boolean) {
    if (!this.rlsConfigured) {
      const store = rlsStorage.getStore();
      if (store) {
        if (store.bypass) {
          await origQuery.call(this, "SET app.bypass_rls = 'on';");
        } else {
          if (store.tenant) {
            await origQuery.call(this, 'SELECT set_config($1, $2, false);', ['app.current_tenant', store.tenant]);
          }
          if (store.userId) {
            await origQuery.call(this, 'SELECT set_config($1, $2, false);', ['app.current_user_id', String(store.userId)]);
          }
          if (store.userEmail) {
            await origQuery.call(this, 'SELECT set_config($1, $2, false);', ['app.current_user_email', store.userEmail]);
          }
          if (store.role) {
            await origQuery.call(this, 'SELECT set_config($1, $2, false);', ['app.current_user_role', store.role]);
          }
        }
      } else {
        // Internal server tasks, cron schedules, or unauthenticated queries run in bypass mode
        await origQuery.call(this, "SET app.bypass_rls = 'on';");
      }
      this.rlsConfigured = true;
    }
    return origQuery.call(this, query, parameters, useConsolePrefix);
  };

  proto.release = async function () {
    if (this.rlsConfigured && !this.isReleased) {
      try {
        await origQuery.call(
          this,
          'RESET app.current_tenant; RESET app.current_user_id; RESET app.current_user_email; RESET app.current_user_role; RESET app.bypass_rls;',
        );
      } catch (_) {}
      this.rlsConfigured = false;
    }
    return origRelease.call(this);
  };

  proto._rlsPatched = true;
}
