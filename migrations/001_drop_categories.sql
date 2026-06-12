-- Remove category grouping; vegetables belong directly to a garden

DROP INDEX IF EXISTS idx_categories_garden;
DROP INDEX IF EXISTS idx_vegetables_category;
DROP TABLE IF EXISTS categories;

PRAGMA foreign_keys=off;

CREATE TABLE vegetables_new (
  id TEXT PRIMARY KEY,
  garden_id TEXT NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🥬',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO vegetables_new (id, garden_id, name, emoji, created_at)
  SELECT id, garden_id, name, emoji, created_at FROM vegetables;

DROP TABLE vegetables;
ALTER TABLE vegetables_new RENAME TO vegetables;
CREATE INDEX IF NOT EXISTS idx_vegetables_garden ON vegetables(garden_id);

PRAGMA foreign_keys=on;
