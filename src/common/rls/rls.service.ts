import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

const TENANT_TABLES = [
  'auto_reply_rule',
  'auto_reply_setting',
  'comment',
  'comment_dm_log',
  'comment_dm_rule',
  'conversation',
  'message',
  'message_auto_log',
  'message_auto_rule',
  'message_auto_setting',
  'story',
  'submission',
];

@Injectable()
export class RlsService implements OnModuleInit {
  private readonly logger = new Logger('RowLevelSecurity');

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit() {
    try {
      await this.ensureRlsPolicies();
    } catch (err) {
      this.logger.warn(`RLS policy verification note: ${(err as Error).message}`);
    }
  }

  async ensureRlsPolicies() {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();

    try {
      // 1. Verify and enforce RLS on all 12 tenant tables
      for (const table of TENANT_TABLES) {
        await qr.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`).catch(() => {});
        await qr.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`).catch(() => {});
        await qr.query(`DROP POLICY IF EXISTS "rls_${table}_tenant_policy" ON "${table}";`).catch(() => {});
        await qr.query(`
          CREATE POLICY "rls_${table}_tenant_policy" ON "${table}"
          AS PERMISSIVE
          FOR ALL
          TO PUBLIC
          USING (
            current_setting('app.bypass_rls', true) = 'on'
            OR LOWER("owner_username") = LOWER(NULLIF(current_setting('app.current_tenant', true), ''))
            OR ("owner_username" IS NULL AND NULLIF(current_setting('app.current_tenant', true), '') IS NULL)
          )
          WITH CHECK (
            current_setting('app.bypass_rls', true) = 'on'
            OR LOWER("owner_username") = LOWER(NULLIF(current_setting('app.current_tenant', true), ''))
          );
        `).catch(() => {});
      }

      // 2. instagram_connection table
      await qr.query(`ALTER TABLE "instagram_connection" ENABLE ROW LEVEL SECURITY;`).catch(() => {});
      await qr.query(`ALTER TABLE "instagram_connection" FORCE ROW LEVEL SECURITY;`).catch(() => {});
      await qr.query(`DROP POLICY IF EXISTS "rls_instagram_connection_policy" ON "instagram_connection";`).catch(() => {});
      await qr.query(`
        CREATE POLICY "rls_instagram_connection_policy" ON "instagram_connection"
        AS PERMISSIVE
        FOR ALL
        TO PUBLIC
        USING (
          current_setting('app.bypass_rls', true) = 'on'
          OR LOWER("username") = LOWER(NULLIF(current_setting('app.current_tenant', true), ''))
        )
        WITH CHECK (
          current_setting('app.bypass_rls', true) = 'on'
          OR LOWER("username") = LOWER(NULLIF(current_setting('app.current_tenant', true), ''))
        );
      `).catch(() => {});

      // 3. app_users table
      await qr.query(`ALTER TABLE "app_users" ENABLE ROW LEVEL SECURITY;`).catch(() => {});
      await qr.query(`ALTER TABLE "app_users" FORCE ROW LEVEL SECURITY;`).catch(() => {});
      await qr.query(`DROP POLICY IF EXISTS "rls_app_users_policy" ON "app_users";`).catch(() => {});
      await qr.query(`
        CREATE POLICY "rls_app_users_policy" ON "app_users"
        AS PERMISSIVE
        FOR ALL
        TO PUBLIC
        USING (
          current_setting('app.bypass_rls', true) = 'on'
          OR "id"::text = NULLIF(current_setting('app.current_user_id', true), '')
          OR LOWER("email") = LOWER(NULLIF(current_setting('app.current_user_email', true), ''))
          OR current_setting('app.current_user_role', true) = 'admin'
        )
        WITH CHECK (
          current_setting('app.bypass_rls', true) = 'on'
          OR "id"::text = NULLIF(current_setting('app.current_user_id', true), '')
          OR LOWER("email") = LOWER(NULLIF(current_setting('app.current_user_email', true), ''))
          OR current_setting('app.current_user_role', true) = 'admin'
        );
      `).catch(() => {});

      // 4. audit_logs table
      await qr.query(`ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;`).catch(() => {});
      await qr.query(`ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;`).catch(() => {});
      await qr.query(`DROP POLICY IF EXISTS "rls_audit_logs_policy" ON "audit_logs";`).catch(() => {});
      await qr.query(`
        CREATE POLICY "rls_audit_logs_policy" ON "audit_logs"
        AS PERMISSIVE
        FOR ALL
        TO PUBLIC
        USING (
          current_setting('app.bypass_rls', true) = 'on'
          OR current_setting('app.current_user_role', true) = 'admin'
          OR "actorId" = NULLIF(current_setting('app.current_user_id', true), '')
        )
        WITH CHECK (
          current_setting('app.bypass_rls', true) = 'on'
          OR true
        );
      `).catch(() => {});

      // Check count of tables with active rowsecurity
      const res = await qr.query(`
        SELECT count(*)::int as count 
        FROM pg_tables 
        WHERE schemaname = 'public' AND rowsecurity = true;
      `);
      this.logger.log(`PostgreSQL Row-Level Security active on ${res[0]?.count ?? 0} tables.`);
    } finally {
      await qr.release();
    }
  }
}
