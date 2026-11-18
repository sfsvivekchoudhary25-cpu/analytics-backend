-- "Don't store my messages" switch (per connected Instagram account). Default: keep storing (encrypted).
-- Safe to run more than once. The backend's schema sync adds this column by itself on Render; run it manually on a
-- database where DB_SYNCHRONIZE=0 (for example the local one).
ALTER TABLE instagram_connection ADD COLUMN IF NOT EXISTS store_messages boolean NOT NULL DEFAULT true;
