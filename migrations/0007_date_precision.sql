-- Timeless dates: whether an item's dates name a DAY or a MOMENT.
--
-- Date-only phrases ("tomorrow", "Thursday") have always been stored at local
-- noon (dates.ts localNoonIso) so they land on the right calendar day whatever
-- the timezone. That anchor is fine; what was missing is any record that noon
-- was an anchor rather than a time the user said. Three surfaces reconstructed
-- it by sniffing the stored string for "T12:00:00", which is only correct for
-- a user at UTC — everywhere else local noon serialises to some other hour —
-- and one surface (bubbleStatus) didn't reconstruct it at all and simply
-- compared the noon instant to the clock, flipping every date-only task to red
-- "overdue" at 12:01pm from the storage convention alone.
--
-- With the fact stored, a day-precision item is late only once its sleep day
-- has ended (5am), never mid-day, and never prints a time.
ALTER TABLE items ADD COLUMN date_precision TEXT NOT NULL DEFAULT 'time'
  CHECK (date_precision IN ('day','time'));

-- Backfill: an existing date that sits exactly at the user's local noon came
-- from a date-only phrase. Local noon in UTC minutes-since-midnight is
-- (720 - tz_offset_minutes), wrapped — the offset is the same one every
-- user-local computation reads (db.ts getTzOffset), so the reconstruction
-- matches what localNoonIso actually wrote. SQLite's % takes the sign of the
-- dividend, hence the +1440 before the second wrap.
--
-- Known and accepted: a genuine noon appointment is indistinguishable from an
-- all-day one and converts to all-day. That is the same collision the
-- T12:00:00 sentinel already made, now at least made once and recorded.
UPDATE items SET date_precision = 'day'
WHERE deadline IS NOT NULL
  AND CAST(strftime('%H', deadline) AS INTEGER) * 60 + CAST(strftime('%M', deadline) AS INTEGER)
      = ((720 - COALESCE((SELECT CAST(value AS INTEGER) FROM app_state WHERE key = 'tz_offset_minutes'), 0)) % 1440 + 1440) % 1440;

UPDATE items SET date_precision = 'day'
WHERE event_at IS NOT NULL
  AND CAST(strftime('%H', event_at) AS INTEGER) * 60 + CAST(strftime('%M', event_at) AS INTEGER)
      = ((720 - COALESCE((SELECT CAST(value AS INTEGER) FROM app_state WHERE key = 'tz_offset_minutes'), 0)) % 1440 + 1440) % 1440;
