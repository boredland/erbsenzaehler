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

CREATE INDEX IF NOT EXISTS idx_push_garden ON push_subscriptions(garden_id);
