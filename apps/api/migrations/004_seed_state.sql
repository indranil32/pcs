-- Records that the demo seed finished, so an interrupted seed is detected and redone on the next start.
CREATE TABLE IF NOT EXISTS seed_state (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  completed_at timestamptz NOT NULL DEFAULT now()
);
