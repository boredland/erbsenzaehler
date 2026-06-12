CREATE TABLE IF NOT EXISTS gardens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  garden_id TEXT NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🌱',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS vegetables (
  id TEXT PRIMARY KEY,
  garden_id TEXT NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_categories_garden ON categories(garden_id);
CREATE INDEX IF NOT EXISTS idx_vegetables_garden ON vegetables(garden_id);
CREATE INDEX IF NOT EXISTS idx_vegetables_category ON vegetables(category_id);
CREATE INDEX IF NOT EXISTS idx_harvests_vegetable ON harvests(vegetable_id);
CREATE INDEX IF NOT EXISTS idx_harvests_garden ON harvests(garden_id);

CREATE TABLE IF NOT EXISTS waterings (
  id TEXT PRIMARY KEY,
  garden_id TEXT NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  note TEXT,
  watered_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_waterings_garden ON waterings(garden_id, watered_at);
