-- surfaced_count becomes DAYS on the map, not map builds (rebuildMap now adds
-- one only on an item's first surfacing of the sleep day). Counted per build,
-- a forced or test rebuild added another, and a daily chore reached
-- shown=109x at 83 days old — read by the Brain as 109 mornings of asking.
--
-- Every past day's map is kept (a rebuild replaces only its own day's bubbles),
-- so the day count can be replayed exactly rather than guessed: the distinct
-- map days each item appears on. Anything ever surfaced keeps at least one.
UPDATE items
SET surfaced_count = MAX(1, (
  SELECT COUNT(DISTINCT b.day)
  FROM bubble_items bi
  JOIN bubbles b ON b.id = bi.bubble_id
  WHERE bi.item_id = items.id
))
WHERE last_surfaced_at IS NOT NULL;
