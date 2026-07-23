-- Calendar presence for recurring items (§6): a bi-weekly therapy session
-- belongs on the calendar; nightly dishwasher duty is ambient routine that
-- would bury it. One-offs always paint their dates — this flag only gates
-- cadence occurrences. Parser-set at capture; the item sheet lets the user
-- flip it either way.
ALTER TABLE items ADD COLUMN show_on_calendar INTEGER NOT NULL DEFAULT 1;

-- Existing high-frequency rhythms (daily / every-N-days) start off-calendar;
-- weekly-and-slower recurrences stay visible until the user says otherwise.
UPDATE items SET show_on_calendar = 0
WHERE cadence IS NOT NULL AND json_extract(cadence, '$.freq') = 'daily';
