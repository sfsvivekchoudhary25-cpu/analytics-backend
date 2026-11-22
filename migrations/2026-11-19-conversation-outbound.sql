-- Lets accounts that choose "Don't store my messages" keep NO per-message rows: the few facts automation needs
-- (when we last sent something, and who sent it) live on the conversation row instead. Safe to run more than once.
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS last_outbound_at timestamptz;
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS last_outbound_source varchar;
