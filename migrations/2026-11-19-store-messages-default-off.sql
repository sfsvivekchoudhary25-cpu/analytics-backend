-- New Instagram connections do NOT store message text by default. Existing rows keep whatever they have now
-- (nothing is erased by this statement). Safe to run more than once.
ALTER TABLE instagram_connection ALTER COLUMN store_messages SET DEFAULT false;
