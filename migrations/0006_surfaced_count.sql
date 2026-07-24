-- How many times an item has been put on the map, alongside last_surfaced_at
-- (§9.2). Recency alone can't tell "asked once, still not done" from "asked
-- twelve mornings running, still not done" — the Brain already reads seen=,
-- completion_count and streak; this supplies the missing denominator.
--
-- Brain-side only: this feeds brainItemLine, never the Tier-2 profile, which
-- reads the event log and no item state at all. Surfacing is the app's own
-- output, and the profile is where an output would harden into durable prose
-- about the user (§7.3) — so it stays out of that path by construction.
ALTER TABLE items ADD COLUMN surfaced_count INTEGER NOT NULL DEFAULT 0;

-- No per-day surfacing history exists to replay (bubble_items is keyed by
-- bubble, and old maps are pruned), so backfill the honest minimum: anything
-- ever surfaced has been surfaced at least once.
UPDATE items SET surfaced_count = 1 WHERE last_surfaced_at IS NOT NULL;
