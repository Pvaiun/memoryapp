-- Memory v1 schema.
-- Items hold current state; the events table is the Tier-0 append-only log
-- running alongside (§7.1) — a record, not the source of present truth.

CREATE TABLE captures (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  raw_text TEXT NOT NULL
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('DO','KNOW','HAPPEN')),
  title TEXT NOT NULL,
  raw_texts TEXT NOT NULL DEFAULT '[]', -- JSON [{ts,text}] appended phrasings (§9.3)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','deleted')),

  -- DO parameters (§3.1)
  deadline TEXT,
  deadline_hardness TEXT CHECK (deadline_hardness IN ('hard','soft')),
  cadence TEXT, -- JSON Cadence or NULL
  optionality TEXT NOT NULL DEFAULT 'must' CHECK (optionality IN ('must','nice')),
  effort TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('quick','medium','large')),
  ping_natured INTEGER NOT NULL DEFAULT 0,

  -- HAPPEN parameters
  event_at TEXT,
  event_end TEXT,
  alert_lead_minutes INTEGER,

  -- Priority (§9.3)
  priority_base REAL NOT NULL DEFAULT 0.5,
  priority_boost REAL NOT NULL DEFAULT 0,
  boost_updated_at TEXT,
  user_priority REAL,

  -- Presentation-only flavour override (§4); sparse
  flavour_override TEXT CHECK (flavour_override IN ('Task','Goal','Reminder','Event','Note')),

  -- Tier-1 deterministic aggregates (§7.2)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_touched_at TEXT NOT NULL,
  last_completed_at TEXT,
  completion_count INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  last_surfaced_at TEXT,

  parse_confidence REAL NOT NULL DEFAULT 1.0,
  capture_id TEXT REFERENCES captures(id),
  -- Embedding for recapture-match retrieval + semantic search (§10.3, §6).
  -- Float32 blob; brute-force cosine is fine at this volume (§7.5).
  embedding BLOB
);

CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_type ON items(type);
CREATE INDEX idx_items_deadline ON items(deadline) WHERE deadline IS NOT NULL;
CREATE INDEX idx_items_event_at ON items(event_at) WHERE event_at IS NOT NULL;

CREATE TABLE themes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX idx_themes_name ON themes(name) WHERE deleted_at IS NULL;

CREATE TABLE item_themes (
  item_id TEXT NOT NULL REFERENCES items(id),
  theme_id TEXT NOT NULL REFERENCES themes(id),
  assigned_by TEXT NOT NULL DEFAULT 'ai', -- 'ai' | 'user' (§5 authority & override)
  PRIMARY KEY (item_id, theme_id)
);

-- Librarian restructure notes (§5): one line per merge/delete/rename.
CREATE TABLE theme_notes (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  note TEXT NOT NULL
);

-- Tier-0: append-only, immutable; corrections append compensating events (§7.1).
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user','ai','system')),
  type TEXT NOT NULL,
  item_id TEXT,
  bubble_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}' -- JSON before→after
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_item ON events(item_id);

-- Bubbles: persistent objects with stable IDs, transient feel (§8.1).
CREATE TABLE bubbles (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL, -- YYYY-MM-DD (user-local) the map was built for
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'situation' CHECK (kind IN ('situation','rotation')),
  prominence REAL NOT NULL DEFAULT 0.5,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_bubbles_day ON bubbles(day);

CREATE TABLE bubble_items (
  bubble_id TEXT NOT NULL REFERENCES bubbles(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  PRIMARY KEY (bubble_id, item_id)
);

-- Tier-2 profile (§7.3): recomputed daily from the raw 30-day window; history kept.
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Idempotency for Layer-1 punctual pushes (§11.4).
CREATE TABLE sent_alerts (
  item_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL, -- ISO of the occurrence this alert covers
  sent_at TEXT NOT NULL,
  PRIMARY KEY (item_id, occurrence_key)
);

-- Full-text index over titles + raw phrasings for the keyword half of search (§6).
-- Standalone FTS table, kept in sync by the data layer on item writes.
CREATE VIRTUAL TABLE items_fts USING fts5(
  item_id UNINDEXED,
  title,
  raw_text
);
