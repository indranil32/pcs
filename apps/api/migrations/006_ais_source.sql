-- AIS positions can come from an external VTS/AIS feed; the built-in simulator never overwrites fresh external data.
ALTER TABLE ais_positions ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'SIM';
