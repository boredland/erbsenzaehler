CREATE TABLE IF NOT EXISTS gardens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS vegetables (
  id TEXT PRIMARY KEY,
  garden_id TEXT NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🥬',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS harvests (
  id TEXT PRIMARY KEY,
  garden_id TEXT NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
  vegetable_id TEXT NOT NULL REFERENCES vegetables(id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 1,
  user_name TEXT NOT NULL,
  note TEXT,
  photo_key TEXT,
  harvested_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS task_logs (
  id TEXT PRIMARY KEY,
  garden_id TEXT NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
  task TEXT NOT NULL,
  user_name TEXT NOT NULL,
  note TEXT,
  done_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  garden_id TEXT NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_name TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (garden_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_vegetables_garden ON vegetables(garden_id);
CREATE INDEX IF NOT EXISTS idx_harvests_vegetable ON harvests(vegetable_id);
CREATE INDEX IF NOT EXISTS idx_harvests_garden ON harvests(garden_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_garden ON task_logs(garden_id, task, done_at);
CREATE INDEX IF NOT EXISTS idx_push_garden ON push_subscriptions(garden_id);
