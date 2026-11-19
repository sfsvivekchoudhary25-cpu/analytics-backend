-- Webhooks identify an Instagram account by its professional-account id (`user_id`), which differs from the
-- app-scoped id stored in ig_user_id. This column stores it so incoming DMs are matched to the right account.
-- TypeORM `synchronize` adds it on its own; run this by hand where DB_SYNCHRONIZE=0 (for example the local one).
-- Existing rows are filled in automatically the first time a webhook arrives for them.
ALTER TABLE instagram_connection ADD COLUMN IF NOT EXISTS ig_account_id varchar;
