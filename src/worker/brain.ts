import type { Bubble, ItemView, MapPayload } from '../shared/types';
import { describeCadence, neglectedByDays } from '../shared/cadence';
import type { Env } from './env';
import { anthropicJson, llmAvailable } from './ai';
import {
  getState,
  listItems,
  listThemes,
  logEvent,
  newId,
  nowIso,
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
    .all<{ id: string; day: string; name: string; kind: string; prominence: number; reason: string }>();
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
    await db
      .prepare('INSERT INTO bubbles (id, day, name, kind, prominence, reason, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(bubbleId, day, b.name.slice(0, 80), b.kind, clamp(b.prominence, 0.05, 1), b.reason.slice(0, 300), nowIso())
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
    await db
      .prepare('INSERT INTO bubbles (id, day, name, kind, prominence, reason, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(bubbleId, day, 'Also today', 'situation', 0.8, summarizeItems(missed, now).slice(0, 300), nowIso())
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

// The item view exactly as the Brain's prompt receives it — shared between the
// live call and the debug snapshot so the snapshot never lies.
function brainItemPayload(i: ItemView, now: Date) {
  return {
    id: i.id,
    type: i.type,
    title: i.title,
    flavour: i.flavour,
    priority: Math.round(i.effectivePriority * 100) / 100,
    deadline: i.deadline,
    deadlineHardness: i.deadlineHardness,
    daysUntilDeadline: i.deadline ? Math.round((new Date(i.deadline).getTime() - now.getTime()) / 86_400_000) : null,
    cadence: i.cadence ? describeCadence(i.cadence) : null,
    neglected: i.neglected,
    neglectedByDays: i.neglected && i.cadence ? neglectedByDays(i.cadence, i.lastCompletedAt, i.createdAt, now) : 0,
    optionality: i.optionality,
    effort: i.effort,
    eventAt: i.eventAt,
    daysUntilEvent: i.eventAt ? Math.round((new Date(i.eventAt).getTime() - now.getTime()) / 86_400_000) : null,
    themes: i.themes.map((t) => t.name),
    daysSinceLastSurfaced: i.lastSurfacedAt
      ? Math.round((now.getTime() - new Date(i.lastSurfacedAt).getTime()) / 86_400_000)
      : null,
    recapturedTimes: Math.max(0, i.rawTexts.length - 1),
  };
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
    .prepare('SELECT id, name, kind, prominence, reason FROM bubbles WHERE day = ? ORDER BY prominence DESC')
    .bind(day)
    .all<{ id: string; name: string; kind: string; prominence: number; reason: string }>();
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
      items: items.map((i) => brainItemPayload(i, now)),
      userProfile: await getState(db, 'profile_text'),
      recentNameVocabulary: nameRows.results.map((r) => r.name),
      previouslyShown_reuseOnlyIfStillApt: previouslyShown,
    },
    output: bubbleRows.results.map((b) => ({
      name: b.name,
      kind: b.kind,
      prominence: b.prominence,
      reason: b.reason,
      items: members.get(b.id) ?? [],
    })),
  };
}

interface ProposedBubble {
  name: string;
  kind: 'situation' | 'rotation';
  prominence: number;
  reason: string;
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

ORGANIZING PRINCIPLE: a bubble is a SITUATION or context — the moment the user would act ("Before Sarah visits", "Morning routine", "At the computer"). NOT time-buckets ("Due this week" is a task list, not a situation) and NOT themes (theme grouping belongs to the browse view, never to you). Time pressure pulls items into their situation and raises prominence; it is not a bubble of its own.

PROMINENCE (0.05–1.0) is the scarce resource, not inclusion. There is no cap on bubbles; the map scrolls. Anything important gets a slot even if small. Blend four factors, qualitatively: urgency (deadline proximity — but dampened for optional items), importance (the given priority value), effort/lead-time (big tasks need runway: "do taxes" outranks "call grandma" at equal due date), and forgettability (easily-slipped things surface harder). Don't let a flat due-date sort bury a big important thing. A hard deadline today/overdue → prominence near 1.0. A visitor four weeks out → a small persistent dot (~0.1–0.2).

NON-NEGOTIABLE — TODAY'S DATED ITEMS: every item due today (daysUntilDeadline ≤ 0) or happening today (daysUntilEvent ≤ 0 and not past) MUST appear in some bubble. Low priority, optionality, a soft deadline, or profile impressions make a same-day item's bubble SMALLER (≥0.3), never absent; must-do or hard-deadline same-day items sit ≥0.5. Missing a same-day item is this app's cardinal failure.

The user profile is advisory colour for naming, grouping, and emphasis ONLY. It must never veto: never exclude or demote a dated item because the profile suggests the user might not care about that kind of thing.

KNOWs: event-linked KNOWs (their trigger is another item in the app) go INTO that situation's bubble alongside its DOs. Life-triggered KNOWs (trigger the app can't sense) get rehearsal rotation: include ONE small bubble (kind "rotation", prominence ≤ 0.15, name like "Keep in mind") with 2-4 KNOWs, favouring important and not-recently-surfaced ones. Quiet — under-rotate rather than over-rotate; omitting the rotation bubble entirely is often the right call. Distinguish two kinds of KNOW: REFERENCE facts (where objects are stored, measurements, how-tos — useful exactly when searched for) almost never rotate — only if recently recaptured (recapturedTimes > 0), and never just to fill the bubble. KEEP-WARM facts (people-facts, commitments, insights the user needs near top of mind) are what rotation is for.

NAMING: reuse a name from the vocabulary when semantically apt (never coin a synonym for the same recurring situation — that causes needless reshuffle); coin a new name when the situation genuinely differs. Names are short, concrete, plainly human. Preparation framing ("Before X", "Getting ready for X") is EARNED: use it only when the bubble actually contains prep tasks to do before the event. A bubble that is just an upcoming event (plus related facts) is simply named as the event ("Sarah & Deidra's visit", not "Before Sarah & Deidra arrive").

PREVIOUSLY SHOWN (yesterday) is provided ONLY as optional reference — reuse a grouping only if it is still apt today. Compose fresh from the items; do NOT treat yesterday's map as a default to preserve.

Do not force every item into the map — the browse view holds everything; you curate. Items may appear in more than one bubble only when genuinely central to both; prefer one home. Every bubble needs at least one item.

OUTPUT: {"bubbles":[{"name":str,"kind":"situation"|"rotation","prominence":num,"reason":str,"itemIds":[ids]}]}

"reason" is the card's face text — a single glanceable line telling the user what's inside and when it matters, WITHOUT tapping. Concrete contents + status, e.g. "Dentist Tue 3pm — taxes due Aug 15 need a start" or "6 address updates pending, none scheduled yet". Never repeat the bubble name, never explain the grouping ("these belong together because..."), never meta-commentary. Mention dates when items have them; for a single-item bubble say what the item needs next.`;

  const user = JSON.stringify({
    today: day,
    weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(`${day}T12:00:00Z`).getUTCDay()],
    items: items.map((i) => brainItemPayload(i, now)),
    userProfile: profileText,
    recentNameVocabulary: nameVocabulary,
    previouslyShown_reuseOnlyIfStillApt: previous,
  });

  const out = await anthropicJson<{ bubbles: ProposedBubble[] }>(env, env.BRAIN_MODEL, system, user, 8192);
  return (out.bubbles ?? [])
    .filter((b) => b && b.name && Array.isArray(b.itemIds))
    .map((b) => ({
      name: String(b.name),
      kind: b.kind === 'rotation' ? 'rotation' as const : 'situation' as const,
      prominence: typeof b.prominence === 'number' ? b.prominence : 0.4,
      reason: String(b.reason ?? ''),
      itemIds: b.itemIds.map(String),
    }));
}

// ---------- Deterministic fallback map (no LLM configured) ----------

// Compact card-face summary: first titles with their dates, "+N more".
function summarizeItems(items: ItemView[], now: Date): string {
  const short = (iso: string): string => {
    const days = Math.round((new Date(iso).getTime() - now.getTime()) / 86_400_000);
    if (days < 0) return `${-days}d overdue`;
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days < 7) return new Date(iso).toLocaleDateString('en', { weekday: 'short' });
    return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' });
  };
  const parts = items.slice(0, 2).map((i) => {
    const when = i.deadline ?? i.eventAt;
    return when ? `${i.title} (${short(when)})` : i.title;
  });
  const extra = items.length - parts.length;
  return parts.join(' · ') + (extra > 0 ? ` · +${extra} more` : '');
}

function fallbackBubbles(items: ItemView[], now: Date): ProposedBubble[] {
  const bubbles: ProposedBubble[] = [];
  const dueSoon = items.filter(
    (i) => i.type === 'DO' && i.deadline && new Date(i.deadline).getTime() - now.getTime() < 7 * 86_400_000,
  );
  if (dueSoon.length) {
    const soonest = Math.min(...dueSoon.map((i) => new Date(i.deadline!).getTime() - now.getTime()));
    bubbles.push({
      name: 'Due soon',
      kind: 'situation',
      prominence: soonest < 86_400_000 ? 0.95 : 0.7,
      reason: summarizeItems(dueSoon, now),
      itemIds: dueSoon.map((i) => i.id),
    });
  }
  const neglected = items.filter((i) => i.neglected && !dueSoon.includes(i));
  if (neglected.length) {
    bubbles.push({
      name: 'Rhythms to pick back up',
      kind: 'situation',
      prominence: 0.5,
      reason: summarizeItems(neglected, now),
      itemIds: neglected.map((i) => i.id),
    });
  }
  const upcoming = items.filter(
    (i) => i.type === 'HAPPEN' && i.eventAt && new Date(i.eventAt).getTime() > now.getTime() - 86_400_000 &&
      new Date(i.eventAt).getTime() - now.getTime() < 14 * 86_400_000,
  );
  if (upcoming.length) {
    bubbles.push({
      name: 'Coming up',
      kind: 'situation',
      prominence: 0.55,
      reason: summarizeItems(upcoming, now),
      itemIds: upcoming.map((i) => i.id),
    });
  }
  const important = items.filter(
    (i) => i.effectivePriority >= 0.65 && !dueSoon.includes(i) && !neglected.includes(i) && !upcoming.includes(i) && i.type !== 'KNOW',
  );
  if (important.length) {
    bubbles.push({
      name: 'Important',
      kind: 'situation',
      prominence: 0.45,
      reason: summarizeItems(important, now),
      itemIds: important.map((i) => i.id),
    });
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
    bubbles.push({
      name: 'Keep in mind',
      kind: 'rotation',
      prominence: 0.12,
      reason: summarizeItems(knows, now),
      itemIds: knows.map((i) => i.id),
    });
  }
  return bubbles;
}

// ---------- Tier-2 profile recompute (§7.3) ----------

async function recomputeProfile(env: Env, day: string): Promise<string | null> {
  const db = env.DB;
  if (!llmAvailable(env)) return getState(db, 'profile_text');

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const events = await db
    .prepare('SELECT ts, actor, type, item_id, payload FROM events WHERE ts >= ? ORDER BY ts LIMIT 1500')
    .bind(since)
    .all<{ ts: string; actor: string; type: string; item_id: string | null; payload: string }>();
  if (!events.results.length) return getState(db, 'profile_text');

  const itemTitles = await db
    .prepare("SELECT id, title, type FROM items WHERE status != 'deleted'")
    .all<{ id: string; title: string; type: string }>();
  const titleById = new Map(itemTitles.results.map((r) => [r.id, `${r.title} (${r.type})`]));

  const system = `You write the user-profile scratchpad for "Memory", a memory-aid app. From the 30-day event log (one line per event: "MM-DD HH:MM actor type — detail", times UTC), write a SHORT freeform-prose profile (5-12 lines) of this user's patterns, for two readers: the Brain (surfacing habits: when they check in, which themes/items they reliably skip or complete, what spikes before what) and Smart Capture (correction patterns: re-theming tendencies, priority adjustments they make, over/under-splitting corrections — so future parses can lean toward their demonstrated preferences). Be concrete and hedged ("tends to", "often"). This profile is ADVISORY — it flavours judgement, it never gates decisions. No JSON, just the prose.`;

  // One compact line per event — the builder needs "what happened when",
  // not full field diffs. Keeps a month of history to a few thousand tokens.
  const lines = events.results.map((e) => {
    const p = safeParse(e.payload) as Record<string, unknown>;
    const title = e.item_id ? titleById.get(e.item_id) ?? '' : '';
    let detail = title;
    if (e.type === 'captured' && typeof p?.text === 'string') detail = p.text.slice(0, 80);
    else if (e.type === 'edited' && p?.after && typeof p.after === 'object')
      detail = `${title} [changed: ${Object.keys(p.after as object).join(', ')}]`;
    else if (e.type === 're_themed' && Array.isArray(p?.before) && Array.isArray(p?.after))
      detail = `${title} [${(p.before as string[]).join('/')}→${(p.after as string[]).join('/')}]`;
    else if (e.type === 'recaptured' && typeof p?.appendedText === 'string')
      detail = `${title} +"${p.appendedText.slice(0, 60)}"`;
    else if (e.type === 'theme_merged' || e.type === 'theme_renamed')
      detail = `${p?.from ?? ''}→${p?.into ?? p?.to ?? ''}`;
    else if (e.type === 'map_rebuilt') detail = '';
    return `${e.ts.slice(5, 16).replace('T', ' ')} ${e.actor} ${e.type}${detail ? ` — ${detail}` : ''}`;
  });

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
      `SELECT t.id, t.name, COUNT(it.item_id) as n FROM themes t
       LEFT JOIN item_themes it ON it.theme_id = t.id
       WHERE t.deleted_at IS NULL GROUP BY t.id`,
    )
    .all<{ id: string; name: string; n: number }>();

  const system = `You are the librarian of an emergent theme taxonomy in a personal memory app. Given themes and their item counts, propose AT MOST 3 conservative restructures that make the taxonomy calmer: merge near-duplicate or too-small themes into a better home, or rename an awkward name. Do nothing if the taxonomy is fine — an empty list is a good answer. Reply ONLY JSON: {"ops":[{"op":"merge","fromId":str,"intoId":str,"note":"one-line rationale"}|{"op":"rename","id":str,"newName":str,"note":str}]}`;

  const out = await anthropicJson<{
    ops: ({ op: 'merge'; fromId: string; intoId: string; note: string } | { op: 'rename'; id: string; newName: string; note: string })[];
  }>(env, env.CAPTURE_MODEL, system, JSON.stringify({ themes: counts.results }));

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

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
