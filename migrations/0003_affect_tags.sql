-- Affect tags (closed vocabulary, shared/types.ts AFFECT_TAGS): the emotional
-- colour a capture's phrasing carried, appended as {tag, ts} history per
-- capture/recapture so it stays countable ("forgotten" twice is a fact no
-- single capture contains). User-editable; the Brain reads it as data.
ALTER TABLE items ADD COLUMN affect_tags TEXT;
