-- Item lifecycle exits: 'dismissed' (user: no longer relevant), 'passed'
-- (system: a one-shot event's moment elapsed — asserts nothing about the
-- user), and 'missed' (user: didn't make it to an event). 'completed' stays
-- the one positive terminal for every flavour; 'deleted' stays pure hygiene.
-- SQLite can't alter a CHECK constraint, so the items table is rebuilt.

PRAGMA defer_foreign_keys = on;

CREATE TABLE items_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('DO','KNOW','HAPPEN')),
  title TEXT NOT NULL,
  raw_texts TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','dismissed','passed','missed','deleted')),

  deadline TEXT,
  deadline_hardness TEXT CHECK (deadline_hardness IN ('hard','soft')),
  cadence TEXT,
  optionality TEXT NOT NULL DEFAULT 'must' CHECK (optionality IN ('must','nice')),
  effort TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('quick','medium','large')),
  ping_natured INTEGER NOT NULL DEFAULT 0,

  event_at TEXT,
  event_end TEXT,
  alert_lead_minutes INTEGER,

  priority_base REAL NOT NULL DEFAULT 0.5,
  priority_boost REAL NOT NULL DEFAULT 0,
  boost_updated_at TEXT,
  user_priority REAL,

  flavour_override TEXT CHECK (flavour_override IN ('Task','Goal','Reminder','Event','Note')),

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_touched_at TEXT NOT NULL,
  last_completed_at TEXT,
  completion_count INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  last_surfaced_at TEXT,

  parse_confidence REAL NOT NULL DEFAULT 1.0,
  capture_id TEXT REFERENCES captures(id),
  embedding BLOB,
  affect_tags TEXT
);

INSERT INTO items_new (
  id, type, title, raw_texts, status,
  deadline, deadline_hardness, cadence, optionality, effort, ping_natured,
  event_at, event_end, alert_lead_minutes,
  priority_base, priority_boost, boost_updated_at, user_priority,
  flavour_override, created_at, updated_at, last_touched_at,
  last_completed_at, completion_count, streak, last_surfaced_at,
  parse_confidence, capture_id, embedding, affect_tags
)
SELECT
  id, type, title, raw_texts, status,
  deadline, deadline_hardness, cadence, optionality, effort, ping_natured,
  event_at, event_end, alert_lead_minutes,
  priority_base, priority_boost, boost_updated_at, user_priority,
  flavour_override, created_at, updated_at, last_touched_at,
  last_completed_at, completion_count, streak, last_surfaced_at,
  parse_confidence, capture_id, embedding, affect_tags
FROM items;

DROP TABLE items;
ALTER TABLE items_new RENAME TO items;

CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_type ON items(type);
CREATE INDEX idx_items_deadline ON items(deadline) WHERE deadline IS NOT NULL;
CREATE INDEX idx_items_event_at ON items(event_at) WHERE event_at IS NOT NULL;

PRAGMA defer_foreign_keys = off;
