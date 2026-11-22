-- Schema hardening, stage 1: remove duplicate rows, add the uniqueness the app already assumes, add the
-- composite indexes the app's queries actually use. Safe to run more than once. Runs in one transaction.
--
-- Every index here is ALSO declared on the entities with the same name, so TypeORM `synchronize` sees them as
-- already present. Run this BEFORE deploying the entity change: synchronize would otherwise fail to create a
-- unique index over duplicate rows.

BEGIN;

-- 1. Duplicate messages: the same Instagram message id stored twice for one account. Keep the earliest row.
DELETE FROM message m
USING (
  SELECT id, row_number() OVER (PARTITION BY owner_username, mid ORDER BY created_at, id) AS rn
  FROM message WHERE mid IS NOT NULL
) d
WHERE m.id = d.id AND d.rn > 1;

-- 2. Duplicate settings rows: there must be ONE per account. Keep the same row the app already prefers
--    (AI on, then enabled, then lowest id) so no live setting changes.
DELETE FROM message_auto_setting s
USING (
  SELECT id, row_number() OVER (PARTITION BY lower(owner_username) ORDER BY ai_enabled DESC, enabled DESC, id) AS rn
  FROM message_auto_setting
) d
WHERE s.id = d.id AND d.rn > 1;

DELETE FROM auto_reply_setting s
USING (
  SELECT id, row_number() OVER (PARTITION BY lower(owner_username) ORDER BY ai_enabled DESC, enabled DESC, id) AS rn
  FROM auto_reply_setting
) d
WHERE s.id = d.id AND d.rn > 1;

-- Duplicate saved reels (same account + shortcode): keep the most recently saved.
DELETE FROM saved_reels r
USING (
  SELECT id, row_number() OVER (PARTITION BY owner_username, shortcode ORDER BY saved_at DESC, updated_at DESC, id) AS rn
  FROM saved_reels
) d
WHERE r.id = d.id AND d.rn > 1;

-- 3. Uniqueness the code already relies on (it checks "does it exist?" before inserting, which races).
CREATE UNIQUE INDEX IF NOT EXISTS uq_message_owner_mid            ON message (owner_username, mid) WHERE mid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_message_auto_setting_owner   ON message_auto_setting (owner_username);
CREATE UNIQUE INDEX IF NOT EXISTS uq_auto_reply_setting_owner     ON auto_reply_setting (owner_username);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_reels_owner_shortcode  ON saved_reels (owner_username, shortcode);
CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_connection_ig_user ON instagram_connection (ig_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_connection_name    ON instagram_connection (username);
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_users_instagram_handle   ON app_users (instagram_handle) WHERE instagram_handle IS NOT NULL;

-- facebook_page_connection.owner_username exists only after the per-account Page code has been deployed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='facebook_page_connection' AND column_name='owner_username') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_facebook_page_owner ON facebook_page_connection (owner_username);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_facebook_page_page_id ON facebook_page_connection (page_id);
  END IF;
END $$;

-- 4. Composite indexes for the queries the dashboard runs ("this account's newest X").
CREATE INDEX IF NOT EXISTS ix_comment_owner_time          ON comment (owner_username, commented_at);
CREATE INDEX IF NOT EXISTS ix_message_owner_thread_time   ON message (owner_username, igsid, created_at);
CREATE INDEX IF NOT EXISTS ix_conversation_owner_last     ON conversation (owner_username, last_message_at);
CREATE INDEX IF NOT EXISTS ix_comment_dm_log_owner_time   ON comment_dm_log (owner_username, created_at);
CREATE INDEX IF NOT EXISTS ix_message_auto_log_owner_time ON message_auto_log (owner_username, created_at);
CREATE INDEX IF NOT EXISTS ix_submission_owner_time       ON submission (owner_username, created_at);

COMMIT;
