-- Demo dataset version: a changed dataset is wiped and reseeded on the next start.
ALTER TABLE seed_state ADD COLUMN IF NOT EXISTS version text;
