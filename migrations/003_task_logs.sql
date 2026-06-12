-- Generalize the watering log into recurring task logs (watering, mowing, …).
-- The UI keeps fixed cards; this just removes the watering-specific table.

CREATE TABLE IF NOT EXISTS task_logs (
  id TEXT PRIMARY KEY,
  garden_id TEXT NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
  task TEXT NOT NULL,
  user_name TEXT NOT NULL,
  note TEXT,
  done_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO task_logs (id, garden_id, task, user_name, note, done_at)
  SELECT id, garden_id, 'watering', user_name, note, watered_at FROM waterings;

DROP TABLE waterings;

CREATE INDEX IF NOT EXISTS idx_task_logs_garden ON task_logs(garden_id, task, done_at);
