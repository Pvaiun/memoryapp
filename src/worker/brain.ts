import type { Bubble, Cadence, CaptureResponse, ItemView, MapPayload, ParseResult } from '../shared/types';
import { describeAtTime, describeCadence, neglectedByDays } from '../shared/cadence';
import { resolveSentence, stripSentence } from '../shared/cards';
import type { Env } from './env';
import { anthropicJson, llmAvailable } from './ai';
import { heuristicParse } from '../shared/heuristicParse';
import { refineWithSourceTime, resolveDatePhrase, sleepDayDiff, sleepDayKey, sleepDayOf, snoozeActive } from '../shared/dates';
import {
  cadenceStanding,
  compareTier,
  isBrainTier,
  isTodayRelevant,
  maxTier,
  placeItems,
  tierProminences,
} from './placement';
import type { BrainTier } from './placement';
import { llmParse } from './capture';
import { embed } from './embeddings';
import { rollRecurringDeadlines, rollRecurringEvents, sweepPassedEvents, wakeSnoozedItems } from './items';
import {
  getItem,
  getState,
  getTzOffset,
  insertItem,
  listItems,
  listThemes,
  logEvent,
  newId,
  nowIso,
  setItemThemes,
  setState,
  toItemView,
} from './db';

// The Brain (§9): one algorithm — a full rebuild of the bubble map from the
// current items, triggered by the first app-open of each new calendar day.
// Yesterday's bubbles are supplied separately and secondarily ("reuse if apt"),
// never merged into the working set (§8.2).

export async function getMap(env: Env, day: string): Promise<MapPayload> {
  const db = env.DB;
  const now = new Date();
  const mapDay = await getState(db, 'map_day');
  const builtAt = await getState(db, 'map_built_at');

  if (mapDay !== day) {
    return { day, builtAt: null, stale: true, bubbles: [], capturedToday: [], items: {} };
  }

  const bubbleRows = await db
    .prepare('SELECT * FROM bubbles WHERE day = ? ORDER BY prominence DESC')
    .bind(day)
    .all<{
      id: string;
      day: string;
      name: string;
      kind: string;
      prominence: number;
      reason: string;
      sentence: string;
      first_step: string | null;
    }>();
  const memberRows = await db
    .prepare('SELECT bi.bubble_id, bi.item_id FROM bubble_items bi JOIN bubbles b ON b.id = bi.bubble_id WHERE b.day = ?')
    .bind(day)
    .all<{ bubble_id: string; item_id: string }>();

  const members = new Map<string, string[]>();
  for (const m of memberRows.results) {
    const list = members.get(m.bubble_id) ?? [];
    list.push(m.item_id);
    members.set(m.bubble_id, list);
  }

  // Closed statuses ride along so a same-day exit (completed, dismissed,
  // missed, or an event gone spent) stays greyed in place on today's map
  // instead of vanishing; tomorrow's rebuild drops it for good.
  const items = await listItems(db, { statuses: ['active', 'completed', 'dismissed', 'passed', 'missed'] });
  const tz = await getTzOffset(db);
  const views: Record<string, ItemView> = {};
  // A snooze takes effect immediately, not at the next rebuild: dropping the
  // item from the shipped views makes it vanish from today's bubbles (member
  // lists filter on views below) and keeps it out of Captured Today. Unlike a
  // same-day exit, which stays greyed in place, hiding is the entire point of
  // a snooze.
  for (const item of items) {
    if (snoozeActive(item.snoozedUntil, now.getTime(), tz)) continue;
    views[item.id] = toItemView(item, now, tz);
  }

  const bubbles: Bubble[] = bubbleRows.results
    .map((b) => ({
      id: b.id,
      day: b.day,
      name: b.name,
      kind: b.kind as Bubble['kind'],
      prominence: b.prominence,
      reason: b.reason,
      sentence: b.sentence ?? '',
      firstStep: b.first_step ?? null,
      // Completing an item updates the map in place (grey/remove, §9.1) —
      // completed members stay listed; the client renders them greyed.
      itemIds: (members.get(b.id) ?? []).filter((id) => views[id]),
    }))
    // A bubble can lose every member mid-day (its lone item snoozed or
    // deleted) — an empty shell has nothing to say, so it leaves the map.
    .filter((b) => b.itemIds.length > 0);

  // Captured Today (§9.1): deterministic bucket — items created on `day`
  // (user-local) that the morning rebuild hasn't folded in yet.
  const inBubbles = new Set(bubbles.flatMap((b) => b.itemIds));
  const capturedToday = Object.values(views)
    .filter((v) => v.status === 'active' && v.createdAt >= (builtAt ?? `${day}T00:00:00Z`) && !inBubbles.has(v.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((v) => v.id);

  // Only ship items the map actually references.
  const referenced = new Set([...inBubbles, ...capturedToday]);
  const shipped: Record<string, ItemView> = {};
  for (const id of referenced) shipped[id] = views[id];

  return { day, builtAt, stale: false, bubbles, capturedToday, items: shipped };
}

// force: user-initiated re-run for a day that already has a map — the escape
// hatch for bulk-import days when Captured Today piles up. The automatic
// trigger stays strictly first-open-of-day (§9.1).
// noHistory: workshop mode — the Brain composes without yesterday's groupings;
// everything else (librarian, profile, name vocabulary) runs as normal.
// noProfile: workshop mode — the profile is still recomputed (daily
// bookkeeping) but withheld from the Brain's calls, so the same morning can
// be built with and without it and the two snapshots diffed: the empirical
// answer to "what is the profile actually adding?".
// promptVariant: which Brain prompt builds the map. Omitted (the morning
// rebuild, the plain re-run) → the user's stored preference, default minimal;
// explicit (the workshop buttons) → exactly what was asked. The snapshot
// records which one ran.
export async function rebuildMap(
  env: Env,
  day: string,
  force = false,
  noHistory = false,
  promptVariant?: BrainPromptVariant,
  noProfile = false,
): Promise<MapPayload> {
  const db = env.DB;
  const now = new Date();

  // If another request already rebuilt for this day, don't do it twice.
  const existingDay = await getState(db, 'map_day');
  if (existingDay === day && !force) return getMap(env, day);

  // The daily run also recomputes the user profile (§9.1/§7.3) and lets the
  // librarian tidy the taxonomy (§5). Both advisory; failures must not block the map.
  let profileText: string | null = null;
  try {
    profileText = await recomputeProfile(env, day);
  } catch (err) {
    console.error('profile recompute failed', err);
    profileText = await getState(db, 'profile_text');
  }
  try {
    await librarianPass(env);
  } catch (err) {
    console.error('librarian pass failed', err);
  }
  // The withhold happens here, once, so every reader below — legacy input,
  // staged pipeline, snapshot — agrees on what the Brain was (not) shown.
  const profileForBuild = noProfile ? null : profileText;

  const tz = await getTzOffset(db);
  // One-shot events whose moment fell in a previous sleep-day close as
  // 'passed' here — the daily crystallization of the map's derived greying.
  // Cadenced DOs whose deadline-day ended roll to the next grid slot the same
  // way: the rhythm carries the due date; neglect carries the pressure. A
  // recurring HAPPEN's anchor rolls too, so happens= tokens and date badges
  // point at the occurrence that's actually next, never a spent one.
  try {
    await sweepPassedEvents(db, now, tz);
    await rollRecurringDeadlines(db, now, tz);
    await rollRecurringEvents(db, now, tz);
    await wakeSnoozedItems(db, now, tz);
  } catch (err) {
    console.error('lifecycle sweep failed', err);
  }
  // The single candidate gate: everything downstream — placement, the Brain's
  // curation, and the "Also today" safety net — only ever sees this set, so
  // filtering snoozed items here is what keeps them off the map entirely
  // (including a snoozed DATED item, which the safety net would otherwise
  // force back on).
  const items = (await listItems(db, { statuses: ['active'] }))
    .filter((i) => !snoozeActive(i.snoozedUntil, now.getTime(), tz))
    .map((i) => toItemView(i, now, tz));

  // Yesterday's bubbles — supplied separately, framed as "reuse only if apt" (§8.2).
  let previous: { name: string; itemTitles: string[] }[] = [];
  if (!noHistory) {
    const prevDay = await db
      .prepare('SELECT day FROM bubbles WHERE day < ? ORDER BY day DESC LIMIT 1')
      .bind(day)
      .first<{ day: string }>();
    if (prevDay) {
      const rows = await db
        .prepare(
          `SELECT b.name, i.title FROM bubbles b
           JOIN bubble_items bi ON bi.bubble_id = b.id
           JOIN items i ON i.id = bi.item_id
           WHERE b.day = ?`,
        )
        .bind(prevDay.day)
        .all<{ name: string; title: string }>();
      const byName = new Map<string, string[]>();
      for (const r of rows.results) {
        const list = byName.get(r.name) ?? [];
        list.push(r.title);
        byName.set(r.name, list);
      }
      previous = [...byName.entries()].map(([name, itemTitles]) => ({ name, itemTitles }));
    }
  }

  // Recent situation-name vocabulary (§9.2 naming): linguistic stability.
  const nameRows = await db
    .prepare('SELECT DISTINCT name FROM bubbles ORDER BY created_at DESC LIMIT 40')
    .all<{ name: string }>();
  const nameVocabulary = nameRows.results.map((r) => r.name);

  const stored = await getState(db, 'brain_prompt_variant');
  const variant: BrainPromptVariant =
    promptVariant ?? (stored === 'full' ? 'full' : stored === 'staged' ? 'staged' : 'minimal');
  const prompt = selectBrainSystem(
    variant,
    await getState(db, 'brain_prompt_addendum'),
    (await getState(db, 'brain_prompt_override_enabled')) === '1',
    await getState(db, 'brain_prompt_override'),
  );
  // The workshop override outranks the pipeline choice — while it's checked,
  // the saved text IS the Brain, exactly as the settings sheet promises. The
  // staged pipeline runs only when no override is in force.
  const useStaged = prompt.prompt === 'staged';

  const input = brainInput(day, items, previous, nameVocabulary, profileForBuild, now, tz);
  // The staged pipeline records its own richer payload (skeleton → plan →
  // prose); the legacy single call records its one input. Whichever ran is
  // what the snapshot must show.
  let snapshotPayload: Record<string, unknown> = input.payload;
  let proposed: ProposedBubble[];
  let mode: 'llm' | 'fallback' = 'fallback';
  if (llmAvailable(env) && items.length) {
    try {
      if (useStaged) {
        const staged = await stagedBuildBubbles(env, items, day, nameVocabulary, profileForBuild, now, tz, prompt.addendum);
        proposed = staged.proposed;
        snapshotPayload = staged.payload;
      } else {
        proposed = await llmBuildBubbles(env, input, prompt.system);
      }
      mode = 'llm';
    } catch (err) {
      console.error('Brain call failed; using deterministic fallback map', err);
      // A failed staged run must not leave the legacy-shaped input in the
      // snapshot — that would claim the single-call Brain saw a payload it
      // never received. Record what actually happened.
      if (useStaged) {
        snapshotPayload = {
          pipeline: 'staged',
          error: err instanceof Error ? err.message : String(err),
          note: 'staged pipeline failed; deterministic fallback map built',
        };
      }
      proposed = fallbackBubbles(items, now, tz);
    }
  } else {
    proposed = fallbackBubbles(items, now, tz);
  }

  // Code-side prominence floors mirroring the prompt's tier floors — the
  // guarantee lives here, not in the model's compliance: a bubble holding a
  // same-day item never renders below the quiet band; a same-day must-do or
  // hard deadline holds it at least mid.
  const itemById = new Map(items.map((i) => [i.id, i]));
  for (const b of proposed) {
    let floor = 0;
    for (const id of b.itemIds) {
      const it = itemById.get(id);
      if (!it || !isTodayRelevant(it, now, tz)) continue;
      // A hard deadline makes an item insistent only when that deadline is
      // itself today's business (due or overdue). An optional rhythm whose
      // unrelated hard date sits next week must keep the quiet floor
      // placement gave it — re-promoting it here would re-import the
      // deadline-dominance the staged pipeline exists to end.
      const dueNow = !!it.deadline && sleepDayDiff(new Date(it.deadline).getTime(), now.getTime(), tz) <= 0;
      const insistent = it.optionality !== 'nice' || (dueNow && (it.deadlineHardness ?? 'hard') === 'hard');
      floor = Math.max(floor, insistent ? 0.5 : 0.28);
    }
    if (floor > b.prominence) b.prominence = floor;
  }

  // Replace the day's map wholesale (idempotent under re-runs).
  const old = await db.prepare('SELECT id FROM bubbles WHERE day = ?').bind(day).all<{ id: string }>();
  for (const b of old.results) {
    await db.prepare('DELETE FROM bubble_items WHERE bubble_id = ?').bind(b.id).run();
  }
  await db.prepare('DELETE FROM bubbles WHERE day = ?').bind(day).run();

  const validIds = new Set(items.map((i) => i.id));
  const surfacedIds = new Set<string>();
  const builtBubbles: { name: string; prominence: number; items: number }[] = [];
  for (const b of proposed) {
    const memberIds = b.itemIds.filter((id) => validIds.has(id));
    if (!memberIds.length) continue;
    const bubbleId = newId();
    // Chips referencing items that fell out of the member list degrade to bold.
    const sentence = resolveSentence(b.sentence, new Map(), new Set(memberIds)).slice(0, 600);
    await db
      .prepare(
        'INSERT INTO bubbles (id, day, name, kind, prominence, reason, sentence, first_step, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        bubbleId,
        day,
        b.name.slice(0, 80),
        b.kind,
        clamp(b.prominence, 0.05, 1),
        (b.reason || stripSentence(sentence)).slice(0, 300),
        sentence,
        b.firstStep ? b.firstStep.slice(0, 160) : null,
        nowIso(),
      )
      .run();
    for (const itemId of memberIds) {
      await db.prepare('INSERT OR IGNORE INTO bubble_items (bubble_id, item_id) VALUES (?,?)').bind(bubbleId, itemId).run();
      surfacedIds.add(itemId);
    }
    builtBubbles.push({ name: b.name, prominence: b.prominence, items: memberIds.length });
  }

  // Deterministic safety net: anything dated today that the Brain left out
  // gets its own bubble. The model curates; it cannot drop today.
  const missed = items.filter((i) => !surfacedIds.has(i.id) && isTodayRelevant(i, now, tz));
  if (missed.length) {
    const bubbleId = newId();
    const sentence = composeSentence(missed, now, tz).slice(0, 600);
    await db
      .prepare(
        'INSERT INTO bubbles (id, day, name, kind, prominence, reason, sentence, first_step, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .bind(bubbleId, day, 'Also today', 'situation', 0.8, stripSentence(sentence).slice(0, 300), sentence, null, nowIso())
      .run();
    for (const item of missed) {
      await db.prepare('INSERT OR IGNORE INTO bubble_items (bubble_id, item_id) VALUES (?,?)').bind(bubbleId, item.id).run();
      surfacedIds.add(item.id);
    }
    builtBubbles.push({ name: 'Also today', prominence: 0.8, items: missed.length });
  }

  // Rehearsal-rotation bookkeeping (§9.2): record what got shown.
  const ts = nowIso();
  for (const id of surfacedIds) {
    await db
      .prepare('UPDATE items SET last_surfaced_at = ?, surfaced_count = surfaced_count + 1 WHERE id = ?')
      .bind(ts, id)
      .run();
  }

  await setState(db, 'map_day', day);
  await setState(db, 'map_built_at', ts);
  // What the Brain was actually called with — the debug snapshot's source of
  // truth (a fresh reconstruction would drift and hide noHistory/fallback runs).
  await setState(
    db,
    'brain_last_input',
    JSON.stringify({
      day,
      builtAt: ts,
      mode,
      noHistory,
      noProfile,
      // What actually ran: 'override' + its text, or the variant + whatever
      // addendum was appended. Never both — selectBrainSystem mirrors the gate.
      prompt: prompt.prompt,
      addendum: prompt.addendum,
      override: prompt.override,
      payload: snapshotPayload,
    }),
  );
  // One consolidated event per rebuild (the bubbles table holds the details).
  await logEvent(db, 'system', 'map_rebuilt', { payload: { day, bubbles: builtBubbles } });

  return getMap(env, day);
}

// Scheduled morning rebuild (§9.1 precompute). The cron tick doubles as the
// map's alarm clock: the app's day rolls over at 5am user-local, so the first
// tick past that boundary finds a sleep-day with no map and builds it while
// the user is still asleep. By the time they open the app the map is done —
// the loading screen becomes a 2-second acknowledgement, not a wait.
//
// Why this rides the existing 5-minute cron instead of a `0 5 * * *` entry:
// Cloudflare crons fire in UTC, but "5am" here means 5am *for the user*, and
// the only thing that knows their offset is tz_offset_minutes — whatever the
// client last reported. Deriving the day from that offset on every tick
// follows them across timezones and DST with no config to keep in sync.
// First-open-of-day on the client stays as the fallback (§9.1): if the cron
// missed — the map is still stale — the app rebuilds on demand exactly as before.
const MORNING_REBUILD_IDLE_DAYS = 14; // silence longer than this → wait for an open
const MORNING_REBUILD_LOCK_MS = 10 * 60_000; // a tick already building; don't double up

// Pure and testable: should this tick build? Three ways to say no, and the
// tick says no ~287 times out of 288.
export function shouldMorningRebuild(s: {
  day: string; // the sleep-day it is now, user-local
  mapDay: string | null; // the day the stored map was built for
  lastSeenAt: string | null; // last /api/map open
  startedAt: string | null; // last tick that began a scheduled rebuild
  nowMs: number;
}): boolean {
  if (s.mapDay === s.day) return false; // today's map already exists
  const seenMs = s.lastSeenAt ? Date.parse(s.lastSeenAt) : NaN;
  // Don't spend a Brain call every morning on an app nobody is opening. After
  // a long silence the map waits for the next open, which rebuilds it anyway.
  if (Number.isFinite(seenMs) && s.nowMs - seenMs > MORNING_REBUILD_IDLE_DAYS * 86_400_000) return false;
  // A rebuild outlives its 5-minute tick on a slow Brain call; without this
  // the next tick starts a second one against the same still-empty day.
  const startedMs = s.startedAt ? Date.parse(s.startedAt) : NaN;
  if (Number.isFinite(startedMs) && s.nowMs - startedMs < MORNING_REBUILD_LOCK_MS) return false;
  return true;
}

export async function morningRebuild(env: Env): Promise<void> {
  const db = env.DB;
  const nowMs = Date.now();
  const day = sleepDayKey(nowMs, await getTzOffset(db));
  const [mapDay, lastSeenAt, startedAt] = await Promise.all([
    getState(db, 'map_day'),
    getState(db, 'last_seen_at'),
    getState(db, 'morning_rebuild_started_at'),
  ]);
  if (!shouldMorningRebuild({ day, mapDay, lastSeenAt, startedAt, nowMs })) return;

  await setState(db, 'morning_rebuild_started_at', new Date(nowMs).toISOString());
  await rebuildMap(env, day);
}

// A bubble's break-it-down invitation, answered (§9.2 nudge): the Brain only
// invites; the step's content is the user's. The answer is parsed by Smart
// Capture's own parse call — same date understanding as any capture — but with
// the matching stage structurally off (empty candidates): the answer often
// near-matches the very item it breaks down, and a recapture-merge would eat
// the step. Type is forced to DO and themes are inherited from the bubble, not
// inferred. The step joins the bubble, lands on the card as a chip, and the
// response carries a CaptureResponse so the client runs the usual review sheet.
export async function addFirstStep(
  env: Env,
  bubbleId: string,
  rawTitle: string,
): Promise<{ map: MapPayload; capture: CaptureResponse } | null> {
  const db = env.DB;
  // The title lands inside the card grammar as [title](id) — strip the four
  // marker characters so a stray bracket can't break the sentence markup.
  const title = rawTitle.replace(/[[\]()*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!title) return null;

  const bubble = await db
    .prepare('SELECT id, day, sentence FROM bubbles WHERE id = ?')
    .bind(bubbleId)
    .first<{ id: string; day: string; sentence: string | null }>();
  if (!bubble) return null;

  const memberRows = await db
    .prepare('SELECT item_id FROM bubble_items WHERE bubble_id = ?')
    .bind(bubbleId)
    .all<{ item_id: string }>();
  const themeNames: string[] = [];
  for (const m of memberRows.results) {
    const member = await getItem(db, m.item_id);
    for (const t of member?.themes ?? []) {
      if (!themeNames.includes(t.name)) themeNames.push(t.name);
    }
  }

  // Raw text first, unconditionally (§12) — the answer is a user utterance
  // like any other capture.
  const captureId = newId();
  await db.prepare('INSERT INTO captures (id, ts, raw_text) VALUES (?,?,?)').bind(captureId, nowIso(), title).run();
  await logEvent(db, 'user', 'captured', { payload: { captureId, text: title } });

  const now = new Date();
  const tz = await getTzOffset(db);
  let parsed: ParseResult;
  if (llmAvailable(env)) {
    try {
      parsed = await llmParse(env, title, now, tz, []);
    } catch (err) {
      console.error('first-step parse failed; falling back to heuristics', err);
      parsed = heuristicParse(title, now, tz);
    }
  } else {
    parsed = heuristicParse(title, now, tz);
  }
  const p = parsed.items[0];
  // Re-sanitize: the parsed restatement also lands inside chip markup.
  const stepTitle = (p?.title || title).replace(/[[\]()*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  // An answer to a "when" invitation may phrase its date as an event time;
  // either phrase resolves to the step's deadline.
  const phrase = p?.deadlinePhrase ?? p?.eventAtPhrase ?? null;
  const deadline = refineWithSourceTime(phrase ? resolveDatePhrase(phrase, now, tz) : null, title, now, tz);

  const ts = nowIso();
  const itemId = await insertItem(db, {
    type: 'DO',
    title: stepTitle,
    rawText: { ts, text: title },
    deadline: deadline?.iso ?? null,
    deadlineHardness: deadline ? p?.deadlineHardness ?? 'hard' : null,
    cadence: p?.cadence ?? null,
    pingNatured: p?.pingNatured ?? false,
    effort: 'quick',
    parseConfidence: parsed.confidence === 'high' ? 0.9 : 0.4,
    captureId,
    affects: (p?.affect ?? []).map((tag) => ({ tag, ts })),
    embedding: await embed(env, stepTitle),
  });
  await setItemThemes(db, itemId, themeNames.slice(0, 3), 'user');
  await db
    .prepare('UPDATE items SET last_surfaced_at = ?, surfaced_count = surfaced_count + 1 WHERE id = ?')
    .bind(ts, itemId)
    .run();
  await db.prepare('INSERT OR IGNORE INTO bubble_items (bubble_id, item_id) VALUES (?,?)').bind(bubbleId, itemId).run();

  const sentence = `${(bubble.sentence ?? '').trim()} First: [${stepTitle}](${itemId}).`.trim().slice(0, 700);
  await db
    .prepare('UPDATE bubbles SET sentence = ?, reason = ?, first_step = NULL WHERE id = ?')
    .bind(sentence, stripSentence(sentence).slice(0, 300), bubbleId)
    .run();
  await logEvent(db, 'user', 'first_step_added', { itemId, bubbleId, payload: { title: stepTitle, captureId } });

  const created = await getItem(db, itemId);
  const capture: CaptureResponse = {
    captureId,
    rawText: title,
    created: created ? [toItemView(created, now, tz)] : [],
    boosted: [],
    nudge: parsed.confidence === 'low' ? 'low-confidence' : null,
  };
  return { map: await getMap(env, bubble.day), capture };
}

// The reliable floor, cadence standing, tier machinery, and the staged
// pipeline's placement rules all live in placement.ts (pure, unit-tested);
// re-exported here so existing importers keep one entry point.
export { cadenceOccurrenceToday, cadenceStanding, isTodayRelevant, placeItems, tierProminences } from './placement';
export type { BrainTier, CadenceStanding, Placement, PlacementResult } from './placement';


// The item exactly as the Brain's prompt receives it — one compact line,
// shared between the live call and the debug snapshot so the snapshot never
// lies. Absence = default (no dates, no recurrence, not slipping, must-do,
// medium effort, never recaptured); only deviations are written, so the token
// cost is signal, not structure.
export function brainItemLine(i: ItemView, now: Date, tzOffsetMinutes = 0): string {
  // All day distances are sleep-cycle days (5am boundary) — the same system
  // the UI's countdown badges use, so the Brain's "in five days" can never
  // disagree with the notch on the card it wrote.
  const relDays = (iso: string): string => {
    const d = sleepDayDiff(new Date(iso).getTime(), now.getTime(), tzOffsetMinutes);
    return d < 0 ? `${-d}d-overdue` : d === 0 ? 'today' : `+${d}d`;
  };
  // A date the user gave a time to reads differently from one they didn't:
  // "Thursday at 3pm" is a moment to be at, "Thursday" is a day to fit it in.
  // Without the clock time the Brain wrote "at noon" into card prose, from an
  // anchor the user never said.
  const atClock = (iso: string): string => {
    if (i.datePrecision === 'day') return '';
    const local = new Date(new Date(iso).getTime() + tzOffsetMinutes * 60_000);
    const h = local.getUTCHours();
    const m = local.getUTCMinutes();
    return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''}${h >= 12 ? 'pm' : 'am'}`;
  };
  const parts: string[] = [];
  if (i.deadline) {
    // Time and hardness share one paren group — the same shape a recurring
    // item's happens=today(7pm) already uses, so there is one convention for
    // "the clock detail of this date" rather than two.
    const qual = [atClock(i.deadline), i.deadlineHardness ?? 'hard'].filter(Boolean).join(', ');
    parts.push(`due=${relDays(i.deadline)}(${qual})`);
  }
  if (i.eventAt) {
    // Events use their own vocabulary: "overdue" belongs to deadlines and
    // rhythms, where a past date is an unmet ask. A HAPPEN's past date just
    // happened — rendered through relDays, a trip mid-way through its range
    // read happens=2d-overdue..today and the Brain wrote it up as a missed
    // window to rescue ("it's now or it's gone") instead of an event the
    // user is inside.
    const relEvent = (d: number): string => (d < 0 ? `${-d}d-ago` : d === 0 ? 'today' : `+${d}d`);
    const dStart = sleepDayDiff(new Date(i.eventAt).getTime(), now.getTime(), tzOffsetMinutes);
    const dEnd = i.eventEnd ? sleepDayDiff(new Date(i.eventEnd).getTime(), now.getTime(), tzOffsetMinutes) : null;
    if (dEnd !== null && dStart < 0 && dEnd >= 0) {
      // Mid-event: today falls inside the range. Started/ends is stated
      // outright because a bare past..future range still invites the
      // missed-window misreading; the start's clock time is history by now.
      parts.push(`happens=started-${-dStart}d-ago..${dEnd === 0 ? 'ends-today' : `ends+${dEnd}d`}`);
    } else {
      const clock = atClock(i.eventAt);
      parts.push(`happens=${relEvent(dStart)}${clock ? `(${clock})` : ''}${dEnd !== null ? `..${relEvent(dEnd)}` : ''}`);
    }
  } else if (i.cadence) {
    // Recurring items otherwise never carry a date token at all, forcing the
    // Brain to re-derive "daily + it's Tuesday = today" mid-composition — the
    // inference it kept failing. Where the rhythm stands is stated outright:
    // happens=today (the token the dated NON-NEGOTIABLE keys on) when its turn
    // is today, next= otherwise. Without the second, a weekly-Tuesday chore
    // read on a Saturday looked the same whether Tuesday had been met or
    // missed, and the Brain guessed "overdue" from the weekday name alone.
    const standing = cadenceStanding(i, now, tzOffsetMinutes);
    if (standing?.kind === 'today') {
      parts.push(`happens=today${i.cadence.atTime ? `(${describeAtTime(i.cadence.atTime)})` : ''}`);
    } else if (standing?.kind === 'overdue') {
      parts.push(`next=${standing.days}d-overdue`);
    } else if (standing) {
      parts.push(`next=+${standing.days}d`);
    }
  }
  if (i.cadence) parts.push(`every="${describeCadence(i.cadence)}"`);
  if (i.neglected && i.cadence)
    parts.push(`slipping=${neglectedByDays(i.cadence, i.lastCompletedAt, i.createdAt, now)}d`);
  // Days since first capture — without it, a task that's been sitting three
  // weeks reads identically to one from yesterday, and "piling up" is invisible.
  const ageDays = sleepDayDiff(now.getTime(), new Date(i.createdAt).getTime(), tzOffsetMinutes);
  if (ageDays >= 1) parts.push(`age=${ageDays}d`);
  parts.push(`prio=${Math.round(i.effectivePriority * 100) / 100}`);
  if (i.optionality === 'nice') parts.push('optional');
  if (i.effort !== 'medium') parts.push(i.effort === 'large' ? 'big-effort' : 'quick');
  if (i.lastSurfacedAt) {
    const d = sleepDayDiff(now.getTime(), new Date(i.lastSurfacedAt).getTime(), tzOffsetMinutes);
    parts.push(`seen=${d === 0 ? 'today' : `${d}d-ago`}`);
    // Recency without a count can't tell "asked once" from "asked every
    // morning for a fortnight" — the second is the one that's been declined.
    // Once-shown is the unremarkable case and stays silent, like every other
    // signal here.
    if (i.surfacedCount >= 2) parts.push(`shown=${i.surfacedCount}x`);
  } else {
    parts.push('new');
  }
  const recaptures = Math.max(0, i.rawTexts.length - 1);
  if (recaptures > 0) {
    // Recency is the loud half of the signal: a recapture last night reads
    // very differently from one three weeks ago. Data only — what to do with
    // it stays the Brain's call.
    let when = '';
    if (i.boostUpdatedAt) {
      const d = sleepDayDiff(now.getTime(), new Date(i.boostUpdatedAt).getTime(), tzOffsetMinutes);
      when = `(${d <= 0 ? 'today' : `${d}d-ago`})`;
    }
    parts.push(`recaptured=${recaptures}${when}`);
  }
  if (i.affects?.length) {
    // Tag counts span recaptures — felt=forgotten(x2) is history, not mood.
    const counts = new Map<string, number>();
    for (const a of i.affects) counts.set(a.tag, (counts.get(a.tag) ?? 0) + 1);
    parts.push(`felt=${[...counts.entries()].map(([t, n]) => (n > 1 ? `${t}(x${n})` : t)).join(',')}`);
  }
  const themes = i.themes.length ? ` [${i.themes.map((t) => t.name).join(', ')}]` : '';
  return `${i.type} "${i.title}"${themes} ${parts.join(' ')}`;
}

// Per-call short aliases (i1, i2, …) so the model reads — and, crucially,
// echoes back in its output — 2-token handles instead of 36-char UUIDs.
export function aliasItems(items: ItemView[], now: Date, tzOffsetMinutes = 0): { lines: string[]; idByAlias: Map<string, string> } {
  const idByAlias = new Map<string, string>();
  const lines = items.map((i, idx) => {
    const alias = `i${idx + 1}`;
    idByAlias.set(alias, i.id);
    return `${alias} ${brainItemLine(i, now, tzOffsetMinutes)}`;
  });
  return { lines, idByAlias };
}

// Debug snapshot for workshopping the Brain (§9.2 tuning loop): the exact
// input the Brain was called with on the last rebuild (stored at build time,
// never reconstructed — reconstruction drifts as items change and lies about
// noHistory/fallback runs), paired with the current map output.
export async function brainSnapshot(env: Env, day: string): Promise<unknown> {
  const db = env.DB;

  const stored = await getState(db, 'brain_last_input');
  const last = stored
    ? (JSON.parse(stored) as {
        day: string;
        builtAt: string;
        mode: string;
        noHistory: boolean;
        noProfile?: boolean;
        prompt?: string;
        addendum?: string | null;
        override?: string | null;
        payload: unknown;
      })
    : null;

  const bubbleRows = await db
    .prepare('SELECT id, name, kind, prominence, sentence, first_step FROM bubbles WHERE day = ? ORDER BY prominence DESC')
    .bind(day)
    .all<{ id: string; name: string; kind: string; prominence: number; sentence: string; first_step: string | null }>();
  const memberRows = await db
    .prepare(
      `SELECT bi.bubble_id, i.title FROM bubble_items bi
       JOIN bubbles b ON b.id = bi.bubble_id JOIN items i ON i.id = bi.item_id WHERE b.day = ?`,
    )
    .bind(day)
    .all<{ bubble_id: string; title: string }>();
  const members = new Map<string, string[]>();
  for (const m of memberRows.results) members.set(m.bubble_id, [...(members.get(m.bubble_id) ?? []), m.title]);

  return {
    kind: 'memory-brain-snapshot',
    day,
    builtAt: last?.builtAt ?? (await getState(db, 'map_built_at')),
    // How the last build ran: llm vs fallback, and whether yesterday's
    // groupings were withheld (the no-history workshop rebuild).
    build: last
      ? {
          day: last.day,
          mode: last.mode,
          noHistory: last.noHistory,
          noProfile: last.noProfile ?? false,
          prompt: last.prompt ?? 'full',
          addendum: last.addendum ?? null,
          override: last.override ?? null,
        }
      : null,
    input: last?.payload ?? 'no stored input yet — rebuild the map once to populate',
    output: bubbleRows.results.map((b) => ({
      name: b.name,
      kind: b.kind,
      prominence: b.prominence,
      sentence: b.sentence,
      firstStep: b.first_step,
      items: members.get(b.id) ?? [],
    })),
  };
}

interface ProposedBubble {
  name: string;
  kind: 'situation' | 'rotation';
  prominence: number;
  reason: string;
  sentence: string;
  firstStep: string | null;
  itemIds: string[];
}

// ---------- The top-tier Brain call (§9.2) ----------

// The exact user-side payload the Brain is called with. Built once per
// rebuild, sent to the model, and persisted verbatim (brain_last_input) so
// the debug snapshot reports what the Brain actually saw — a reconstruction
// drifts as items change and lies about withheld history.
export interface BrainInput {
  payload: Record<string, unknown>;
  idByAlias: Map<string, string>;
}

export function brainInput(
  day: string,
  items: ItemView[],
  previous: { name: string; itemTitles: string[] }[],
  nameVocabulary: string[],
  profileText: string | null,
  now: Date,
  tzOffsetMinutes = 0,
): BrainInput {
  const { lines, idByAlias } = aliasItems(items, now, tzOffsetMinutes);
  return {
    payload: {
      today: day,
      weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(`${day}T12:00:00Z`).getUTCDay()],
      items: lines,
      userProfile: profileText,
      recentNameVocabulary: nameVocabulary,
      previouslyShown_reuseOnlyIfStillApt: previous,
    },
    idByAlias,
  };
}

// ---------- the two Brain prompts (workshop shootout, §9.2) ----------
// Shared input legend — one source so the variants can never drift.
const ITEM_FORMAT = `ITEM FORMAT: each item is one line — <id> <TYPE> "title" [themes] signals. Signals appear ONLY when they deviate from the default; absence means: no deadline, no event, no recurrence, not slipping, must-do, medium effort, never recaptured. due/happens/next use relative days (+3d, today, 2d-overdue), with a clock time in parens only when the user named one — due=+2d(3pm, hard) has a time, due=+2d(hard) and happens=+2d name the day with no time attached; "overdue" is deadline/rhythm vocabulary only — a HAPPEN past its date reads happens=2d-ago (it already happened; nothing to chase), and happens=started-2d-ago..ends-today (or ..ends+2d) is a multi-day event UNDERWAY — the user is inside it right now, so a past start is never a miss and needs no urgency; deadline hardness in parens; every= is the recurrence rhythm; next= is when that rhythm comes round again, or how long its last turn has gone unmet; slipping=Nd means a rhythm has gone unmet; age=Nd is days since it was first captured (absent = captured today); prio is 0-1; "optional" = nice-to-do; "quick"/"big-effort" = effort; seen= is when it last appeared on the map, "new" = never shown; shown=Nx is how many maps it has appeared on (absent = at most one) — read against completions it distinguishes "asked once" from "asked every morning and still not done", which is a reason to change the ASK (a different bubble, a plainer framing, a break-it-down invitation) and never on its own a reason to drop or quieten the item; recaptured=N(Xd-ago) means the user re-entered it N times, most recently X days ago (behavioural salience); felt= is the emotional colour the user's own phrasing carried at capture (xN = said across captures).`;

const FULL_SYSTEM = `You are the Brain of "Memory", a memory-aid app for a user with ADHD. Each morning you build the day's bubble map — the curated "what matters right now" view — fresh from the user's items. Reply with ONLY a JSON object.

ORGANIZING PRINCIPLE: a bubble is a reason to act as one unit — build from what today's items actually offer, never from a template. Reasons that recur: an approaching event that just needs seeing; dated must-dos; a handful of small DOs that could fall in one burst because they share a context ("while the kettle boils", "one errand loop"), whatever their topics; one big amorphous thing plus its break-it-down invitation; a couple of facts worth keeping warm. Most days only some of these exist, and some days the right card fits none of these shapes — if a grouping has a clear reason to act as one unit, compose it. Never force a kind onto a day that doesn't contain it, and never pad the map to have one of each. What you don't build: time-buckets ("due this week" is sorting, not acting) and theme-groupings (the browse view owns those). Yours is activation: this user starts hard and, once started, keeps going — one good bundle turns a single activation into several completions, where five separate small cards would each demand their own.

MEMBERSHIP: an item joins a bubble through one of two bonds. The EPISODE bond (situations): the item is part of the same real-world story — the event itself, its sub-events, the prep it demands, the facts needed while it's happening. Test: if the situation were cancelled, this item would vanish or stop mattering. The DOING bond (packages): the item would be completed in the same burst as the others — one sitting, one tool, one trip. Shared topic, shared people, or a shared date are none of these: they're resemblance, not connection. The tell that a member doesn't belong: the sentence needs a link the items don't themselves establish to make it fit. Items may appear in more than one bubble only when genuinely central to both; prefer one home.

MAP SHAPE: a good day is usually 4-7 cards; ten mostly-single-item cards is a list wearing bubbles, and the map's value is gone. Bundling and dropping both get you there, and both are judgment calls. Bundle when the DOING bond genuinely holds — never fabricate a package to hit a count; a forced bundle is worse than a longer list. Drop freely: quiet undated items don't need to appear every day (seen= shows what's had recent airtime — let them take turns across days). Break-it-down invitations each ask the user for real activation energy, so weigh how many one day can carry. The map is the day's shape, not the inventory; browse holds everything.

TIER is the scarce resource, not inclusion. Nothing hard-caps the count — a truly important thing gets its slot even when small — but the target is a composed day (see MAP SHAPE), not coverage. Four tiers, judged fresh each day as relative salience TODAY: "loud" — what the user should meet first (most days have one or two, even when nothing is objectively on fire); "mid" — matters today, met after the loud things; "quiet" — worth seeing, takes its turn; "dot" — barely-there, a glance. Order the bubbles array loudest-first; within a tier, your order is the ranking. Blend four factors, qualitatively: urgency (deadline proximity — but dampened for optional items), importance (the given priority value), effort/lead-time (big tasks need runway: "repaint the fence" outranks "feed the goldfish" at equal due date), and forgettability (easily-slipped things surface harder). Don't let a flat due-date sort bury a big important thing. A package's tier comes from the pile, not the pieces: several small things aging together can outrank any one of them. Deadline proximity raises the tier of whatever bubble an item is in; it never decides membership — two things due the same day are not thereby related (though they may still share a package if they'd be done in the same sitting).

${ITEM_FORMAT}

NON-NEGOTIABLE — TODAY'S DATED ITEMS: every item marked due=today, due=...overdue, or happens=today MUST appear in some bubble. Low priority, optionality, a soft deadline, or profile impressions make a same-day item's bubble QUIETER (never below "quiet"), never absent; must-do or hard-deadline same-day items sit at least "mid". Missing a same-day item is this app's cardinal failure.

The user profile is advisory colour for naming, grouping, and emphasis ONLY. It must never veto: never exclude or demote a dated item because the profile suggests the user might not care about that kind of thing.

KNOWs: event-linked KNOWs (their trigger is another item in the app) go INTO that situation's bubble alongside its DOs. If one of a bubble's DOs would be easier with a particular fact to hand, that fact can ride along in the same bubble — worth a line only where it genuinely helps. Life-triggered KNOWs (trigger the app can't sense) get rehearsal rotation: include ONE small bubble (kind "rotation", tier "dot", name like "Keep in mind") with 2-4 KNOWs, favouring important and not-recently-surfaced ones. Quiet — under-rotate rather than over-rotate; omitting the rotation bubble entirely is often the right call. Distinguish two kinds of KNOW: REFERENCE facts (where objects are stored, measurements, how-tos — useful exactly when searched for) almost never rotate — only if recently recaptured, and never just to fill the bubble. KEEP-WARM facts (people-facts, commitments, insights the user needs near top of mind) are what rotation is for.

NAMING: reuse a name from the vocabulary when semantically apt (never coin a synonym for the same recurring situation — that causes needless reshuffle); coin a new name when the situation genuinely differs. Names are short, concrete, plainly human. Preparation framing ("Before X", "Getting ready for X") is EARNED: use it only when the bubble actually contains prep tasks to do before the event. A bubble that is just an upcoming event (plus related facts) is simply named as the event ("The Lisbon trip", not "Before the Lisbon trip").

PREVIOUSLY SHOWN (yesterday) is provided ONLY as optional reference — reuse a grouping only if it is still apt today. Compose fresh from the items; do NOT treat yesterday's map as a default to preserve.

Do not force every item into the map — the browse view holds everything; you curate. Every bubble needs at least one item.

OUTPUT: {"bubbles":[{"name":str,"kind":"situation"|"rotation","tier":"loud"|"mid"|"quiet"|"dot","sentence":str,"firstStep":str|null,"itemIds":[short ids like "i3" from the item lines]}]}

"sentence" IS the card — on the day view the user reads nothing else (names appear only in browse, search, and the gauge ledger). Write one continuous utterance carrying the facts — what, when, who: a short sentence for a quiet bubble, up to two or three woven sentences for the loudest, fullest one, earned by content, never padding. The card's size on the map already conveys importance — never state how much something matters, its role in the day, or what it anchors or centres. Behavioural signals are facts too: when an item carries one — a felt= colour, recaptured=, slipping=, long age, an unusual prio — say what that signal shows, plainly (that it's for someone, that they keep returning to it, that it keeps slipping). A date alone earns no colour: something merely happening today needs nothing beyond when. Present tense, tokens front-loaded, no filler, never the bubble name, never meta-commentary ("this bubble groups…" is forbidden). When one thing should genuinely come first, say so plainly in the prose.

THE CARD GRAMMAR (only these two marks):
- **bold** the recognizable nouns — people, entities, dates. At distance the card crops to its marked tokens alone, so they must scan as a fragment.
- [phrase](iN) makes that phrase a tappable checkbox chip completing DO item iN in place, e.g. "the [task name](i3)". The phrase must read naturally inside the sentence. Every active DO on a card must be a chip — completing from the card is the point, and a DO that requires opening the sheet to tick off is a broken card. (Rotation bubbles are the exception: no chips.)

CONSTRUCTION follows the cluster's shape:
- Mixed cluster, few actionables → weave facts and 1-3 chips into one utterance.
- 4+ near-identical siblings → speak of the batch collectively, chipping each sibling inline where it reads naturally. Never state the number of items in the sentence — the card renders the true count itself as a progress pip-row.
- One big or long-stalled thing with no date → a bare sentence, no chips, plus "firstStep": a short, direct invitation in your own voice, shaped by what would unstick THIS thing. Ask for a breakdown when there's no visible first action; ask for a when, when the user plainly wants it and just never starts; ask for the tiny first move when it's obvious. The user's typed answer becomes a real item on the card (dates and times in it are understood, so "Thursday evening" works). NEVER write the step's content yourself. firstStep is null in every other case.
- Rotation bubbles read as an offering, not an obligation — no chips.`;

// The minimal variant (the default): objective + contracts at roughly a fifth
// of the full prompt's mass. The shootout showed the two perform equally —
// rules invite performed compliance while the code layer carries every hard
// guarantee (same-day floor, tier bands, chip guarantee, counts) — so the
// smaller prompt wins on maintainability and echo surface. Guidance beyond
// the contracts is bought back one observed regression at a time, stated as
// objectives: resemblance is not a bond (fabricated-bridge gluing);
// old/forgotten items gain importance and big items need lead time (the will
// and the doctor vanishing); reuse vocabulary names (coined synonyms).
const MINIMAL_SYSTEM = `You are the Brain of "Memory", a memory-aid app for a user with ADHD. Each morning you compose the day's map fresh from the user's items: a handful of bubbles, ordered loudest to quietest, that together say what matters today. Reply with ONLY a JSON object.

THE GOAL: put items in one bubble when they genuinely go together — they'd be done in the same burst, they're part of the same real-world situation, or one depends on the other. Resemblance alone (same topic, same people, same date) is not a reason. Don't force weak groupings: single-item bubbles are fine, and so is a short day. You curate rather than inventory — quiet undated items can take turns across days, and the browse view holds everything — but every item marked due=today, due=...overdue, or happens=today must appear in some bubble.

${ITEM_FORMAT}

TIER: each bubble gets "loud", "mid", "quiet", or "dot" — how much of today's attention it deserves. Order the bubbles array loudest-first; within a tier, your order is the ranking. Two corrections to the obvious reading of the signals: an item that has sat unacted (age=, slipping=, recaptured=) matters MORE for it, not less — old is how forgotten looks. And big-effort items need lead time: give them attention well before their moment, not once it's urgent. A bubble holding a same-day item is never below "quiet"; same-day must-dos or hard deadlines sit at least "mid". A "rotation" bubble (the kind field) is an optional tiny keep-in-mind card: 2-4 facts worth rehearsing, tier "dot", no chips — omit it freely.

OUTPUT: {"bubbles":[{"name":str,"kind":"situation"|"rotation","tier":"loud"|"mid"|"quiet"|"dot","sentence":str,"firstStep":str|null,"itemIds":[short ids like "i3" from the item lines]}]}

"sentence" IS the card — the user reads nothing else on the day view. Carry the facts: what, when, who. The card's size on the map already conveys how much it matters — never state a card's importance, its role in the day, or what it anchors or centres. Behavioural signals are facts too: when an item carries one — a felt= colour, recaptured=, slipping=, long age, an unusual prio — say what that signal shows, plainly (that it's for someone, that they keep returning to it, that it keeps slipping). A date alone earns no colour: something merely happening today needs nothing beyond when. A quiet bubble gets a short sentence; a loud one gets more words only when it has more facts to carry, never padding. Never state the number of items in a batch — the card renders the true count itself. Two marks only: **bold** the recognizable nouns (people, dates, entities — at distance the card crops to its marked tokens alone), and [phrase](iN) renders as a tappable checkbox completing DO item iN — give every active DO on the card a chip that reads naturally in the prose; a phrase naming a DO is a chip, never bold.

"firstStep": when one big or stalled thing needs a way in rather than volume, offer a short invitation asking the user for their own first move (their typed answer becomes a real item on the card). Never write the step's content yourself. Otherwise null.

NAMING: if a bubble covers the same ground as a name in recentNameVocabulary, reuse that name exactly — a renamed recurring situation reads as a brand-new one and reshuffles the user's map. Coin a short, concrete, human name only for a genuinely new situation.`;

// 'staged' is the split-mandate pipeline (placement → curation → render, see
// the staged section below); 'full' and 'minimal' are the legacy single-call
// prompts kept for comparison shootouts.
export type BrainPromptVariant = 'full' | 'minimal' | 'staged';

// The default system prompt composition: chosen variant plus the user's
// addendum, appended verbatim — no framing or heading, which would mark it as
// special and make the model over- or under-weight it. Single source of truth
// shared by the live call and the settings endpoint that shows/prefills it.
// 'staged' composes to the minimal text: the staged pipeline has its own two
// prompts and never runs this one — the only reader that asks for it under
// 'staged' is the override-prefill endpoint, where starting from minimal is
// the sensible seed.
export function composeBrainSystem(variant: BrainPromptVariant, addendum: string | null): string {
  const base = variant === 'full' ? FULL_SYSTEM : MINIMAL_SYSTEM;
  return addendum?.trim() ? `${base}\n\n${addendum.trim()}` : base;
}

// The override gate — the ONLY place the prompt-selection decision is made,
// pure so it's unit-testable. Both conditions must hold to run the override:
// the checkbox is enabled AND the saved text is non-empty. Unchecked, the
// stored override text is inert no matter what it says; checked-but-empty
// falls back to the normal flow rather than running on a blank prompt. The
// returned record fields mirror the decision for the snapshot: never both an
// addendum and an override.
export function selectBrainSystem(
  variant: BrainPromptVariant,
  addendum: string | null,
  overrideEnabled: boolean,
  overrideText: string | null,
): { system: string; prompt: BrainPromptVariant | 'override'; addendum: string | null; override: string | null } {
  const cleanAddendum = addendum?.trim() || null;
  const cleanOverride = overrideText?.trim() || null;
  if (overrideEnabled && cleanOverride !== null) {
    return { system: cleanOverride, prompt: 'override', addendum: null, override: cleanOverride };
  }
  return { system: composeBrainSystem(variant, cleanAddendum), prompt: variant, addendum: cleanAddendum, override: null };
}

// ---------- the staged pipeline (placement → curation → render) ----------
//
// The single-call Brain asked one objective — "what's salient today?" — to
// answer three different questions, and deadline proximity won all three:
// quick tasks surfaced days early, undated items starved (the same few
// stalled winners monopolised every discretionary slot), and rotation never
// fired because "omit freely", judged fresh each morning with no memory,
// resolves to always-omit. The staged pipeline gives each question to the
// layer whose objective actually asks it:
//
//   layer 1 — placement.ts (code): what is REQUIRED today, at what floor.
//   layer 2 — the curation call (top tier): what ELSE earns a place, and how
//             everything groups. Never sees yesterday's map — anti-stickiness
//             by construction; continuity lives in the name vocabulary below.
//   layer 3 — the render call (cheap tier): names and card sentences, one
//             call for the whole map so naming stays consistent.
//
// The burden of proof flips at layer 2: the skeleton is already placed, so
// inclusion needs a stated reason ("due soon" is explicitly not one), and
// a light skeleton means free slots — background surfacing anti-correlates
// with busyness instead of always losing to it.

export type FirstStepKind = 'breakdown' | 'name-a-when' | 'tiny-first-move';
const FIRST_STEP_KINDS = ['breakdown', 'name-a-when', 'tiny-first-move'] as const;
// 'horizon' was removed as a named bond after one observed morning: naming it
// licensed gluing tomorrow's near-certain events to a party six days out. If
// a genuine glance-at-the-week card wants to exist, it can emerge organically
// through the ordinary bonds; unknown bond strings coerce below.
// 'rehearsal' was removed the same way: offering it licensed declaring a DO
// "kept warm", which handed the writer a bond contradicting its own derived
// register (deriveBubbleKind says all-KNOW, and it is the authority for chips)
// — the card came back chip-less and the chip guarantee patched in an orphan.
// The bond duplicated a judgment code already derives from membership; a
// kept-warm KNOW is just an add, and its card goes rehearsal-register on its
// own.
const BUBBLE_BONDS = ['episode', 'package', 'solo'] as const;
type BubbleBond = (typeof BUBBLE_BONDS)[number];

export interface CurationBubble {
  members: string[]; // aliases
  bond: BubbleBond;
  // The bond test's answer, written down (episode → occurrence, package →
  // sitting). Elicitation, not enforcement: no code judges these strings —
  // their value is that a claim forced into a named field is a claim the
  // model has to actually make, and one the snapshot lets a human audit at
  // a glance. A person, a theme, or "the relationship" sitting in an
  // occurrence field indicts itself.
  occurrence: string | null;
  sitting: string | null;
  // Annotation for the record (why the discretionary members earn today —
  // starved, stalled, opportunity...), never a gate.
  tags: string[];
  tier: BrainTier;
  rationale: string;
  firstStep: FirstStepKind | null;
}

export interface CurationPlan {
  bubbles: CurationBubble[];
}

const CURATION_SYSTEM = `You are the curator of "Memory", a memory-aid app for a user with ADHD. Each morning, deterministic code places the day's REQUIRED items — the mandatory list, each entry naming the rule that fired (due-today, overdue, event-today, rhythm-today, runway for big-effort things, first-sight for a never-shown upcoming event) and the floor tier code will enforce. You do the two things rules cannot: decide what ELSE earns a place on today's map, and compose everything — required and added — into bubbles: small groups that act as one unit. Reply with ONLY a JSON object.

${ITEM_FORMAT}

ADDS — what else earns a place today. There is no separate ledger: placing a non-mandatory item in a bubble IS the add, and that bubble's rationale must carry why the item is there — it must survive "why this, today, instead of nothing?". Three forces can put an item on a map: anticipation (its date is approaching), opportunity (today makes acting on it unusually cheap), and attention (it needs to be seen again). Anticipation is not yours: code runs the calendar and will surface every dated item when its day arrives, so an inclusion justified by an approaching date — in any wording: due soon, coming up, a heads-up, worth knowing about, before the weekend — is code's job done worse, and does not enter. Your two reasons:
- OPPORTUNITY: today's map already contains a context this item genuinely joins — the bubble it lands in is the claim, and that bubble's bond test is the verification.
- ATTENTION: airtime. The accounting block names the never-shown backlog outright (its ids and the oldest age); prefer what has NOT had recent airtime over what was seen today. A stalled item (shown many mornings, still unacted) earns a place only with a CHANGED ask, never a repeat. A KNOW worth rehearsing (important or recaptured, not recently seen) is a keep-warm; where-things-are reference facts almost never qualify.
"tags" (optional, per bubble): annotate why its non-mandatory members earn today — "opportunity", "starved", "stalled", "keep-warm", "momentum" (fits a burst rhythm the profile shows), "runway-pull" (the lead-time rules underestimate a big item — an explicit override, argued in the rationale), "other". Annotation for the record, never a gate. Budget by map shape (see BUBBLES), not by item count. When the mandatory set is light, spend more freely — a quiet day is exactly the day for a lingering goal, an old someday item, or a fact worth keeping warm. When it is heavy, hold back; a map with no discretionary members at all is a fine answer.

BUBBLES — compose the day. Every mandatory item MUST appear in at least one bubble. Every add goes where its reason points — its own bubble is fine. Bundling is half your job: the mandatory list arrives flat, and composing it is what turns a list into a map. A good day is usually 4-8 bubbles; ten single-item bubbles is a list wearing bubbles — though a real bond is rarer than it looks, and a forced one is worse than a longer list.

A bubble is a claim: these members act as one unit. Only two kinds of claim are ever true, and each has a test to run BEFORE grouping:
- EPISODE: the members belong to one OCCURRENCE — an event, a visit, a trip, a moment a deadline creates — and what that occurrence itself demands: its prep, its sub-events, the facts needed while it happens. The test: name the occurrence, then cancel it in your head. If every other member goes moot, the bond is real. If what you named is a person, a theme, a feeling, or a span of time, it is not an occurrence, and there is no episode. Write it down: every episode bubble carries "occurrence" — the occurrence you named, in a few words.
- PACKAGE: completing one member leaves the user already positioned to complete the next. The test: picture them finishing one member and ask what stands between them and the next. If the answer is nothing — same spot, same instrument, same company, same stretch of the day — the bond is real. If anything must change first — a place, a tool, who is present, or waiting for another day — it is not. Write it down: every package bubble carries "sitting" — the single burst you pictured, in a few words ("one phone sitting", "the Chinatown trip").
Resemblance is the counterfeit of both bonds, and it wears every attribute: same topic, same person, same theme tag, same date, same hour, same effort, same mood, same track record of getting done together. Shared attributes are how items LOOK; bonds are facts about the DOING, and only the tests establish them. The tell of a fake bond: the card's sentence would need a link the items don't themselves establish. Never bend a test to save a card slot — a weak add belongs nowhere rather than in the wrong bubble.
The remaining bond: "solo" (stands alone — common, and fine). A KNOW worth keeping warm is an add like any other — a bubble of only KNOWs renders as a gentle offering on its own. Each bubble carries a rationale (why this grouping exists today, in your own words — for a non-mandatory member, this is also why IT is here), its occurrence or sitting per its bond, optional tags, a tier, and firstStep.

TIER: "loud" | "mid" | "quiet" | "dot" — how much of today's attention the bubble deserves; order the array loudest first (within a tier, your order is the ranking). Never place a bubble below any member's floor. Two corrections to the obvious reading of the signals: an item that has sat unacted (age=, shown=, recaptured=) matters MORE for it, not less — old is how forgotten looks; and a package's tier comes from the pile, not the pieces — several small things aging together can outrank any one of them.

firstStep: only when a big or stalled thing needs a way in rather than volume — each invitation asks the user for real activation energy, so most days carry one or two, rarely more: "breakdown" (no visible first action), "name-a-when" (they plainly want it and never start), "tiny-first-move" (the first move is obvious and small). A writer phrases the invitation; you only flag it. Everywhere else: null.

The user profile is advisory colour — it may shape which adds fit the day and how things group; it never removes a mandatory item.

OUTPUT: {"bubbles":[{"members":["iN"],"bond":"episode"|"package"|"solo","occurrence":str (episode only),"sitting":str (package only),"tier":"loud"|"mid"|"quiet"|"dot","rationale":str,"tags":[str] (optional),"firstStep":null|"breakdown"|"name-a-when"|"tiny-first-move"}]}`;

const RENDER_SYSTEM = `You are the writer of "Memory", a memory-aid app for a user with ADHD. A curator has composed today's map; each card arrives with its members (full item lines), its bond, its tier, its register, the curator's rationale (why) and tags — internal notes on why the card exists, for your understanding only — and, for episodes and packages, the occurrence or sitting it is built on: the real-world frame your sentence should inhabit. You write everything the user reads: each card's name and sentence. Reply with ONLY a JSON object.

${ITEM_FORMAT}

"sentence" IS the card — on the day view the user reads nothing else, and the card's NAME is NOT displayed there (names live in browse and search only). Every sentence must stand completely alone: never lean on the name for framing, never assume the user sees it. One continuous utterance carrying the facts — what, when, who: short for a quiet card, up to two or three woven sentences for the loudest, fullest one, earned by content, never padding. A card can be as short as its chip: when a card carries nothing beyond one task and maybe a time, the chip and the time ARE the sentence — "[Reach out to John](i6)." is a finished card, and decoration on a bare card is the failure, not the brevity.

THE FACTS, PRECISELY:
- Chronological: mention members in the order they happen today.
- Every timed member gets its time — never a time for one and not another on the same card.
- Days are named, not gestured at: "tomorrow (Friday) at 6pm", "next Wednesday at 7pm" — never "lands tomorrow", never "soon", never "the following Wednesday".
- An occurrence or sitting is only as real as its members' dates: when no member carries one, the outing is an idea, not a plan — write it as an invitation, never as something already happening.
- The card's size already conveys importance — never state how much something matters, its role in the day, or what it anchors or centres. Never state the number of items in a batch — the card renders the true count itself. When one thing should genuinely come first, say so plainly.

WHAT THE SIGNALS DO: they decide which facts you choose and how plainly you say them — they never become a clause of their own. The card's reason for existing is not news: the user does not need to be told why something is on their map, and telling them is exactly what makes a card read like a machine explaining itself. Never report the user's own track record back at them — no counting days missed or mornings shown, no streaks, no slipping, no "still". Concretely: felt=for-someone → the person belongs INSIDE the fact ("[French with Kayla](i19) at **7pm**"), never appended as a tail (", for her" is the named failure); felt=important or recaptured= → give it the plainest, most concrete phrasing on the map, not a remark about how it keeps coming back; a hard due date → name the date and stop, because its fixity is why you named it, not a thing to say; a big or far-off item → name the span and the dates, and never editorialize about planning, preparation, or how much notice it will want. And no softening diminutives — "a little French", "a quick tidy", "just a short call": the size of a thing is already in the words the user gave it.

THE TAIL IS THE TELL. The commonest failure is a correct fact, an em dash, and then a clause explaining why the card is here, why it matters, or how the user has been doing with it. Ask of every clause you write: what does the user stop knowing about the world if I delete this? If the answer is nothing, it is the tail — cut it and let the sentence end early. Short is not unfinished.

THE INPUT IS NOT ENGLISH YOU MAY BORROW. The curator's "why", the tags, the register names, and the signal names on the item lines are internal shorthand written for machines. Their content may inform which facts you pick; their wording must never reach the user. Shop-talk — "lead time", "runway", "rhythm", "the date won't move", "keep warm", "airtime", "hook", "first step" — is not how a person writes a note to someone they know, and never appears in a sentence.

ONLY WHAT THE LINES CARRY. You do not know a shop's opening hours, how long a task takes, how the user will feel, or what else is in their day. Never invent a supporting fact to prop up a card — a fabricated reason is worse than no reason.

THE CARD GRAMMAR (only these two marks):
- **bold** the recognizable nouns — people, entities, dates, times. At distance the card crops to its marked tokens alone, so they must scan as a fragment.
- [phrase](iN) makes that phrase a tappable checkbox chip completing DO item iN in place, e.g. "the [task name](i3)". EVERY member that is an active DO MUST appear as a chip woven naturally into the prose — no exceptions, whatever the bond: a missing chip is a broken card (the app appends an orphaned chip at the end, which reads as a glitch). A phrase naming a DO is a chip, never bold, and the chip phrase names the TASK, never its date — "[type out the will](i12) by **5pm**", not "[due today at 5pm](i12)" (the label doubles as a checkbox elsewhere in the app). A gentle card still chips its DO — the chip is how the user acts on even the gentlest offer. The single exception: cards whose register is "rehearsal" carry no chips — they read as an offering, never an obligation.

CONSTRUCTION follows the card's shape:
- Mixed members, few DOs → weave facts and chips into one utterance.
- 3+ same-type siblings (a batch) → speak of the batch collectively, list-like and rhythmic — each chip inline where it reads naturally — never one run-on clause chain.
- One big or stalled thing carrying a firstStep flag → the plain fact as it stands today, plus the invitation. Its history is why the card asks differently this morning; it is not the sentence's content, and reciting it back ("three days since the last one", "this has been sitting a while") is the failure the invitation exists to avoid.
- Register "rehearsal" → the user's own note, handed back: no ask, and no reason attached. Keep their words and their person — a note they wrote to themselves stays in their voice, and re-aiming it at them in the second person ("the hardest part has been letting yourself relax") turns a private note into a stranger's advice. A relative date inside their captured text was true when they wrote it, not today: never repeat "tomorrow" or "next week" from a note as if it still holds — name the real date, or drop it.

CALIBRATION — the same cards, machine-written then human-written:
- MACHINE: "Three days since the last one, but the **7pm** hook is still there — [a little French with Kayla](i19), for her." HUMAN: "[French with Kayla](i19) at **7pm**."
- MACHINE: "[Repair the bike tire](i3) at the **Bike Shop** today — the shop's open in daytime hours and the date won't move." HUMAN: "[Repair the bike tire](i3) at the **Bike Shop** today."
- MACHINE: "The **Newfoundland** trip for **Ryan and Chelsey's wedding** runs in about six weeks, **October 8th-11th** — far off, but a big trip that'll want real lead time." HUMAN: "**Ryan and Chelsey's wedding** in **Newfoundland**, **October 8th-11th**."
Every fact survives each rewrite; only commentary is lost. When a sentence feels thin after the cut, that is the card being honest about how much it actually holds.

"firstStep": only on the card whose input carries a firstStep flag, write a short, direct invitation in your own voice, shaped by the flag — "breakdown": ask for the first piece; "name-a-when": ask them to name a time; "tiny-first-move": ask for the smallest move. NEVER write the step's content yourself — the user's typed answer becomes a real item on the card (dates and times in it are understood, so "Thursday evening" works). Every other card: null.

NAMING: if a card covers the same ground as a name in nameVocabulary, reuse that name EXACTLY — a renamed recurring situation reads as brand-new and reshuffles the user's map. Reuse must be factually apt: never a name carrying a person, place, or day the card doesn't actually contain — a wrong-person name is worse than a coined one. Coin a short, concrete, plainly human name only for genuinely new ground. Preparation framing ("Before X") is earned only when the card actually contains prep tasks.

OUTPUT: {"cards":[{"ref":int,"name":str,"sentence":str,"firstStep":str|null}]} — exactly one entry per input card, same ref, every card present.`;

// All-KNOW membership is what makes a rehearsal card — the register is a
// fact about content, derived here, never a category the model declares.
// (The old pipeline asked the model to opt into a countable "rotation"
// bubble; judged fresh daily with no memory, "omit freely" meant it never
// fired. Now a kept-warm KNOW is just an add like any other, and the dashed
// offered-not-owed register follows from what the card holds.)
export function deriveBubbleKind(memberTypes: string[]): 'situation' | 'rotation' {
  return memberTypes.length > 0 && memberTypes.every((t) => t === 'KNOW') ? 'rotation' : 'situation';
}

// Curation output → validated plan, pure. Code enforces only what the spec
// owns: known aliases, floors never undercut, the two-invitation cap, every
// mandatory item covered (an ignored one gets a solo bubble carrying its
// rule), loudest-first order. Membership IS the add declaration — the old
// separate adds array was double-entry bookkeeping the model had to keep in
// sync with the bubbles, and it predictably didn't: a correct lesson+class
// package once lost a member to a forgotten declaration, silently. One
// ledger, one truth; the bubble's rationale carries the why.
export function validateCurationPlan(
  raw: { bubbles?: unknown } | null | undefined,
  floors: Map<string, { floor: BrainTier; rule: string }>,
  eligibleAliases: Set<string>,
): CurationPlan {
  const allowed = new Set<string>([...floors.keys(), ...eligibleAliases]);
  const rawBubbles = Array.isArray(raw?.bubbles) ? (raw!.bubbles as Record<string, unknown>[]) : [];
  const bubbles: CurationBubble[] = [];
  for (const b of rawBubbles) {
    if (!b || typeof b !== 'object') continue;
    const seen = new Set<string>();
    const members = (Array.isArray(b.members) ? b.members : [])
      .map((m) => String(m).trim())
      .filter((m) => {
        if (!allowed.has(m) || seen.has(m)) return false;
        seen.add(m);
        return true;
      });
    if (!members.length) continue;
    const bond = (BUBBLE_BONDS as readonly string[]).includes(String(b.bond))
      ? (String(b.bond) as BubbleBond)
      : members.length > 1
        ? 'package'
        : 'solo';
    // The elicited test answers ride only on the bond they belong to — an
    // occurrence on a package (or vice versa) is a confused claim, not data.
    const occurrence =
      bond === 'episode' && typeof b.occurrence === 'string' && b.occurrence.trim()
        ? b.occurrence.trim().slice(0, 120)
        : null;
    const sitting =
      bond === 'package' && typeof b.sitting === 'string' && b.sitting.trim()
        ? b.sitting.trim().slice(0, 120)
        : null;
    const tags = (Array.isArray(b.tags) ? b.tags : []).map((t) => String(t).slice(0, 40)).slice(0, 4);
    const rationale = String(b.rationale ?? '').slice(0, 300);
    // No cap: how many invitations a day can carry is the curator's judgment
    // (the prompt frames the cost). A code cap silently nulled the third flag
    // while its rationale still carried the intent — and the writer then
    // smuggled the invitation into the card as content it authored itself,
    // the one thing an invitation exists to avoid.
    const firstStep = (FIRST_STEP_KINDS as readonly string[]).includes(String(b.firstStep))
      ? (String(b.firstStep) as FirstStepKind)
      : null;
    let tier: BrainTier = isBrainTier(b.tier) ? b.tier : 'quiet';
    for (const m of members) {
      const f = floors.get(m);
      if (f) tier = maxTier(tier, f.floor);
    }
    bubbles.push({ members, bond, occurrence, sitting, tags, tier, rationale, firstStep });
  }

  // The one coverage net left (a spec guarantee, not taste): a mandatory item
  // the plan ignored still reaches the map, its rule as its rationale.
  const covered = new Set(bubbles.flatMap((b) => b.members));
  for (const [alias, f] of floors) {
    if (covered.has(alias)) continue;
    bubbles.push({
      members: [alias],
      bond: 'solo',
      occurrence: null,
      sitting: null,
      tags: [],
      tier: f.floor,
      rationale: f.rule,
      firstStep: null,
    });
  }

  bubbles.sort((x, y) => compareTier(x.tier, y.tier)); // stable: within a tier, plan order is the ranking
  return { bubbles };
}

// One rebuild through the three layers. Throws only when the curation call
// fails (rebuildMap falls back to the deterministic map, as ever); a render
// failure degrades to mechanical sentences — the composition survives, the
// prose is plain for a day.
async function stagedBuildBubbles(
  env: Env,
  items: ItemView[],
  day: string,
  nameVocabulary: string[],
  profileText: string | null,
  now: Date,
  tz: number,
  addendum: string | null = null,
): Promise<{ proposed: ProposedBubble[]; payload: Record<string, unknown> }> {
  // Placement first: the day's working set is what layer 1 requires plus the
  // pile it leaves eligible. Withheld items (future-turn rhythms) exit HERE —
  // their lines never reach the curator, so there is no temptation to police
  // away downstream; the pile is shaped at the input, not at the output.
  const { mandatory, eligible } = placeItems(items, now, tz);
  const inPlay = new Set([...mandatory.map((m) => m.item.id), ...eligible.map((i) => i.id)]);
  const working = items.filter((i) => inPlay.has(i.id));

  const { lines, idByAlias } = aliasItems(working, now, tz);
  const aliasById = new Map([...idByAlias].map(([alias, id]) => [id, alias]));
  // Keyed via aliasById, never by re-deriving `i${idx+1}` — one authority for
  // the alias scheme (aliasItems), so the two can't silently desync.
  const lineByAlias = new Map(working.map((it, idx) => [aliasById.get(it.id)!, lines[idx]]));
  const viewById = new Map(working.map((i) => [i.id, i]));
  const floors = new Map(mandatory.map((m) => [aliasById.get(m.item.id)!, { floor: m.floor, rule: m.rule }]));
  const eligibleAliases = new Set(eligible.map((i) => aliasById.get(i.id)!));

  // The minimal accounting the airtime objective needs — item-level
  // attribution but never yesterday's compositions (composition feedback is
  // the stickiness channel this pipeline deliberately does not have). The
  // backlog is named id by id: a bare count proved inert — the curator won't
  // scan 30 lines hunting for "new", but it will look up a listed alias.
  const neverShown = eligible.filter((i) => !i.lastSurfacedAt);
  const accounting = {
    eligibleCount: eligible.length,
    neverShown: neverShown.map((i) => aliasById.get(i.id)!),
    oldestNeverShownDays: neverShown.length
      ? Math.max(...neverShown.map((i) => sleepDayDiff(now.getTime(), new Date(i.createdAt).getTime(), tz)))
      : 0,
  };

  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    new Date(`${day}T12:00:00Z`).getUTCDay()
  ];
  const curationInput = {
    today: day,
    weekday,
    items: lines,
    mandatory: [...floors.entries()].map(([id, f]) => ({ id, rule: f.rule, floor: f.floor })),
    accounting,
    userProfile: profileText,
  };

  // The user's addendum lands on the curation call — curation is the
  // judgment the tuning knob exists to tune. Same composition rule as the
  // legacy prompts: appended verbatim, no framing (§ composeBrainSystem).
  const curationSystem = addendum?.trim() ? `${CURATION_SYSTEM}\n\n${addendum.trim()}` : CURATION_SYSTEM;
  const rawPlan = await anthropicJson<{ bubbles?: unknown }>(
    env,
    env.BRAIN_MODEL,
    curationSystem,
    JSON.stringify(curationInput),
    4096,
  );
  const plan = validateCurationPlan(rawPlan, floors, eligibleAliases);

  const kinds = plan.bubbles.map((b) =>
    deriveBubbleKind(b.members.map((m) => viewById.get(idByAlias.get(m) ?? '')?.type ?? '')),
  );
  const renderInput = {
    today: day,
    weekday,
    cards: plan.bubbles.map((b, idx) => ({
      ref: idx,
      tier: b.tier,
      bond: b.bond,
      register: kinds[idx] === 'rotation' ? 'rehearsal' : 'standard',
      why: b.rationale,
      // The curator's elicited bond claim rides along — the writer frames the
      // card around the occurrence or sitting the plan actually named. Tags
      // ride too: "opportunity" vs nothing is the difference between a
      // proposed outing and a booked one, and withholding it from the one
      // layer that writes prose produced a card stating a suggestion as fact.
      ...(b.tags.length ? { tags: b.tags } : {}),
      ...(b.occurrence ? { occurrence: b.occurrence } : {}),
      ...(b.sitting ? { sitting: b.sitting } : {}),
      members: b.members.map((m) => ({
        id: m,
        line: lineByAlias.get(m) ?? m,
        required: floors.get(m)?.rule ?? null,
      })),
      firstStep: b.firstStep,
    })),
    nameVocabulary,
    userProfile: profileText,
  };

  // Top tier, same as curation. The first observed staged morning corrected
  // an assumption: the sentence IS the product surface, and the cheap tier
  // produced flat tone, missed chips, and platitudes where the legacy
  // top-tier single call never did. Curation's output is small, so two
  // top-tier calls still land near the old single call's cost.
  let renderCards: { ref?: unknown; name?: unknown; sentence?: unknown; firstStep?: unknown }[] = [];
  let renderError: string | null = null;
  try {
    const out = await anthropicJson<{ cards?: typeof renderCards }>(
      env,
      env.BRAIN_MODEL,
      RENDER_SYSTEM,
      JSON.stringify(renderInput),
      8192,
    );
    renderCards = Array.isArray(out.cards) ? out.cards : [];
  } catch (err) {
    renderError = err instanceof Error ? err.message : String(err);
    console.error('Brain render call failed; composing mechanical sentences', err);
  }
  const cardByRef = new Map(renderCards.filter((c) => typeof c?.ref === 'number').map((c) => [c.ref as number, c]));

  const prominences = tierProminences(plan.bubbles.map((b) => b.tier));
  const proposed: ProposedBubble[] = plan.bubbles.map((b, idx) => {
    const memberIds = b.members.map((m) => idByAlias.get(m)!).filter(Boolean);
    const memberViews = memberIds.map((id) => viewById.get(id)!).filter(Boolean);
    const kind = kinds[idx];
    const card = cardByRef.get(idx);
    const rawSentence =
      typeof card?.sentence === 'string' && card.sentence.trim()
        ? card.sentence
        : composeSentence(memberViews, now, tz);
    // Rehearsal cards carry no chips — enforced here (maxChips 0 degrades any
    // stray chip to bold), not merely requested of the writer.
    const sentence = resolveSentence(rawSentence, idByAlias, new Set(memberIds), kind === 'rotation' ? 0 : Infinity);
    const name =
      typeof card?.name === 'string' && card.name.trim()
        ? card.name.trim()
        : (memberViews[0]?.title ?? 'Today').slice(0, 60);
    // The invitation exists only where the curator flagged it; an unflagged
    // card's firstStep is discarded even if the writer volunteered one.
    const firstStep =
      b.firstStep && typeof card?.firstStep === 'string' && card.firstStep.trim() ? card.firstStep.trim() : null;
    return { name, kind, prominence: prominences[idx], reason: '', sentence, firstStep, itemIds: memberIds };
  });

  // The debug snapshot's staged shape: skeleton → plan → prose, each stage
  // diffable — the record of WHY the map is what it is.
  const payload: Record<string, unknown> = {
    pipeline: 'staged',
    today: day,
    weekday,
    items: lines,
    skeleton: curationInput.mandatory,
    accounting,
    userProfile: profileText,
    plan,
    planRaw: rawPlan,
    renderInput,
    renderCards,
    renderError,
    nameVocabulary,
  };
  return { proposed, payload };
}

async function llmBuildBubbles(env: Env, input: BrainInput, system: string): Promise<ProposedBubble[]> {
  const { idByAlias } = input;
  const user = JSON.stringify(input.payload);

  interface RawBubble {
    name?: string;
    kind?: string;
    tier?: string;
    sentence?: string;
    reason?: string;
    firstStep?: unknown;
    itemIds?: unknown[];
  }
  const out = await anthropicJson<{ bubbles: RawBubble[] }>(env, env.BRAIN_MODEL, system, user, 8192);
  const raw = (out.bubbles ?? []).filter((b) => b && b.name && Array.isArray(b.itemIds));
  const prominences = tierProminences(raw.map((b) => (isBrainTier(b.tier) ? b.tier : 'quiet')));
  return raw.map((b, idx) => {
    // Aliases back to real ids; unknown aliases drop (validated again upstream).
    const itemIds = (b.itemIds as unknown[]).map((a) => idByAlias.get(String(a).trim()) ?? '').filter(Boolean);
    // Chip refs in the sentence resolve the same way; strays degrade to bold.
    const sentence = resolveSentence(String(b.sentence ?? b.reason ?? ''), idByAlias, new Set(itemIds));
    const firstStep = typeof b.firstStep === 'string' && b.firstStep.trim() ? b.firstStep.trim() : null;
    return {
      name: String(b.name),
      kind: b.kind === 'rotation' ? 'rotation' as const : 'situation' as const,
      prominence: prominences[idx],
      reason: stripSentence(sentence),
      sentence,
      firstStep,
      itemIds,
    };
  });
}

// ---------- Deterministic fallback map (no LLM configured) ----------

function shortDate(iso: string, now: Date, tzOffsetMinutes: number): string {
  const days = sleepDayDiff(new Date(iso).getTime(), now.getTime(), tzOffsetMinutes);
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return new Date(iso).toLocaleDateString('en', { weekday: 'short' });
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

// Card-grammar sentence without an LLM: active DOs become chips (max 3),
// everything else bold titles, dates bold — mechanical but in register.
function composeSentence(items: ItemView[], now: Date, tzOffsetMinutes: number, lead = ''): string {
  let chips = 0;
  const parts = items.slice(0, 3).map((i) => {
    const when = i.deadline ?? i.eventAt;
    const date = when ? ` **${shortDate(when, now, tzOffsetMinutes)}**` : '';
    if (i.type === 'DO' && i.status === 'active' && chips < 3) {
      chips += 1;
      return `[${i.title}](${i.id})${date ? ` by${date}` : ''}`;
    }
    return `**${i.title}**${date}`;
  });
  const extra = items.length - Math.min(items.length, 3);
  return `${lead}${parts.join(', ')}${extra > 0 ? ` — and **${extra} more** in the sheet` : ''}.`;
}

function proposed(
  name: string,
  kind: 'situation' | 'rotation',
  prominence: number,
  sentence: string,
  items: ItemView[],
  firstStep: string | null = null,
): ProposedBubble {
  return { name, kind, prominence, reason: stripSentence(sentence), sentence, firstStep, itemIds: items.map((i) => i.id) };
}

function fallbackBubbles(items: ItemView[], now: Date, tzOffsetMinutes: number): ProposedBubble[] {
  const bubbles: ProposedBubble[] = [];
  const dueSoon = items.filter(
    (i) => i.type === 'DO' && i.deadline && sleepDayDiff(new Date(i.deadline).getTime(), now.getTime(), tzOffsetMinutes) < 7,
  );
  if (dueSoon.length) {
    const soonest = Math.min(
      ...dueSoon.map((i) => sleepDayDiff(new Date(i.deadline!).getTime(), now.getTime(), tzOffsetMinutes)),
    );
    bubbles.push(
      proposed(
        'Due soon',
        'situation',
        soonest <= 0 ? 0.95 : 0.7,
        composeSentence(dueSoon, now, tzOffsetMinutes),
        dueSoon,
      ),
    );
  }
  const neglected = items.filter((i) => i.neglected && !dueSoon.includes(i));
  if (neglected.length) {
    bubbles.push(
      proposed(
        'Rhythms to pick back up',
        'situation',
        0.5,
        composeSentence(neglected, now, tzOffsetMinutes, 'The rhythm slipped — '),
        neglected,
      ),
    );
  }
  const upcoming = items.filter(
    (i) => i.type === 'HAPPEN' && i.eventAt && new Date(i.eventAt).getTime() > now.getTime() - 86_400_000 &&
      sleepDayDiff(new Date(i.eventAt).getTime(), now.getTime(), tzOffsetMinutes) < 14,
  );
  if (upcoming.length) {
    bubbles.push(proposed('Coming up', 'situation', 0.55, composeSentence(upcoming, now, tzOffsetMinutes), upcoming));
  }
  const important = items.filter(
    (i) => i.effectivePriority >= 0.65 && !dueSoon.includes(i) && !neglected.includes(i) && !upcoming.includes(i) && i.type !== 'KNOW',
  );
  if (important.length) {
    bubbles.push(proposed('Important', 'situation', 0.45, composeSentence(important, now, tzOffsetMinutes), important));
  }
  // Quiet rehearsal rotation (§9.2): a few important, least-recently-seen
  // KNOWs. Reference facts (low priority, never recaptured) stay out — they
  // exist for search, not rehearsal.
  const knows = items
    .filter((i) => i.type === 'KNOW' && (i.effectivePriority >= 0.35 || i.rawTexts.length > 1))
    .sort((a, b) => {
      const aSeen = a.lastSurfacedAt ?? '1970';
      const bSeen = b.lastSurfacedAt ?? '1970';
      if (aSeen !== bSeen) return aSeen.localeCompare(bSeen);
      return b.effectivePriority - a.effectivePriority;
    })
    .slice(0, 3);
  if (knows.length) {
    bubbles.push(
      proposed(
        'Keep in mind',
        'rotation',
        0.12,
        `Worth a glance: ${knows.map((i) => `**${i.title}**`).join(' · ')}.`,
        knows,
      ),
    );
  }
  return bubbles;
}

// ---------- Tier-2 profile recompute (§7.3) ----------

// Compress administrative churn before the profile builder sees the log:
// rapid capture→edit→reject cycles are the user operating the app, not living
// their life, and profiling them poisons surfacing (a real incident: the
// profile branded a kind of item "usually rejected" and the Brain dropped a
// same-day task). Pure and unit-tested.
export function compactEventLines(
  events: { ts: string; actor: string; type: string; item_id: string | null; payload: string }[],
  titleById: Map<string, string>,
  tzOffsetMinutes = 0,
): string[] {
  const parse = (s: string): Record<string, unknown> => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const fmt = (ts: string, actor: string, type: string, detail: string) =>
    `${ts.slice(5, 16).replace('T', ' ')} ${actor} ${type}${detail ? ` — ${detail}` : ''}`;

  // Checkbox churn: a completion_reverted negates the completion it undoes —
  // that is its entire meaning, at any distance — so the pair nets to nothing
  // and neither line is emitted (a revert alone would show a walk-back with
  // no visible claim; a completion alone would stand as a false done). Pairing
  // is per-item, nearest-prior-first, so toggle storms reduce from the inside
  // out and only the settled state survives; a revert whose completion
  // predates the log window is suppressed alone. Exits differ: a dismissal is
  // a DECISION, and reopening it on a later sleep-day is a genuinely new
  // decision — both lines stand. Only a same-sleep-day reopen is a mis-tap,
  // and that pair vanishes. Taps are bookkeeping, not behaviour; only settled
  // outcomes reach the profile — no (xN) trace, because a fumble count is
  // itself the churn narrative this collapse exists to remove.
  // Deletion churn nets out the same way, with no trace at all: a rejected
  // (delete) erases the item's whole event trail at any distance — created,
  // recaptures, exits, pushes — because deletion is hygiene, and every line
  // about a thing that no longer exists is bookkeeping. The one exception is
  // a completion that preceded the delete: the doing was real; the cleanup
  // wasn't. A capture goes with its items: created/recaptured events carry
  // their captureId, and a capture whose EVERY resulting item was deleted led
  // nowhere — the utterance is unvalidated (a mis-say, a duplicate), and raw
  // phrasing that led nowhere is exactly what conjecture feeds on. A capture
  // with any surviving item keeps its line. (This used to leave a single
  // draft_discarded line and tell the model to ignore it — a trace plus an
  // instruction, the exact pattern that fails.)
  const cancelled = new Set<number>();
  const openCompletions = new Map<string, number[]>();
  const openExits = new Map<string, { idx: number; ms: number }[]>();
  const openSnoozes = new Map<string, { idx: number; ms: number }[]>();
  const trail = new Map<string, number[]>(); // item -> its non-completion event indices
  const rejectedItems = new Set<string>();
  const captureIdx = new Map<string, number>(); // captureId -> its captured line
  const captureItems = new Map<string, Set<string>>(); // captureId -> items it fed
  events.forEach((e, idx) => {
    const p = parse(e.payload);
    if (e.type === 'captured' && typeof p.captureId === 'string') captureIdx.set(p.captureId, idx);
    if (!e.item_id) return;
    if (e.type !== 'completed') {
      const t = trail.get(e.item_id) ?? [];
      t.push(idx);
      trail.set(e.item_id, t);
    }
    if ((e.type === 'created' || e.type === 'recaptured') && typeof p.captureId === 'string') {
      const s = captureItems.get(p.captureId) ?? new Set<string>();
      s.add(e.item_id);
      captureItems.set(p.captureId, s);
    }
    if (e.type === 'rejected') {
      rejectedItems.add(e.item_id);
    } else if (e.type === 'completed') {
      const stack = openCompletions.get(e.item_id) ?? [];
      stack.push(idx);
      openCompletions.set(e.item_id, stack);
    } else if (e.type === 'completion_reverted') {
      const prior = openCompletions.get(e.item_id)?.pop();
      if (prior !== undefined) cancelled.add(prior);
      cancelled.add(idx);
    } else if (e.type === 'dismissed' || e.type === 'missed') {
      const stack = openExits.get(e.item_id) ?? [];
      stack.push({ idx, ms: new Date(e.ts).getTime() });
      openExits.set(e.item_id, stack);
    } else if (e.type === 'reopened') {
      const prior = openExits.get(e.item_id)?.pop();
      if (prior && sleepDayOf(prior.ms, tzOffsetMinutes) === sleepDayOf(new Date(e.ts).getTime(), tzOffsetMinutes)) {
        cancelled.add(prior.idx);
        cancelled.add(idx);
      }
      // A reopen of an exit older than the log window (or on a later day)
      // stands on its own: bringing a let-go thing back is in-world signal.
    } else if (e.type === 'snoozed') {
      const stack = openSnoozes.get(e.item_id) ?? [];
      stack.push({ idx, ms: new Date(e.ts).getTime() });
      openSnoozes.set(e.item_id, stack);
    } else if (e.type === 'unsnoozed') {
      // Same mis-tap rule as dismiss→reopen: a same-sleep-day snooze and
      // un-snooze net to nothing; a later-day early wake is a real decision
      // and both lines stand.
      const prior = openSnoozes.get(e.item_id)?.pop();
      if (prior && sleepDayOf(prior.ms, tzOffsetMinutes) === sleepDayOf(new Date(e.ts).getTime(), tzOffsetMinutes)) {
        cancelled.add(prior.idx);
        cancelled.add(idx);
      }
    }
  });
  for (const id of rejectedItems) {
    for (const idx of trail.get(id) ?? []) cancelled.add(idx);
  }
  for (const [cid, itemIds] of captureItems) {
    const idx = captureIdx.get(cid);
    if (idx !== undefined && [...itemIds].every((id) => rejectedItems.has(id))) cancelled.add(idx);
  }

  const lines: string[] = [];
  const bursts = new Map<string, { idx: number; ts: number; count: number }>();
  const lastCapture = { text: '', ts: 0 };

  for (let evIdx = 0; evIdx < events.length; evIdx++) {
    const e = events[evIdx];
    if (cancelled.has(evIdx)) continue;
    const p = parse(e.payload);
    const title = (e.item_id ? titleById.get(e.item_id) : undefined) ?? (typeof p.title === 'string' ? p.title : '');
    const t = new Date(e.ts).getTime();

    if (e.type === 'captured' && typeof p.text === 'string') {
      const norm = p.text.trim().toLowerCase();
      // Identical text within ten minutes is a submission stutter — collapsed
      // silently, no counter. (The old (xN) marker needed a prompt sentence
      // excusing it, and the model profiled the marker anyway. Genuine
      // re-expression across days was never collapsed: each re-say keeps its
      // own captured line, so repetition reaches the profile as words.)
      if (norm === lastCapture.text && t - lastCapture.ts < 10 * 60_000) {
        lastCapture.ts = t;
        continue;
      }
      Object.assign(lastCapture, { text: norm, ts: t });
      lines.push(fmt(e.ts, e.actor, e.type, p.text.slice(0, 80)));
      continue;
    }

    // Recapture merges are app bookkeeping about an utterance the log already
    // carries as its own captured line. Per-item salience is the Brain's
    // channel (recaptured= on the item lines, plus the priority boost) — the
    // profile editorializing repetition markers is how "doesn't signal
    // urgency" got invented, backwards. Fetched only to link captures to
    // items for the deletion cancellation above; never emitted.
    if (e.type === 'recaptured') continue;

    if ((e.type === 'edited' || e.type === 're_themed') && e.item_id) {
      let detail = title;
      if (e.type === 'edited' && p.after && typeof p.after === 'object')
        detail = `${title} [changed: ${Object.keys(p.after as object).join(', ')}]`;
      if (e.type === 're_themed' && Array.isArray(p.before) && Array.isArray(p.after))
        detail = `${title} [${(p.before as string[]).join('/')}→${(p.after as string[]).join('/')}]`;
      const key = `${e.item_id}:${e.type}`;
      const b = bursts.get(key);
      if (b && t - b.ts < 15 * 60_000) {
        b.count += 1;
        b.ts = t;
        lines[b.idx] = `${fmt(e.ts, e.actor, e.type, detail)} (x${b.count})`;
        continue;
      }
      bursts.set(key, { idx: lines.length, ts: t, count: 1 });
      lines.push(fmt(e.ts, e.actor, e.type, detail));
      continue;
    }

    let detail = title;
    if (e.type === 'theme_merged' || e.type === 'theme_renamed')
      detail = `${String(p.from ?? '')}→${String(p.into ?? p.to ?? '')}`;
    else if (e.type === 'map_rebuilt') detail = '';
    lines.push(fmt(e.ts, e.actor, e.type, detail));
  }
  return lines;
}

// Only in-world signals reach the profile builder — the user living their
// life, not operating the app. Edits, re-themes, and the librarian's own
// restructures are filtered out at the source: a profile once described the
// AI's theme merges as the user's filing habit, and capture then filed new
// items to match — a feedback loop no prompt instruction reliably prevents.
// The lifecycle exits split by meaning: 'dismissed' (deliberately let go) and
// 'missed' (didn't make an event) are in-world signals; 'passed' (the clock
// elapsed on an event) asserts nothing about the user and stays out entirely;
// 'rejected' (delete) is app hygiene on the same tier as save — it is fetched
// ONLY so compactEventLines can cancel the deleted item's 'created' line, and
// neither half is ever emitted as a line the profile can read. 'recaptured'
// is fetched only to link captures to items for that same cancellation and
// is likewise never emitted: the re-said words reach the profile as their
// own captured lines, and per-item salience (recaptured=, the boost) is the
// Brain's channel, not the profile's.
// 'snoozed' is in-world on the same footing as 'dismissed' — a deliberate
// "not now" about a life thing, softer than letting it go; 'unsnoozed' is the
// deliberate early return, like 'reopened'. 'snooze_expired' is the clock,
// not behaviour, and stays out with 'passed'.
export const PROFILE_EVENT_TYPES = [
  'captured',
  'created',
  'recaptured',
  'completed',
  'completion_reverted',
  'dismissed',
  'missed',
  'reopened',
  'snoozed',
  'unsnoozed',
  'rejected',
  'push_sent',
  'first_step_added',
];

async function recomputeProfile(env: Env, day: string): Promise<string | null> {
  const db = env.DB;
  if (!llmAvailable(env)) return getState(db, 'profile_text');

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const events = await db
    .prepare(
      `SELECT ts, actor, type, item_id, payload FROM events
       WHERE ts >= ? AND type IN (${PROFILE_EVENT_TYPES.map(() => '?').join(',')})
       ORDER BY ts LIMIT 1500`,
    )
    .bind(since, ...PROFILE_EVENT_TYPES)
    .all<{ ts: string; actor: string; type: string; item_id: string | null; payload: string }>();
  if (!events.results.length) return getState(db, 'profile_text');

  // Titles for all items incl. deleted — surviving lines of a since-deleted
  // item (a completion that preceded the delete) still reference them.
  const itemTitles = await db
    .prepare('SELECT id, title, type FROM items')
    .all<{ id: string; title: string; type: string }>();
  const titleById = new Map(itemTitles.results.map((r) => [r.id, `${r.title} (${r.type})`]));

  const system = `You write the user-profile scratchpad for "Memory", a memory-aid app. From the 30-day event log (one line per event: "MM-DD HH:MM actor type — detail", times UTC), write a SHORT freeform-prose profile (4-8 lines) of the user's behavioural TENDENCIES, for one reader: the Brain, which builds the daily "what matters now" map.

TENDENCIES, NOT STORIES. The Brain already reads every item's own history — age, recaptures, feelings — on the item lines it receives separately; a retold item story adds nothing there and goes stale here. Your only unique value is the shape ACROSS items, which no single item shows: when in the day things actually get done; whether the user clears several lingering things in one burst or steadily one at a time; which kinds of things move promptly and which sit; what tends to precede movement on something long-stalled (a first step named, a smaller ask); which kinds of things get deliberately let go. Name no items and no people: a tendency stated through examples is detail the reader must generalize away — state the tendency itself ("admin sits for days, then clears in one burst", never which admin).

Events mean exactly what they say, and nothing more: "completed" — they did it; "dismissed" — they deliberately decided it no longer matters (a real decision); "missed" — they marked an event as not made; "reopened" — they brought a previously let-go item back; "snoozed" — they deliberately parked something to come back to later (a "not now", not an abandonment); "unsnoozed" — they brought a parked item back early. Events attended leave NO trace in this log (they close silently), so attendance and follow-through are invisible here — never describe them. Deletions never appear either; beyond an explicit dismissal, wantedness is not yours to judge. Where the log is silent, the profile is silent.

Be plain and hedged ("tends to", "often"). This profile is ADVISORY — it flavours the Brain's judgement, it never gates decisions. No JSON, just the prose.`;

  // Deterministically compressed: one line per event, churn collapsed — the
  // model never sees a checkbox fumble or a same-day mis-tapped exit.
  const lines = compactEventLines(events.results, titleById, await getTzOffset(db));

  const user = JSON.stringify({ today: day, events: lines });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.CAPTURE_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`profile recompute: Anthropic ${res.status}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = data.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim();
  if (!text) return getState(db, 'profile_text');

  // One profile row per day: forced re-runs replace, never duplicate.
  await db.prepare('DELETE FROM profiles WHERE day = ?').bind(day).run();
  await db.prepare('INSERT INTO profiles (id, day, text, created_at) VALUES (?,?,?,?)').bind(newId(), day, text, nowIso()).run();
  await setState(db, 'profile_text', text);
  return text;
}

// ---------- Librarian restructure pass (§5) ----------

async function librarianPass(env: Env): Promise<void> {
  const db = env.DB;
  const themes = await listThemes(db);
  if (themes.length < 8 || !llmAvailable(env)) return;

  const counts = await db
    .prepare(
      `SELECT t.id, t.name, COUNT(i.id) as n FROM themes t
       LEFT JOIN item_themes it ON it.theme_id = t.id
       LEFT JOIN items i ON i.id = it.item_id AND i.status = 'active'
       WHERE t.deleted_at IS NULL GROUP BY t.id`,
    )
    .all<{ id: string; name: string; n: number }>();

  // Ground the call in what's actually filed: names alone once made the
  // librarian merge two unrelated 1-item person themes it couldn't see into.
  const titleRows = await db
    .prepare(
      `SELECT it.theme_id, i.title FROM item_themes it
       JOIN items i ON i.id = it.item_id AND i.status = 'active'
       ORDER BY i.created_at DESC`,
    )
    .all<{ theme_id: string; title: string }>();
  const titlesByTheme = new Map<string, string[]>();
  for (const r of titleRows.results) {
    const list = titlesByTheme.get(r.theme_id) ?? [];
    if (list.length < 8) list.push(r.title);
    titlesByTheme.set(r.theme_id, list);
  }

  // Its own recent restructure notes, read back — context to notice churn
  // (a theme it merged away that promptly grew back earned its place).
  const noteRows = await db
    .prepare('SELECT ts, note FROM theme_notes WHERE ts >= ? ORDER BY ts DESC LIMIT 20')
    .bind(new Date(Date.now() - 14 * 86_400_000).toISOString())
    .all<{ ts: string; note: string }>();

  const system = `You are the librarian of an emergent theme taxonomy in a personal memory app. Given each theme with its active-item count and a sample of its items' titles, propose conservative restructures ONLY where the titles themselves establish it: merge two themes when their items are plainly the same subject, or rename a theme whose name misdescribes its items.

THE NORMAL ANSWER IS NO CHANGES. This runs every day and the taxonomy belongs to the user: a small or specific theme is not a problem to fix, so never merge themes just for being small, and never infer a relationship the titles don't show (two one-item themes about different people are different themes). recentRestructures lists your own recent operations — if the user re-created or re-split something you merged, leave it alone; it has earned its place.

At most 3 ops. Reply ONLY JSON: {"ops":[{"op":"merge","fromId":str,"intoId":str,"note":"one-line rationale"}|{"op":"rename","id":str,"newName":str,"note":str}]}`;

  const out = await anthropicJson<{
    ops: ({ op: 'merge'; fromId: string; intoId: string; note: string } | { op: 'rename'; id: string; newName: string; note: string })[];
  }>(
    env,
    env.CAPTURE_MODEL,
    system,
    JSON.stringify({
      themes: counts.results.map((t) => ({ id: t.id, name: t.name, count: t.n, titles: titlesByTheme.get(t.id) ?? [] })),
      recentRestructures: noteRows.results.map((r) => `${r.ts.slice(0, 10)} ${r.note}`),
    }),
  );

  for (const op of (out.ops ?? []).slice(0, 3)) {
    if (op.op === 'merge') {
      const from = counts.results.find((t) => t.id === op.fromId);
      const into = counts.results.find((t) => t.id === op.intoId);
      if (!from || !into || from.id === into.id) continue;
      // No-dangling invariant (§5): re-home items before removing the theme.
      await db
        .prepare('INSERT OR IGNORE INTO item_themes (item_id, theme_id, assigned_by) SELECT item_id, ?, assigned_by FROM item_themes WHERE theme_id = ?')
        .bind(into.id, from.id)
        .run();
      await db.prepare('DELETE FROM item_themes WHERE theme_id = ?').bind(from.id).run();
      await db.prepare('UPDATE themes SET deleted_at = ? WHERE id = ?').bind(nowIso(), from.id).run();
      await db.prepare('INSERT INTO theme_notes (id, ts, note) VALUES (?,?,?)').bind(newId(), nowIso(), op.note || `Merged ${from.name} into ${into.name}`).run();
      await logEvent(db, 'ai', 'theme_merged', { payload: { from: from.name, into: into.name, note: op.note } });
    } else if (op.op === 'rename') {
      const t = counts.results.find((x) => x.id === op.id);
      if (!t || !op.newName?.trim()) continue;
      await db.prepare('UPDATE themes SET name = ? WHERE id = ?').bind(op.newName.trim(), t.id).run();
      await db.prepare('INSERT INTO theme_notes (id, ts, note) VALUES (?,?,?)').bind(newId(), nowIso(), op.note || `Renamed ${t.name} to ${op.newName}`).run();
      await logEvent(db, 'ai', 'theme_renamed', { payload: { from: t.name, to: op.newName, note: op.note } });
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
