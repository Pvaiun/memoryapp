import type { Bubble, CaptureResponse, ItemView, MapPayload, ParseResult } from '../shared/types';
import { describeCadence, neglectedByDays } from '../shared/cadence';
import { resolveSentence, stripSentence } from '../shared/cards';
import type { Env } from './env';
import { anthropicJson, llmAvailable } from './ai';
import { heuristicParse } from '../shared/heuristicParse';
import { refineWithSourceTime, resolveDatePhrase } from '../shared/dates';
import { llmParse } from './capture';
import { embed } from './embeddings';
import {
  getItem,
  getState,
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

  const items = await listItems(db, { statuses: ['active', 'completed'] });
  const views: Record<string, ItemView> = {};
  for (const item of items) views[item.id] = toItemView(item, now);

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
export async function rebuildMap(env: Env, day: string, force = false): Promise<MapPayload> {
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

  const items = (await listItems(db, { statuses: ['active'] })).map((i) => toItemView(i, now));

  // Yesterday's bubbles — supplied separately, framed as "reuse only if apt" (§8.2).
  const prevDay = await db
    .prepare('SELECT day FROM bubbles WHERE day < ? ORDER BY day DESC LIMIT 1')
    .bind(day)
    .first<{ day: string }>();
  let previous: { name: string; itemTitles: string[] }[] = [];
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

  // Recent situation-name vocabulary (§9.2 naming): linguistic stability.
  const nameRows = await db
    .prepare('SELECT DISTINCT name FROM bubbles ORDER BY created_at DESC LIMIT 40')
    .all<{ name: string }>();
  const nameVocabulary = nameRows.results.map((r) => r.name);

  let proposed: ProposedBubble[];
  if (llmAvailable(env) && items.length) {
    try {
      proposed = await llmBuildBubbles(env, day, items, previous, nameVocabulary, profileText);
    } catch (err) {
      console.error('Brain call failed; using deterministic fallback map', err);
      proposed = fallbackBubbles(items, now);
    }
  } else {
    proposed = fallbackBubbles(items, now);
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
  const tz = parseInt((await getState(db, 'tz_offset_minutes')) ?? '0', 10) || 0;
  const missed = items.filter((i) => !surfacedIds.has(i.id) && isTodayRelevant(i, now, tz));
  if (missed.length) {
    const bubbleId = newId();
    const sentence = composeSentence(missed, now).slice(0, 600);
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
    await db.prepare('UPDATE items SET last_surfaced_at = ? WHERE id = ?').bind(ts, id).run();
  }

  await setState(db, 'map_day', day);
  await setState(db, 'map_built_at', ts);
  // One consolidated event per rebuild (the bubbles table holds the details).
  await logEvent(db, 'system', 'map_rebuilt', { payload: { day, bubbles: builtBubbles } });

  return getMap(env, day);
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
  const tz = parseInt((await getState(db, 'tz_offset_minutes')) ?? '0', 10) || 0;
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
  await db.prepare('UPDATE items SET last_surfaced_at = ? WHERE id = ?').bind(ts, itemId).run();
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
    created: created ? [toItemView(created, now)] : [],
    boosted: [],
    nudge: parsed.confidence === 'low' ? 'low-confidence' : null,
  };
  return { map: await getMap(env, bubble.day), capture };
}

// Reliable floor (§7 reliable-vs-advisory split): an item due today, overdue,
// or happening today must reach the map no matter what the Brain decides.
// Pure so it's unit-testable; tzOffsetMinutes defines the user's "today".
export function isTodayRelevant(
  i: { status: string; deadline: string | null; eventAt: string | null; eventEnd: string | null },
  now: Date,
  tzOffsetMinutes: number,
): boolean {
  if (i.status !== 'active') return false;
  const DAY = 86_400_000;
  const localNow = now.getTime() + tzOffsetMinutes * 60_000;
  const dayStartUtc = Math.floor(localNow / DAY) * DAY - tzOffsetMinutes * 60_000;
  const dayEndUtc = dayStartUtc + DAY;
  if (i.deadline && new Date(i.deadline).getTime() < dayEndUtc) return true; // due today or overdue
  if (i.eventAt) {
    const at = new Date(i.eventAt).getTime();
    const end = i.eventEnd ? new Date(i.eventEnd).getTime() : at;
    if (at < dayEndUtc && end >= dayStartUtc) return true; // spans some part of today
  }
  return false;
}

// The item exactly as the Brain's prompt receives it — one compact line,
// shared between the live call and the debug snapshot so the snapshot never
// lies. Absence = default (no dates, no recurrence, not slipping, must-do,
// medium effort, never recaptured); only deviations are written, so the token
// cost is signal, not structure.
export function brainItemLine(i: ItemView, now: Date): string {
  const relDays = (iso: string): string => {
    const d = Math.round((new Date(iso).getTime() - now.getTime()) / 86_400_000);
    return d < 0 ? `${-d}d-overdue` : d === 0 ? 'today' : `+${d}d`;
  };
  const parts: string[] = [];
  if (i.deadline) parts.push(`due=${relDays(i.deadline)}(${i.deadlineHardness ?? 'hard'})`);
  if (i.eventAt) {
    parts.push(`happens=${relDays(i.eventAt)}${i.eventEnd ? `..${relDays(i.eventEnd)}` : ''}`);
  }
  if (i.cadence) parts.push(`every="${describeCadence(i.cadence)}"`);
  if (i.neglected && i.cadence)
    parts.push(`slipping=${neglectedByDays(i.cadence, i.lastCompletedAt, i.createdAt, now)}d`);
  // Days since first capture — without it, a task that's been sitting three
  // weeks reads identically to one from yesterday, and "piling up" is invisible.
  const ageDays = Math.floor((now.getTime() - new Date(i.createdAt).getTime()) / 86_400_000);
  if (ageDays >= 1) parts.push(`age=${ageDays}d`);
  parts.push(`prio=${Math.round(i.effectivePriority * 100) / 100}`);
  if (i.optionality === 'nice') parts.push('optional');
  if (i.effort !== 'medium') parts.push(i.effort === 'large' ? 'big-effort' : 'quick');
  if (i.lastSurfacedAt) {
    const d = Math.round((now.getTime() - new Date(i.lastSurfacedAt).getTime()) / 86_400_000);
    parts.push(`seen=${d === 0 ? 'today' : `${d}d-ago`}`);
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
      const d = Math.round((now.getTime() - new Date(i.boostUpdatedAt).getTime()) / 86_400_000);
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
export function aliasItems(items: ItemView[], now: Date): { lines: string[]; idByAlias: Map<string, string> } {
  const idByAlias = new Map<string, string>();
  const lines = items.map((i, idx) => {
    const alias = `i${idx + 1}`;
    idByAlias.set(alias, i.id);
    return `${alias} ${brainItemLine(i, now)}`;
  });
  return { lines, idByAlias };
}

// Debug snapshot for workshopping the Brain (§9.2 tuning loop): the exact
// input the Brain would see right now, paired with the current map output.
// Compact by construction — no raw log, no embeddings, no captures.
export async function brainSnapshot(env: Env, day: string): Promise<unknown> {
  const db = env.DB;
  const now = new Date();
  const items = (await listItems(db, { statuses: ['active'] })).map((i) => toItemView(i, now));

  const nameRows = await db
    .prepare('SELECT DISTINCT name FROM bubbles ORDER BY created_at DESC LIMIT 40')
    .all<{ name: string }>();

  const prevDay = await db
    .prepare('SELECT day FROM bubbles WHERE day < ? ORDER BY day DESC LIMIT 1')
    .bind(day)
    .first<{ day: string }>();
  let previouslyShown: { name: string; itemTitles: string[] }[] = [];
  if (prevDay) {
    const rows = await db
      .prepare(
        `SELECT b.name, i.title FROM bubbles b
         JOIN bubble_items bi ON bi.bubble_id = b.id
         JOIN items i ON i.id = bi.item_id WHERE b.day = ?`,
      )
      .bind(prevDay.day)
      .all<{ name: string; title: string }>();
    const byName = new Map<string, string[]>();
    for (const r of rows.results) byName.set(r.name, [...(byName.get(r.name) ?? []), r.title]);
    previouslyShown = [...byName.entries()].map(([name, itemTitles]) => ({ name, itemTitles }));
  }

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
    builtAt: await getState(db, 'map_built_at'),
    input: {
      items: aliasItems(items, now).lines,
      userProfile: await getState(db, 'profile_text'),
      recentNameVocabulary: nameRows.results.map((r) => r.name),
      previouslyShown_reuseOnlyIfStillApt: previouslyShown,
    },
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

async function llmBuildBubbles(
  env: Env,
  day: string,
  items: ItemView[],
  previous: { name: string; itemTitles: string[] }[],
  nameVocabulary: string[],
  profileText: string | null,
): Promise<ProposedBubble[]> {
  const now = new Date();

  const system = `You are the Brain of "Memory", a memory-aid app for a user with ADHD. Each morning you build the day's bubble map — the curated "what matters right now" view — fresh from the user's items. Reply with ONLY a JSON object.

ORGANIZING PRINCIPLE: a bubble is a reason to act as one unit — build from what today's items actually offer, never from a template. Reasons that recur: an approaching event that just needs seeing; dated must-dos; a handful of small DOs that could fall in one burst because they share a context ("while the kettle boils", "one errand loop"), whatever their topics; one big amorphous thing plus its break-it-down invitation; a couple of facts worth keeping warm. Most days only some of these exist, and some days the right card fits none of these shapes — if a grouping has a clear reason to act as one unit, compose it. Never force a kind onto a day that doesn't contain it, and never pad the map to have one of each. What you don't build: time-buckets ("due this week" is sorting, not acting) and theme-groupings (the browse view owns those). Yours is activation: this user starts hard and, once started, keeps going — one good bundle turns a single activation into several completions, where five separate small cards would each demand their own.

MEMBERSHIP: an item joins a bubble through one of two bonds. The EPISODE bond (situations): the item is part of the same real-world story — the event itself, its sub-events, the prep it demands, the facts needed while it's happening. Test: if the situation were cancelled, this item would vanish or stop mattering. The DOING bond (packages): the item would be completed in the same burst as the others — one sitting, one tool, one trip. Shared topic, shared people, or a shared date are none of these: they're resemblance, not connection. The tell that a member doesn't belong: the sentence needs a link the items don't themselves establish to make it fit. Items may appear in more than one bubble only when genuinely central to both; prefer one home.

PROMINENCE (0.05–1.0) is the scarce resource, not inclusion. There is no cap on bubbles; the map scrolls. Anything important gets a slot even if small. Blend four factors, qualitatively: urgency (deadline proximity — but dampened for optional items), importance (the given priority value), effort/lead-time (big tasks need runway: "repaint the fence" outranks "feed the goldfish" at equal due date), and forgettability (easily-slipped things surface harder). Don't let a flat due-date sort bury a big important thing. A hard deadline today/overdue → prominence near 1.0. A conference four weeks out → a small persistent dot (~0.1–0.2). A package's prominence comes from the pile, not the pieces: several small things aging together can outrank any one of them. Deadline proximity raises the prominence of whatever bubble an item is in; it never decides membership — two things due the same day are not thereby related (though they may still share a package if they'd be done in the same sitting).

ITEM FORMAT: each item is one line — <id> <TYPE> "title" [themes] signals. Signals appear ONLY when they deviate from the default; absence means: no deadline, no event, no recurrence, not slipping, must-do, medium effort, never recaptured. due/happens use relative days (+3d, today, 2d-overdue), deadline hardness in parens; every= is the recurrence rhythm; slipping=Nd means a rhythm has gone unmet; age=Nd is days since it was first captured (absent = captured today); prio is 0-1; "optional" = nice-to-do; "quick"/"big-effort" = effort; seen= is when it last appeared on the map, "new" = never shown; recaptured=N(Xd-ago) means the user re-entered it N times, most recently X days ago (behavioural salience); felt= is the emotional colour the user's own phrasing carried at capture (xN = said across captures) — write like someone who heard them say it.

NON-NEGOTIABLE — TODAY'S DATED ITEMS: every item marked due=today, due=...overdue, or happens=today MUST appear in some bubble. Low priority, optionality, a soft deadline, or profile impressions make a same-day item's bubble SMALLER (≥0.3), never absent; must-do or hard-deadline same-day items sit ≥0.5. Missing a same-day item is this app's cardinal failure.

The user profile is advisory colour for naming, grouping, and emphasis ONLY. It must never veto: never exclude or demote a dated item because the profile suggests the user might not care about that kind of thing.

KNOWs: event-linked KNOWs (their trigger is another item in the app) go INTO that situation's bubble alongside its DOs. Life-triggered KNOWs (trigger the app can't sense) get rehearsal rotation: include ONE small bubble (kind "rotation", prominence ≤ 0.15, name like "Keep in mind") with 2-4 KNOWs, favouring important and not-recently-surfaced ones. Quiet — under-rotate rather than over-rotate; omitting the rotation bubble entirely is often the right call. Distinguish two kinds of KNOW: REFERENCE facts (where objects are stored, measurements, how-tos — useful exactly when searched for) almost never rotate — only if recently recaptured, and never just to fill the bubble. KEEP-WARM facts (people-facts, commitments, insights the user needs near top of mind) are what rotation is for.

NAMING: reuse a name from the vocabulary when semantically apt (never coin a synonym for the same recurring situation — that causes needless reshuffle); coin a new name when the situation genuinely differs. Names are short, concrete, plainly human. Preparation framing ("Before X", "Getting ready for X") is EARNED: use it only when the bubble actually contains prep tasks to do before the event. A bubble that is just an upcoming event (plus related facts) is simply named as the event ("The Lisbon trip", not "Before the Lisbon trip").

PREVIOUSLY SHOWN (yesterday) is provided ONLY as optional reference — reuse a grouping only if it is still apt today. Compose fresh from the items; do NOT treat yesterday's map as a default to preserve.

Do not force every item into the map — the browse view holds everything; you curate. Every bubble needs at least one item.

OUTPUT: {"bubbles":[{"name":str,"kind":"situation"|"rotation","prominence":num,"sentence":str,"firstStep":str|null,"itemIds":[short ids like "i3" from the item lines]}]}

"sentence" IS the card — on the day view the user reads nothing else (names appear only in browse, search, and the gauge ledger). Write one continuous utterance saying why this bubble matters TODAY: a short sentence for a quiet bubble, up to three or four woven sentences for the loudest, fullest ones — there is room on the card, and warm, momentum-building language beats terseness. Present tense, tokens front-loaded, no filler, never the bubble name, never meta-commentary ("this bubble groups…" is forbidden). When one thing should genuinely come first, say so plainly in the prose.

THE CARD GRAMMAR (only these two marks):
- **bold** the recognizable nouns — people, entities, dates ("**Uncle Tomas** lands **Friday**, through the **9th**"). At distance the card crops to its bold tokens alone, so they must scan as a fragment.
- [phrase](iN) makes that phrase a tappable checkbox chip completing DO item iN in place ("the [oil change](iN) before the trip"). At most 2-3 chips per card; the phrase must read naturally inside the sentence.

CONSTRUCTION follows the cluster's shape:
- Mixed cluster, few actionables → weave facts and 1-3 chips into one utterance.
- 4+ near-identical siblings → speak of the batch collectively ("Five **holiday cards**, one sitting — Nan, Theo, June, the Walshes."). A progress pip-row renders automatically; never chip or enumerate the items as a list. Get any count you state from the member list, not from momentum.
- One big or long-stalled thing with no date → a bare sentence, no chips, plus "firstStep": a short, encouraging invitation in your own voice, shaped by what would unstick THIS thing. Ask for a breakdown when it's big and formless; ask for a when, when the user plainly wants it and just never starts; ask for the tiny first move when it's obvious. Shapes from other lives: a looming attic clear-out — "Which corner would you start with?"; a guitar gathering dust — "Want to pick a night this week?". The user's typed answer becomes a real item on the card (dates and times in it are understood, so "Thursday evening" works). NEVER write the step's content yourself. firstStep is null in every other case.
- Rotation bubbles read as an offering, not an obligation ("Worth a glance: the **spare key** lives with **Marta downstairs**"), no chips.`;

  const { lines, idByAlias } = aliasItems(items, now);
  const user = JSON.stringify({
    today: day,
    weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(`${day}T12:00:00Z`).getUTCDay()],
    items: lines,
    userProfile: profileText,
    recentNameVocabulary: nameVocabulary,
    previouslyShown_reuseOnlyIfStillApt: previous,
  });

  const out = await anthropicJson<{ bubbles: ProposedBubble[] }>(env, env.BRAIN_MODEL, system, user, 8192);
  return (out.bubbles ?? [])
    .filter((b) => b && b.name && Array.isArray(b.itemIds))
    .map((b) => {
      // Aliases back to real ids; unknown aliases drop (validated again upstream).
      const itemIds = b.itemIds.map((a) => idByAlias.get(String(a).trim()) ?? '').filter(Boolean);
      // Chip refs in the sentence resolve the same way; strays degrade to bold.
      const sentence = resolveSentence(String(b.sentence ?? b.reason ?? ''), idByAlias, new Set(itemIds));
      const firstStep = typeof b.firstStep === 'string' && b.firstStep.trim() ? b.firstStep.trim() : null;
      return {
        name: String(b.name),
        kind: b.kind === 'rotation' ? 'rotation' as const : 'situation' as const,
        prominence: typeof b.prominence === 'number' ? b.prominence : 0.4,
        reason: stripSentence(sentence),
        sentence,
        firstStep,
        itemIds,
      };
    });
}

// ---------- Deterministic fallback map (no LLM configured) ----------

function shortDate(iso: string, now: Date): string {
  const days = Math.round((new Date(iso).getTime() - now.getTime()) / 86_400_000);
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return new Date(iso).toLocaleDateString('en', { weekday: 'short' });
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

// Card-grammar sentence without an LLM: active DOs become chips (max 3),
// everything else bold titles, dates bold — mechanical but in register.
function composeSentence(items: ItemView[], now: Date, lead = ''): string {
  let chips = 0;
  const parts = items.slice(0, 3).map((i) => {
    const when = i.deadline ?? i.eventAt;
    const date = when ? ` **${shortDate(when, now)}**` : '';
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

function fallbackBubbles(items: ItemView[], now: Date): ProposedBubble[] {
  const bubbles: ProposedBubble[] = [];
  const dueSoon = items.filter(
    (i) => i.type === 'DO' && i.deadline && new Date(i.deadline).getTime() - now.getTime() < 7 * 86_400_000,
  );
  if (dueSoon.length) {
    const soonest = Math.min(...dueSoon.map((i) => new Date(i.deadline!).getTime() - now.getTime()));
    bubbles.push(
      proposed('Due soon', 'situation', soonest < 86_400_000 ? 0.95 : 0.7, composeSentence(dueSoon, now), dueSoon),
    );
  }
  const neglected = items.filter((i) => i.neglected && !dueSoon.includes(i));
  if (neglected.length) {
    bubbles.push(
      proposed(
        'Rhythms to pick back up',
        'situation',
        0.5,
        composeSentence(neglected, now, 'The rhythm slipped — '),
        neglected,
      ),
    );
  }
  const upcoming = items.filter(
    (i) => i.type === 'HAPPEN' && i.eventAt && new Date(i.eventAt).getTime() > now.getTime() - 86_400_000 &&
      new Date(i.eventAt).getTime() - now.getTime() < 14 * 86_400_000,
  );
  if (upcoming.length) {
    bubbles.push(proposed('Coming up', 'situation', 0.55, composeSentence(upcoming, now), upcoming));
  }
  const important = items.filter(
    (i) => i.effectivePriority >= 0.65 && !dueSoon.includes(i) && !neglected.includes(i) && !upcoming.includes(i) && i.type !== 'KNOW',
  );
  if (important.length) {
    bubbles.push(proposed('Important', 'situation', 0.45, composeSentence(important, now), important));
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
// 'created'/'rejected' stay: they feed the draft-churn collapse, and a
// slow-burn rejection (deciding against a thing) is an in-world signal.
export const PROFILE_EVENT_TYPES = [
  'captured',
  'created',
  'recaptured',
  'completed',
  'completion_reverted',
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

DO NOT profile app-administration mechanics: how they file, phrase, edit, or reorganize is out of scope — no reader of this profile acts on it, and describing it crowds out the life patterns that matter. Lines marked draft_discarded or (xN) are pre-collapsed churn from operating the app — never a pattern worth a line. NEVER conclude that a kind of item is a draft, unwanted, or likely to be rejected — wantedness is not yours to judge, and the Brain is forbidden from acting on such claims.

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
