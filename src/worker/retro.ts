// Map retrospective — the worker half (§7.1, §8.3).
//
// Reconstructs how a past day's map fared and hands the deterministic scoring
// to shared/retro.ts. Everything here is loading + the sleep-cycle-day window
// math; no judgment lives in this file. Read-only — it touches nothing the
// Brain or the reliable floor depend on.

import type { ItemView, RetroPayload } from '../shared/types';
import { EARLY_MORNING_CUTOFF_MINUTES, sleepDayOf } from '../shared/dates';
import { COMPLETION_EVENTS, scoreRetro, TOUCH_EVENTS, type RetroBubbleInput } from '../shared/retro';
import type { Env } from './env';
import { getTzOffset, listItems, toItemView } from './db';

const DAY_MS = 86_400_000;

// The [start, end) UTC instants — and the index — of the sleep-cycle day `day`
// (YYYY-MM-DD) for a user at `tz` minutes offset. Derived from the same
// sleepDayOf arithmetic the rest of the app uses, so the window can never
// disagree with the map about "which day".
function dayWindow(day: string, tz: number): { startMs: number; endMs: number; idx: number } {
  const [y, m, d] = day.split('-').map((n) => parseInt(n, 10));
  // Noon-local of the date lands unambiguously inside its own sleep-day.
  const noonLocalUtc = Date.UTC(y, m - 1, d, 12, 0, 0) - tz * 60_000;
  const idx = sleepDayOf(noonLocalUtc, tz);
  const startMs = idx * DAY_MS - (tz - EARLY_MORNING_CUTOFF_MINUTES) * 60_000;
  return { startMs, endMs: startMs + DAY_MS, idx };
}

export async function mapRetro(env: Env, day: string): Promise<RetroPayload> {
  const db = env.DB;
  const tz = await getTzOffset(db);
  const now = new Date();
  const { startMs, endMs, idx } = dayWindow(day, tz);

  // The bubbles this day's map showed, in the order it showed them.
  const bubbleRows = await db
    .prepare('SELECT id, name, kind, prominence, reason, created_at FROM bubbles WHERE day = ? ORDER BY prominence DESC')
    .bind(day)
    .all<{ id: string; name: string; kind: string; prominence: number; reason: string; created_at: string }>();
  const memberRows = await db
    .prepare('SELECT bi.bubble_id, bi.item_id FROM bubble_items bi JOIN bubbles b ON b.id = bi.bubble_id WHERE b.day = ?')
    .bind(day)
    .all<{ bubble_id: string; item_id: string }>();

  const members = new Map<string, string[]>();
  for (const r of memberRows.results) {
    const list = members.get(r.bubble_id) ?? [];
    list.push(r.item_id);
    members.set(r.bubble_id, list);
  }
  const bubbleInputs: RetroBubbleInput[] = bubbleRows.results.map((b) => ({
    id: b.id,
    name: b.name,
    kind: b.kind === 'rotation' ? 'rotation' : 'situation',
    prominence: b.prominence,
    reason: b.reason,
    itemIds: members.get(b.id) ?? [],
  }));

  // The user's state-change events that landed on this same sleep-cycle day.
  const eventRows = await db
    .prepare("SELECT type, item_id FROM events WHERE ts >= ? AND ts < ? AND actor = 'user' AND item_id IS NOT NULL")
    .bind(new Date(startMs).toISOString(), new Date(endMs).toISOString())
    .all<{ type: string; item_id: string }>();
  const completed = new Set<string>();
  const touched = new Set<string>();
  for (const e of eventRows.results) {
    if (COMPLETION_EVENTS.has(e.type)) completed.add(e.item_id);
    else if (TOUCH_EVENTS.has(e.type)) touched.add(e.item_id);
  }

  // Items are loaded once, including closed/deleted, so any referenced id can
  // be named. "Created that day" comes from the item's own createdAt (the
  // Captured-Today population), folded into the score so a same-day capture
  // completed off-map reads as a fair miss, not a burial.
  const allItems = await listItems(db, {
    statuses: ['active', 'completed', 'dismissed', 'passed', 'missed', 'deleted'],
  });
  const byId = new Map(allItems.map((it) => [it.id, it]));
  const createdThatDay = new Set<string>();
  for (const it of allItems) {
    if (sleepDayOf(new Date(it.createdAt).getTime(), tz) === idx) createdThatDay.add(it.id);
  }

  const score = scoreRetro(bubbleInputs, completed, touched, createdThatDay, createdThatDay.size);

  const referenced = new Set<string>([...completed, ...touched, ...score.misses.map((m) => m.itemId)]);
  for (const b of bubbleInputs) for (const id of b.itemIds) referenced.add(id);
  const items: Record<string, ItemView> = {};
  for (const id of referenced) {
    const it = byId.get(id);
    if (it) items[id] = toItemView(it, now, tz);
  }

  const prevDay =
    (await db.prepare('SELECT day FROM bubbles WHERE day < ? ORDER BY day DESC LIMIT 1').bind(day).first<{ day: string }>())
      ?.day ?? null;
  const nextDay =
    (await db.prepare('SELECT day FROM bubbles WHERE day > ? ORDER BY day ASC LIMIT 1').bind(day).first<{ day: string }>())
      ?.day ?? null;
  const builtAt = bubbleRows.results.reduce<string | null>(
    (min, b) => (min === null || b.created_at < min ? b.created_at : min),
    null,
  );

  return {
    day,
    hasMap: bubbleRows.results.length > 0,
    builtAt,
    prevDay,
    nextDay,
    bubbles: score.bubbles,
    misses: score.misses,
    totals: score.totals,
    items,
  };
}
