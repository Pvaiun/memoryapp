import type { Bubble, Cadence, CaptureResponse, ItemView, MapPayload, ParseResult } from '../shared/types';
import { describeAtTime, describeCadence, neglectedByDays } from '../shared/cadence';
import { resolveSentence, stripSentence } from '../shared/cards';
import type { Env } from './env';
import { anthropicJson, llmAvailable } from './ai';
import { heuristicParse } from '../shared/heuristicParse';
import { refineWithSourceTime, resolveDatePhrase, sleepDayDiff, sleepDayKey } from '../shared/dates';
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
import { sweepPassedEvents } from './items';
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
  for (const item of items) views[item.id] = toItemView(item, now, tz);

  const bubbles: Bubble[] = bubbleRows.results.map((b) => ({
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
  }));

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

  const tz = await getTzOffset(db);
  // One-shot events whose moment fell in a previous sleep-day close as
  // 'passed' here — the daily crystallization of the map's derived greying.
  try {
    await sweepPassedEvents(db, now, tz);
  } catch (err) {
    console.error('passed-event sweep failed', err);
  }
  const items = (await listItems(db, { statuses: ['active'] })).map((i) => toItemView(i, now, tz));

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

  const input = brainInput(day, items, previous, nameVocabulary, profileText, now, tz);
  // The staged pipeline records its own richer payload (skeleton → plan →
  // prose); the legacy single call records its one input. Whichever ran is
  // what the snapshot must show.
  let snapshotPayload: Record<string, unknown> = input.payload;
  let proposed: ProposedBubble[];
  let mode: 'llm' | 'fallback' = 'fallback';
  if (llmAvailable(env) && items.length) {
    try {
      if (useStaged) {
        const staged = await stagedBuildBubbles(env, items, day, nameVocabulary, profileText, now, tz, prompt.addendum);
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
    const clock = atClock(i.eventAt);
    parts.push(
      `happens=${relDays(i.eventAt)}${clock ? `(${clock})` : ''}${i.eventEnd ? `..${relDays(i.eventEnd)}` : ''}`,
    );
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
const ITEM_FORMAT = `ITEM FORMAT: each item is one line — <id> <TYPE> "title" [themes] signals. Signals appear ONLY when they deviate from the default; absence means: no deadline, no event, no recurrence, not slipping, must-do, medium effort, never recaptured. due/happens/next use relative days (+3d, today, 2d-overdue), with a clock time in parens only when the user named one — due=+2d(3pm, hard) has a time, due=+2d(hard) and happens=+2d name the day with no time attached; deadline hardness in parens; every= is the recurrence rhythm; next= is when that rhythm comes round again, or how long its last turn has gone unmet; slipping=Nd means a rhythm has gone unmet; age=Nd is days since it was first captured (absent = captured today); prio is 0-1; "optional" = nice-to-do; "quick"/"big-effort" = effort; seen= is when it last appeared on the map, "new" = never shown; shown=Nx is how many maps it has appeared on (absent = at most one) — read against completions it distinguishes "asked once" from "asked every morning and still not done", which is a reason to change the ASK (a different bubble, a plainer framing, a break-it-down invitation) and never on its own a reason to drop or quieten the item; recaptured=N(Xd-ago) means the user re-entered it N times, most recently X days ago (behavioural salience); felt= is the emotional colour the user's own phrasing carried at capture (xN = said across captures).`;

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
const BUBBLE_BONDS = ['episode', 'package', 'solo', 'rehearsal'] as const;
type BubbleBond = (typeof BUBBLE_BONDS)[number];

export interface CurationAdd {
  id: string; // alias, e.g. "i7"
  rationale: string;
  tags: string[];
  tier: BrainTier;
}

export interface CurationBubble {
  members: string[]; // aliases
  bond: BubbleBond;
  tier: BrainTier;
  rationale: string;
  firstStep: FirstStepKind | null;
}

export interface CurationPlan {
  adds: CurationAdd[];
  bubbles: CurationBubble[];
}

// Runaway backstop, deliberately far above the prompt's guidance. The real
// contract on adds is the declaration requirement — every non-mandatory item
// on the map carries a stated rationale — and the budget the prompt teaches
// is card slots (map shape), not item count: a ride-along absorbed into an
// existing bubble is nearly free, so a good bundling day may legitimately
// add more items than a scattered one.
export const MAX_CURATION_ADDS = 8;

const CURATION_SYSTEM = `You are the curator of "Memory", a memory-aid app for a user with ADHD. Each morning, deterministic code places the day's REQUIRED items — the mandatory list, each entry naming the rule that fired (due-today, overdue, event-today, rhythm-today, runway for big-effort things) and the floor tier code will enforce. You do the two things rules cannot: decide what ELSE earns a place on today's map, and compose everything — required and added — into bubbles: small groups that act as one unit. Reply with ONLY a JSON object.

${ITEM_FORMAT}

ADDS — the discretionary picks from the items NOT on the mandatory list. Budget by map shape (see BUBBLES), not by item count: an add that rides along inside a bubble the day already has costs almost nothing, and an add that opens its own bubble spends one of the day's few card slots. Most days 1-3 adds is right; a bigger spend is right exactly when the adds bundle — one errand loop absorbing three lingering errands is a better day than three new cards. Airtime is the fairness axis: prefer what has NOT had recent airtime (new, or seen= long ago) over what has (seen=today, shown= many). The accounting block names the starved backlog outright — the never-shown item ids and how long the oldest has waited; a nonempty backlog is a standing reason to spend there. Each add carries a rationale in your own words — why this item, why today; the card writer reads it — and it must be a real reason: "small enough to keep around" or "seen recently" is not one, and an add whose rationale doesn't survive "why this, today, instead of nothing?" should not be made. Tags: "starved" (never or barely shown), "stalled" (shown many mornings, still unacted — needs a different ask, maybe a firstStep), "rides-along" (would be done in the same burst, trip, or sitting as a required item), "runway-pull" (big-effort item outside its lead window that needs starting anyway), "keep-warm" (a KNOW worth rehearsing — important or recaptured, and not recently seen; where-things-are reference facts almost never qualify), "momentum" (fits a burst rhythm the profile shows), "other" (none fit — the rationale says why). Each add also names a tier — the loudness it deserves if it ends up standing alone; when it joins a shared bubble, the bubble's own tier governs. When the mandatory set is light, spend more freely — a quiet day is exactly the day for a lingering goal, an old someday item, or a fact worth keeping warm. When it is heavy, hold back; "adds": [] is a fine answer. Inclusion needs a reason. "Due soon" alone is never one — code decides when dated items enter the map.

BUBBLES — compose the day. Every mandatory item MUST appear in at least one bubble. Every add goes in whatever bubble its rationale implies — its own is fine. Bundling is half your job: the mandatory list arrives flat, and composing it — required items with each other, adds woven in wherever a real bond holds — is what turns a list into a map. A good day is usually 4-8 bubbles; ten single-item bubbles is a list wearing bubbles, though never force a bond to hit a count. A non-mandatory item may appear as a member ONLY if it is declared in adds; undeclared members are dropped. Members join through a real bond: "episode" (same real-world story — an event, its sub-events, the prep it demands, the facts needed while it happens), "package" (same burst — one sitting, one tool, one trip, one errand loop), "solo" (stands alone), "rehearsal" (facts kept warm — an offering, not an obligation). Shared topic, shared people, or a shared date alone is resemblance, not a bond — the tell that a member doesn't belong: the sentence would need a link the items don't themselves establish. A package must survive the one-burst test: same place, same tool, same sitting — two phone calls are one burst; a phone call and a store trip are not. Reliably-completed-around-the-same-hour is a statistic, not a bond: an interpersonal ritual is not a household chore, however adjacent their evenings. Never bundle an event happening today with events on later days (two events sharing the same future day — both tomorrow, say — may share a card). And never bend a bond to save a card slot: a weak add belongs nowhere rather than in the wrong bubble. Each bubble carries a rationale (why this grouping exists today, in your own words), a tier, and firstStep.

TIER: "loud" | "mid" | "quiet" | "dot" — how much of today's attention the bubble deserves; order the array loudest first (within a tier, your order is the ranking). Never place a bubble below any member's floor. Two corrections to the obvious reading of the signals: an item that has sat unacted (age=, shown=, recaptured=) matters MORE for it, not less — old is how forgotten looks; and a package's tier comes from the pile, not the pieces — several small things aging together can outrank any one of them.

firstStep: at most ONE bubble in the whole map, and only when one big or stalled thing needs a way in rather than volume: "breakdown" (no visible first action), "name-a-when" (they plainly want it and never start), "tiny-first-move" (the first move is obvious and small). A writer phrases the invitation; you only flag it. Everywhere else: null.

The user profile is advisory colour — it may shape which adds fit the day and how things group; it never removes a mandatory item.

OUTPUT: {"adds":[{"id":"iN","rationale":str,"tags":[str],"tier":"loud"|"mid"|"quiet"|"dot"}],"bubbles":[{"members":["iN"],"bond":"episode"|"package"|"solo"|"rehearsal","tier":"loud"|"mid"|"quiet"|"dot","rationale":str,"firstStep":null|"breakdown"|"name-a-when"|"tiny-first-move"}]}`;

const RENDER_SYSTEM = `You are the writer of "Memory", a memory-aid app for a user with ADHD. A curator has composed today's map; each card arrives with its members (full item lines), its bond, its tier, its register, and the curator's rationale (why) — the reason the card exists today. You write everything the user reads: each card's name and sentence. Reply with ONLY a JSON object.

${ITEM_FORMAT}

"sentence" IS the card — on the day view the user reads nothing else, and the card's NAME is NOT displayed there (names live in browse and search only). Every sentence must stand completely alone: never lean on the name for framing, never assume the user sees it. One continuous utterance carrying the facts — what, when, who: short for a quiet card, up to two or three woven sentences for the loudest, fullest one, earned by content, never padding.

THE FACTS, PRECISELY:
- Chronological: mention members in the order they happen today.
- Every timed member gets its time — never a time for one and not another on the same card.
- Days are named, not gestured at: "tomorrow (Friday) at 6pm", "next Wednesday at 7pm" — never "lands tomorrow", never "soon", never "the following Wednesday".
- The card's size already conveys importance — never state how much something matters, its role in the day, or what it anchors or centres. Never state the number of items in a batch — the card renders the true count itself. When one thing should genuinely come first, say so plainly.

TONE IS DATA, NOT DECORATION. The curator's rationale and the behavioural signals on the lines are the card's reason to exist — carry them as plain facts about the user's own history, never as mechanics: felt=for-someone → say who it's for; felt=important + recaptured= → they keep coming back to this, say so; long age + shown= many → it keeps slipping, say so kindly, without scolding; a hard due or overdue rule → say the stakes. A date alone earns no colour: something merely happening today needs nothing beyond when. FORBIDDEN: decorative filler and empty poetry — "the book sits close by, still meaning something whenever it's opened" is the named failure mode; every clause carries a fact or a signal, or it gets cut. Present tense, tokens front-loaded, never the card's own name inside its sentence, no meta-commentary ("this bubble groups…" is forbidden). The userProfile is advisory colour for voice and emphasis only — never content.

THE CARD GRAMMAR (only these two marks):
- **bold** the recognizable nouns — people, entities, dates, times. At distance the card crops to its marked tokens alone, so they must scan as a fragment.
- [phrase](iN) makes that phrase a tappable checkbox chip completing DO item iN in place, e.g. "the [task name](i3)". EVERY member that is an active DO MUST appear as a chip woven naturally into the prose — no exceptions, whatever the bond: a missing chip is a broken card (the app appends an orphaned chip at the end, which reads as a glitch). A phrase naming a DO is a chip, never bold. The single exception: cards whose register is "rehearsal" carry no chips — they read as an offering, never an obligation.

CONSTRUCTION follows the card's shape:
- Mixed members, few DOs → weave facts and chips into one utterance.
- 3+ same-type siblings (a batch) → speak of the batch collectively, list-like and rhythmic — each chip inline where it reads naturally — never one run-on clause chain.
- One big or stalled thing carrying a firstStep flag → a bare, honest sentence built from its history (how long it has waited, how many mornings, what the user's own signals say it means), plus the invitation.
- Register "rehearsal" → one warm line, an offering: the fact and why it is near, no ask.

"firstStep": only on the card whose input carries a firstStep flag, write a short, direct invitation in your own voice, shaped by the flag — "breakdown": ask for the first piece; "name-a-when": ask them to name a time; "tiny-first-move": ask for the smallest move. NEVER write the step's content yourself — the user's typed answer becomes a real item on the card (dates and times in it are understood, so "Thursday evening" works). Every other card: null.

NAMING: if a card covers the same ground as a name in nameVocabulary, reuse that name EXACTLY — a renamed recurring situation reads as brand-new and reshuffles the user's map. Coin a short, concrete, plainly human name only for genuinely new ground. Preparation framing ("Before X") is earned only when the card actually contains prep tasks.

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

// Curation output → validated plan, pure. Everything here is a guarantee the
// prompt merely requests: adds only from the eligible pile (a mandatory or
// unknown id is not an add), the add cap, members only from mandatory ∪
// declared adds, floors never undercut, one firstStep, every mandatory item
// covered (uncovered ones get solo bubbles carrying their rule), every
// declared add placed, loudest-first order.
export function validateCurationPlan(
  raw: { adds?: unknown; bubbles?: unknown } | null | undefined,
  floors: Map<string, { floor: BrainTier; rule: string }>,
  eligibleAliases: Set<string>,
): CurationPlan {
  const rawAdds = Array.isArray(raw?.adds) ? (raw!.adds as Record<string, unknown>[]) : [];
  const seenAdd = new Set<string>();
  const adds: CurationAdd[] = [];
  for (const a of rawAdds) {
    if (!a || typeof a !== 'object') continue;
    const id = String(a.id ?? '').trim();
    if (!eligibleAliases.has(id) || floors.has(id) || seenAdd.has(id)) continue;
    if (adds.length >= MAX_CURATION_ADDS) break;
    seenAdd.add(id);
    adds.push({
      id,
      rationale: String(a.rationale ?? '').slice(0, 300),
      tags: (Array.isArray(a.tags) ? a.tags : []).map((t) => String(t).slice(0, 40)).slice(0, 4),
      tier: isBrainTier(a.tier) ? a.tier : 'quiet',
    });
  }

  const allowed = new Set<string>([...floors.keys(), ...adds.map((a) => a.id)]);
  const rawBubbles = Array.isArray(raw?.bubbles) ? (raw!.bubbles as Record<string, unknown>[]) : [];
  const bubbles: CurationBubble[] = [];
  let firstStepTaken = false;
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
    let tier: BrainTier = isBrainTier(b.tier) ? b.tier : 'quiet';
    for (const m of members) {
      const f = floors.get(m);
      if (f) tier = maxTier(tier, f.floor);
    }
    const bond = (BUBBLE_BONDS as readonly string[]).includes(String(b.bond))
      ? (String(b.bond) as BubbleBond)
      : members.length > 1
        ? 'package'
        : 'solo';
    const wantsStep = (FIRST_STEP_KINDS as readonly string[]).includes(String(b.firstStep));
    const firstStep = wantsStep && !firstStepTaken ? (String(b.firstStep) as FirstStepKind) : null;
    if (firstStep) firstStepTaken = true;
    bubbles.push({ members, bond, tier, rationale: String(b.rationale ?? '').slice(0, 300), firstStep });
  }

  // Coverage nets, both directions: a mandatory item the plan ignored still
  // reaches the map (its rule is its rationale), and a declared add never
  // silently vanishes — the declaration was the reason, so it gets its bubble.
  const covered = new Set(bubbles.flatMap((b) => b.members));
  for (const [alias, f] of floors) {
    if (covered.has(alias)) continue;
    bubbles.push({ members: [alias], bond: 'solo', tier: f.floor, rationale: f.rule, firstStep: null });
  }
  for (const a of adds) {
    if (covered.has(a.id)) continue;
    bubbles.push({ members: [a.id], bond: 'solo', tier: a.tier, rationale: a.rationale, firstStep: null });
  }

  bubbles.sort((x, y) => compareTier(x.tier, y.tier)); // stable: within a tier, plan order is the ranking
  return { adds, bubbles };
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
  const { lines, idByAlias } = aliasItems(items, now, tz);
  const aliasById = new Map([...idByAlias].map(([alias, id]) => [id, alias]));
  // Keyed via aliasById, never by re-deriving `i${idx+1}` — one authority for
  // the alias scheme (aliasItems), so the two can't silently desync.
  const lineByAlias = new Map(items.map((it, idx) => [aliasById.get(it.id)!, lines[idx]]));
  const viewById = new Map(items.map((i) => [i.id, i]));

  const { mandatory, eligible } = placeItems(items, now, tz);
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
  const rawPlan = await anthropicJson<{ adds?: unknown; bubbles?: unknown }>(
    env,
    env.BRAIN_MODEL,
    curationSystem,
    JSON.stringify(curationInput),
    4096,
  );
  const plan = validateCurationPlan(rawPlan, floors, eligibleAliases);
  const addByAlias = new Map(plan.adds.map((a) => [a.id, a]));

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
      members: b.members.map((m) => ({
        id: m,
        line: lineByAlias.get(m) ?? m,
        required: floors.get(m)?.rule ?? null,
        added: addByAlias.get(m)?.rationale ?? null,
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

  // Draft churn: created and rejected within 30 minutes → one line, no blow-by-blow.
  const createdAt = new Map<string, number>();
  const rejectedAt = new Map<string, number>();
  for (const e of events) {
    if (!e.item_id) continue;
    if (e.type === 'created') createdAt.set(e.item_id, new Date(e.ts).getTime());
    if (e.type === 'rejected') rejectedAt.set(e.item_id, new Date(e.ts).getTime());
  }
  const draftIds = new Set<string>();
  for (const [id, c] of createdAt) {
    const r = rejectedAt.get(id);
    if (r !== undefined && r - c < 30 * 60_000) draftIds.add(id);
  }

  const lines: string[] = [];
  const bursts = new Map<string, { idx: number; ts: number; count: number }>();
  const lastCapture = { text: '', ts: 0, idx: -1, count: 1 };

  for (const e of events) {
    const p = parse(e.payload);
    const title = (e.item_id ? titleById.get(e.item_id) : undefined) ?? (typeof p.title === 'string' ? p.title : '');
    const t = new Date(e.ts).getTime();

    if (e.item_id && draftIds.has(e.item_id)) {
      if (e.type === 'created') lines.push(fmt(e.ts, 'user', 'draft_discarded', title));
      continue;
    }

    // Deletion is app hygiene (a mis-parse, a duplicate) — the same tier as
    // save, no meaning of its own. It was fetched only to fuel the draft
    // collapse above; the deliberate "let it go" signal is 'dismissed'.
    if (e.type === 'rejected') continue;

    if (e.type === 'captured' && typeof p.text === 'string') {
      const norm = p.text.trim().toLowerCase();
      if (norm === lastCapture.text && t - lastCapture.ts < 10 * 60_000 && lastCapture.idx >= 0) {
        lastCapture.count += 1;
        lastCapture.ts = t;
        lines[lastCapture.idx] = lines[lastCapture.idx].replace(/( \(x\d+\))?$/, ` (x${lastCapture.count})`);
        continue;
      }
      Object.assign(lastCapture, { text: norm, ts: t, idx: lines.length, count: 1 });
      lines.push(fmt(e.ts, e.actor, e.type, p.text.slice(0, 80)));
      continue;
    }

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
    if (e.type === 'recaptured' && typeof p.appendedText === 'string')
      detail = `${title} +"${(p.appendedText as string).slice(0, 60)}"`;
    else if (e.type === 'theme_merged' || e.type === 'theme_renamed')
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
// ONLY to fuel the draft-churn collapse in compactEventLines and is never
// emitted as a line the profile can read.
export const PROFILE_EVENT_TYPES = [
  'captured',
  'created',
  'recaptured',
  'completed',
  'completion_reverted',
  'dismissed',
  'missed',
  'reopened',
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

  // Titles for all items incl. deleted — draft churn references them.
  const itemTitles = await db
    .prepare('SELECT id, title, type FROM items')
    .all<{ id: string; title: string; type: string }>();
  const titleById = new Map(itemTitles.results.map((r) => [r.id, `${r.title} (${r.type})`]));

  const system = `You write the user-profile scratchpad for "Memory", a memory-aid app. From the 30-day event log (one line per event: "MM-DD HH:MM actor type — detail", times UTC), write a SHORT freeform-prose profile (5-12 lines) about the USER'S LIFE PATTERNS, for one reader: the Brain, which builds the daily "what matters now" map.

Describe the user IN THE WORLD, never the user operating the app: when they check in and get things done; which kinds of items get completed promptly and which linger untouched or keep slipping; what they're chronically late on; what activity spikes before real-world events; which pushes get acted on; what they keep coming back to (recaptures).

The lifecycle exits mean exactly what they say: "completed" — they did it; "dismissed" — they deliberately decided it no longer matters (a real decision worth noticing, e.g. what kinds of plans get let go); "missed" — they didn't make it to an event (patterns of misses — time of day, kind of event — matter a lot). "reopened" reverts a mis-tapped exit. Deletions never appear in this log; beyond an explicit dismissal, wantedness is not yours to judge.

DO NOT profile app-administration mechanics: how they file, phrase, edit, or reorganize is out of scope — no reader of this profile acts on it, and describing it crowds out the life patterns that matter. Lines marked draft_discarded or (xN) are pre-collapsed churn from operating the app — never a pattern worth a line.

Be concrete and hedged ("tends to", "often"). This profile is ADVISORY — it flavours the Brain's judgement, it never gates decisions. No JSON, just the prose.`;

  // Deterministically compressed: one line per event, churn collapsed.
  const lines = compactEventLines(events.results, titleById);

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
