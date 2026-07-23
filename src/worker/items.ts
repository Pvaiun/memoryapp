import type { AffectTag, Cadence, Flavour, ItemView } from '../shared/types';
import { AFFECT_TAGS } from '../shared/types';
import { atTimeOccurrencesBetween, cadencePeriodMs, completedWithinSleepDay, eventPassed, occurrencesBetween } from '../shared/cadence';
import { resolveDatePhrase, sleepDayOf } from '../shared/dates';
import type { Env } from './env';
import { embed, FALLBACK_DIMS } from './embeddings';
import {
  blobToEmbedding,
  cosine,
  embeddingToBlob,
  getItem,
  getTzOffset,
  listItems,
  logEvent,
  nowIso,
  setItemThemes,
  syncFts,
  toItemView,
  updateItemFields,
} from './db';

// Item state changes. Every change appends a Tier-0 event (§7.1); corrections
// append compensating events — the log never pretends a misfire didn't happen.

// The positive exit, labelled per flavour in the UI (Done / Achieved / Got
// it). DOs and KNOWs only — a HAPPEN has no "attended": its neutral default
// is 'passed' (sweepPassedEvents) and its explicit fail is 'missed'.
// terminal: retire a recurring DO for good ("goal achieved") instead of
// checking off today's occurrence.
export async function completeItem(env: Env, id: string, opts: { terminal?: boolean } = {}): Promise<ItemView | null> {
  const db = env.DB;
  const item = await getItem(db, id);
  if (!item || item.type === 'HAPPEN') return null;
  const tz = await getTzOffset(db);
  const doneToday = !!item.cadence && completedWithinSleepDay(item.lastCompletedAt, new Date(), tz);
  // A recurring DO already done today can't be completed again — the second
  // tap is the user toggling today's checkbox off, not a second completion.
  // Guarding here (not just in the UI) is what stops a stale client from
  // inflating completion_count and streak with repeat taps.
  if (item.cadence && !opts.terminal && doneToday) {
    return uncompleteItem(env, id);
  }
  const ts = nowIso();
  const status = item.cadence && !opts.terminal ? 'active' : 'completed';
  // Streak (§7.2): consecutive completions within cadence rhythm; simple bump/reset.
  const withinRhythm =
    !item.cadence || !item.lastCompletedAt
      ? true
      : Date.now() - new Date(item.lastCompletedAt).getTime() < 2 * cadencePeriodMs(item.cadence);
  await updateItemFields(db, id, {
    // A recurring DO stays active per occurrence (cadence is a rhythm, not a
    // one-shot) unless the user retires it terminally.
    status,
    // Retiring a goal already checked off today closes the status without
    // counting a second occurrence.
    ...(opts.terminal && doneToday
      ? {}
      : {
          last_completed_at: ts,
          completion_count: item.completionCount + 1,
          streak: withinRhythm ? item.streak + 1 : 1,
        }),
    // Completing clears accumulated recapture boost (§9.3).
    priority_boost: 0,
  });
  // The before-snapshot carries the rhythm anchors so uncomplete can restore
  // them instead of erasing history (§7.1: corrections compensate, not delete).
  await logEvent(db, 'user', 'completed', {
    itemId: id,
    payload: {
      before: { status: item.status, lastCompletedAt: item.lastCompletedAt, streak: item.streak },
      after: { status },
      // counted:false → this event closed the status without marking a new
      // occurrence; uncomplete must not decrement the completion count.
      ...(opts.terminal ? { terminal: true, counted: !doneToday } : {}),
    },
  });
  const fresh = await getItem(db, id);
  return fresh ? toItemView(fresh, new Date(), tz) : null;
}

export async function uncompleteItem(env: Env, id: string): Promise<ItemView | null> {
  const db = env.DB;
  const item = await getItem(db, id);
  if (!item) return null;
  // Undoing a completion shouldn't wipe the rhythm anchor: the latest
  // 'completed' event's before-snapshot has the previous lastCompletedAt and
  // streak. Legacy events without a snapshot fall back to the old clearing
  // behaviour.
  let prevCompletedAt: string | null = null;
  let prevStreak: number | null = null;
  let counted = true;
  if (item.lastCompletedAt) {
    const ev = await db
      .prepare("SELECT payload FROM events WHERE item_id = ? AND type = 'completed' ORDER BY ts DESC LIMIT 1")
      .bind(id)
      .first<{ payload: string }>();
    if (ev) {
      try {
        const p = JSON.parse(ev.payload) as {
          before?: { lastCompletedAt?: string | null; streak?: number };
          counted?: boolean;
        };
        prevCompletedAt = p.before?.lastCompletedAt ?? null;
        if (typeof p.before?.streak === 'number') prevStreak = p.before.streak;
        counted = p.counted !== false;
      } catch {
        // Unparseable legacy payload — clear, as before.
      }
    }
  }
  await updateItemFields(db, id, {
    status: 'active',
    // A terminal achieve on an already-done-today goal only closed the status
    // (counted:false) — reverting it must not touch the occurrence anchors.
    ...(counted
      ? {
          completion_count: Math.max(0, item.completionCount - 1),
          streak: prevStreak ?? Math.max(0, item.streak - 1),
          last_completed_at: prevCompletedAt,
        }
      : {}),
  });
  // Immutable correction model (§7.1): a compensating "reverted" event.
  await logEvent(db, 'user', 'completion_reverted', { itemId: id, payload: { before: { status: item.status }, after: { status: 'active' } } });
  const tz = await getTzOffset(db);
  const fresh = await getItem(db, id);
  return fresh ? toItemView(fresh, new Date(), tz) : null;
}

// Reject/delete (§10.2): deletes that one item, everything else untouched.
// Pure data hygiene (a mis-parse, a duplicate) — never a life signal; the
// meaningful "let it go" exit is dismissItem.
export async function rejectItem(env: Env, id: string): Promise<boolean> {
  const db = env.DB;
  const item = await getItem(db, id);
  if (!item) return false;
  await updateItemFields(db, id, { status: 'deleted' });
  await db.prepare('DELETE FROM items_fts WHERE item_id = ?').bind(id).run();
  await logEvent(db, 'user', 'rejected', { itemId: id, payload: { title: item.title } });
  return true;
}

// Dismiss: the user says this stopped mattering — a cancelled plan, a stale
// note, a goal let go. A real decision, so it stays searchable and browsable
// (unlike delete) and its event feeds the profile.
export async function dismissItem(env: Env, id: string): Promise<ItemView | null> {
  const db = env.DB;
  const item = await getItem(db, id);
  if (!item || item.status === 'deleted') return null;
  await updateItemFields(db, id, { status: 'dismissed' });
  await logEvent(db, 'user', 'dismissed', {
    itemId: id,
    payload: { before: { status: item.status }, after: { status: 'dismissed' }, title: item.title },
  });
  const fresh = await getItem(db, id);
  return fresh ? toItemView(fresh, new Date(), await getTzOffset(db)) : null;
}

// Missed: the user's explicit "didn't make it" on a one-shot event — the one
// exit an event needs the user for. Attendance is never asserted: an event
// nobody flags simply becomes 'passed' (sweepPassedEvents), so the signal
// stays uniform instead of depending on whether the user felt like logging.
export async function missItem(env: Env, id: string): Promise<ItemView | null> {
  const db = env.DB;
  const item = await getItem(db, id);
  if (!item || item.type !== 'HAPPEN' || item.cadence) return null;
  if (item.status !== 'active' && item.status !== 'passed') return null;
  // Nothing to miss before the moment arrives — the event must have started.
  // (Started is enough: "I'm not going to make it" is real ten minutes in,
  // before the grace hour lets eventPassed call it spent.)
  if (!item.eventAt || new Date(item.eventAt).getTime() > Date.now()) return null;
  await updateItemFields(db, id, { status: 'missed' });
  await logEvent(db, 'user', 'missed', {
    itemId: id,
    payload: { before: { status: item.status }, after: { status: 'missed' }, title: item.title },
  });
  const fresh = await getItem(db, id);
  return fresh ? toItemView(fresh, new Date(), await getTzOffset(db)) : null;
}

// Reopen a dismissed/passed/missed item (mis-taps happen; completed has its
// own uncomplete path). Un-missing an event whose moment already elapsed goes
// back to 'passed', not 'active' — the clock's verdict stands.
export async function reopenItem(env: Env, id: string): Promise<ItemView | null> {
  const db = env.DB;
  const item = await getItem(db, id);
  if (!item || !['dismissed', 'passed', 'missed'].includes(item.status)) return null;
  const next = item.status === 'missed' && eventPassed(item, Date.now()) ? 'passed' : 'active';
  await updateItemFields(db, id, { status: next });
  // Immutable correction model (§7.1): a compensating event, not an erasure.
  await logEvent(db, 'user', 'reopened', {
    itemId: id,
    payload: { before: { status: item.status }, after: { status: next } },
  });
  const fresh = await getItem(db, id);
  return fresh ? toItemView(fresh, new Date(), await getTzOffset(db)) : null;
}

// Crystallize the map's derived "spent event" greying (eventPassed) into a
// stored status once the moment fell in a PREVIOUS sleep-cycle day: the
// evening's event stays visibly greyed all evening and closes overnight with
// the daily rebuild. System-asserted and semantically neutral — 'passed'
// claims nothing about what the user did, so its event never reaches the
// profile. Recurring HAPPENs re-arm per occurrence and are never swept.
export async function sweepPassedEvents(db: D1Database, now: Date, tzOffsetMinutes: number): Promise<void> {
  const items = await listItems(db, { statuses: ['active'], types: ['HAPPEN'] });
  const today = sleepDayOf(now.getTime(), tzOffsetMinutes);
  for (const item of items) {
    if (item.cadence || !item.eventAt) continue;
    const end = new Date(item.eventEnd ?? item.eventAt).getTime();
    if (sleepDayOf(end, tzOffsetMinutes) < today) {
      await updateItemFields(db, item.id, { status: 'passed' });
      await logEvent(db, 'system', 'passed', {
        itemId: item.id,
        payload: { before: { status: 'active' }, after: { status: 'passed' }, title: item.title },
      });
    }
  }
}

export interface ItemEdits {
  title?: string;
  type?: 'DO' | 'KNOW' | 'HAPPEN';
  deadline?: string | null; // ISO, or a natural phrase the client passes through
  deadlinePhrase?: string | null;
  deadlineHardness?: 'hard' | 'soft' | null;
  cadence?: Cadence | null;
  optionality?: 'must' | 'nice';
  effort?: 'quick' | 'medium' | 'large';
  pingNatured?: boolean;
  eventAt?: string | null;
  eventAtPhrase?: string | null;
  eventEnd?: string | null;
  alertLeadMinutes?: number | null;
  showOnCalendar?: boolean;
  priority?: number | null; // user edit; null clears the override
  flavourOverride?: Flavour | null;
  themes?: string[];
  affects?: string[]; // desired current tag set; history of kept tags survives
  tzOffsetMinutes?: number;
}

export async function editItem(env: Env, id: string, edits: ItemEdits): Promise<ItemView | null> {
  const db = env.DB;
  const item = await getItem(db, id);
  if (!item) return null;

  const fields: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const set = (col: string, key: keyof typeof item, value: unknown) => {
    before[col] = item[key];
    after[col] = value;
    fields[col] = value;
  };

  if (edits.title !== undefined && edits.title.trim()) set('title', 'title', edits.title.trim());
  if (edits.type !== undefined) set('type', 'type', edits.type);
  if (edits.deadlinePhrase) {
    const r = resolveDatePhrase(edits.deadlinePhrase, new Date(), edits.tzOffsetMinutes);
    if (r) set('deadline', 'deadline', r.iso);
  } else if (edits.deadline !== undefined) {
    set('deadline', 'deadline', edits.deadline);
  }
  if (edits.deadlineHardness !== undefined) set('deadline_hardness', 'deadlineHardness', edits.deadlineHardness);
  if (edits.cadence !== undefined) set('cadence', 'cadence', edits.cadence ? JSON.stringify(edits.cadence) : null);
  if (edits.optionality !== undefined) set('optionality', 'optionality', edits.optionality);
  if (edits.effort !== undefined) set('effort', 'effort', edits.effort);
  if (edits.pingNatured !== undefined) set('ping_natured', 'pingNatured', edits.pingNatured ? 1 : 0);
  if (edits.eventAtPhrase) {
    const r = resolveDatePhrase(edits.eventAtPhrase, new Date(), edits.tzOffsetMinutes);
    if (r) set('event_at', 'eventAt', r.iso);
  } else if (edits.eventAt !== undefined) {
    set('event_at', 'eventAt', edits.eventAt);
  }
  if (edits.eventEnd !== undefined) set('event_end', 'eventEnd', edits.eventEnd);
  if (edits.alertLeadMinutes !== undefined) set('alert_lead_minutes', 'alertLeadMinutes', edits.alertLeadMinutes);
  if (edits.showOnCalendar !== undefined) set('show_on_calendar', 'showOnCalendar', edits.showOnCalendar ? 1 : 0);
  // Rescheduling a passed/missed event to a future moment reopens it — the
  // clock's verdict covered the old moment only. Dismissed stays dismissed:
  // that was a decision, and reviving it takes an explicit Restore.
  if (
    (item.status === 'passed' || item.status === 'missed') &&
    typeof fields.event_at === 'string' &&
    new Date(fields.event_at).getTime() > Date.now()
  ) {
    set('status', 'status', 'active');
  }
  if (edits.priority !== undefined) set('user_priority', 'userPriority', edits.priority);
  // Flavour override is presentation-only (§4): stored, wins over derived,
  // never mutates the behaviour-driving parameters above.
  if (edits.flavourOverride !== undefined) set('flavour_override', 'flavourOverride', edits.flavourOverride);
  if (edits.affects !== undefined) {
    // The edit is the desired tag SET; history reconciles rather than resets —
    // kept tags retain their per-capture entries (and counts), removed tags
    // drop all entries, added tags start fresh at now.
    const want = new Set(edits.affects.filter((t): t is AffectTag => (AFFECT_TAGS as readonly string[]).includes(t)));
    const have = new Set(item.affects.map((a) => a.tag));
    const next = [
      ...item.affects.filter((a) => want.has(a.tag)),
      ...[...want].filter((t) => !have.has(t)).map((tag) => ({ tag, ts: nowIso() })),
    ];
    set('affect_tags', 'affects', next.length ? JSON.stringify(next) : null);
  }

  if (Object.keys(fields).length) {
    await updateItemFields(db, id, fields);
    await logEvent(db, 'user', 'edited', { itemId: id, payload: { before, after } });
    if (fields.title) {
      const fresh = await getItem(db, id);
      if (fresh) {
        await syncFts(db, id, fresh.title, fresh.rawTexts.map((r) => r.text).join('\n'));
        const emb = await embed(env, fresh.title);
        await updateItemFields(db, id, { embedding: embeddingToBlob(emb) });
      }
    }
  }

  if (edits.themes !== undefined) {
    const themes = await setItemThemes(db, id, edits.themes, 'user');
    await logEvent(db, 'user', 're_themed', {
      itemId: id,
      payload: { before: item.themes.map((t) => t.name), after: themes.map((t) => t.name) },
    });
  }

  const fresh = await getItem(db, id);
  return fresh ? toItemView(fresh, new Date(), await getTzOffset(db)) : null;
}

// ---------- Browse (§6): stable, by theme, filterable by flavour ----------

export async function browse(env: Env): Promise<{
  themes: { id: string; name: string; itemIds: string[] }[];
  items: Record<string, ItemView>;
}> {
  const db = env.DB;
  const now = new Date();
  // Every closed status stays on the shelves (under the "past" reveal) —
  // browse is the full record; only deletions vanish.
  const items = await listItems(db, { statuses: ['active', 'completed', 'dismissed', 'passed', 'missed'] });
  const tz = await getTzOffset(db);
  const views: Record<string, ItemView> = {};
  for (const i of items) views[i.id] = toItemView(i, now, tz);

  const rows = await db
    .prepare(
      `SELECT t.id, t.name, it.item_id FROM themes t
       LEFT JOIN item_themes it ON it.theme_id = t.id
       WHERE t.deleted_at IS NULL ORDER BY t.name`,
    )
    .all<{ id: string; name: string; item_id: string | null }>();

  const themeMap = new Map<string, { id: string; name: string; itemIds: string[] }>();
  for (const r of rows.results) {
    const entry = themeMap.get(r.id) ?? { id: r.id, name: r.name, itemIds: [] };
    if (r.item_id && views[r.item_id]) entry.itemIds.push(r.item_id);
    themeMap.set(r.id, entry);
  }
  return { themes: [...themeMap.values()].filter((t) => t.itemIds.length), items: views };
}

// ---------- Calendar (§6): a presentation lens over the same backend ----------

export interface CalendarEntry {
  itemId: string;
  date: string; // ISO
  kind: 'event' | 'deadline' | 'occurrence';
}

export async function calendar(env: Env, fromIso: string, toIso: string): Promise<{
  entries: CalendarEntry[];
  items: Record<string, ItemView>;
}> {
  const db = env.DB;
  const now = new Date();
  const from = new Date(fromIso);
  const to = new Date(toIso);
  // Passed/missed events keep painting the days they happened on — a calendar
  // without its past is no record. Dismissed = cancelled, so it leaves.
  const items = await listItems(db, { statuses: ['active', 'completed', 'passed', 'missed'] });
  const tz = await getTzOffset(db);
  const entries: CalendarEntry[] = [];
  const used = new Set<string>();

  for (const item of items) {
    if (item.type === 'HAPPEN' && item.eventAt) {
      if (item.cadence) {
        // Recurrences only paint the calendar when they've earned it
        // (show_on_calendar): therapy yes, garbage day no. One-offs below
        // are unconditional — the flag never hides a dated moment.
        if (!item.showOnCalendar) continue;
        for (const occ of occurrencesBetween(item.cadence, item.eventAt, from, to)) {
          entries.push({ itemId: item.id, date: occ.toISOString(), kind: 'occurrence' });
          used.add(item.id);
        }
      } else {
        // Multi-day events (eventEnd set) paint every day they span.
        const start = new Date(item.eventAt);
        const end = item.eventEnd ? new Date(item.eventEnd) : start;
        const cursor = new Date(start);
        for (let i = 0; i < 60 && cursor.getTime() <= end.getTime(); i++) {
          const iso = cursor.toISOString();
          if (iso >= from.toISOString() && iso < to.toISOString()) {
            entries.push({ itemId: item.id, date: iso, kind: 'event' });
            used.add(item.id);
          }
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
      }
    }
    if (item.type === 'DO' && item.status === 'active') {
      if (item.deadline && item.deadline >= from.toISOString() && item.deadline < to.toISOString()) {
        entries.push({ itemId: item.id, date: item.deadline, kind: 'deadline' });
        used.add(item.id);
      }
      // Recurring DOs with a time anchor also render per-occurrence. atTime is
      // user-local, so the occurrence walk runs in the user's frame.
      if (item.cadence?.atTime && item.showOnCalendar) {
        for (const occ of atTimeOccurrencesBetween(item.cadence, item.createdAt, from, to, tz)) {
          entries.push({ itemId: item.id, date: occ.toISOString(), kind: 'occurrence' });
          used.add(item.id);
        }
      }
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));
  const views: Record<string, ItemView> = {};
  for (const item of items) if (used.has(item.id)) views[item.id] = toItemView(item, now, tz);
  return { entries, items: views };
}

// ---------- Smart Search (§6): hybrid keyword + semantic, deterministic ----------

export async function search(env: Env, query: string): Promise<{ itemIds: string[]; items: Record<string, ItemView> }> {
  const db = env.DB;
  const now = new Date();
  const q = query.trim();
  if (!q) return { itemIds: [], items: {} };

  const scores = new Map<string, number>();

  // Keyword half: FTS5 over title + raw phrasings.
  try {
    const ftsQuery = q
      .replace(/['"()*^]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w}"*`)
      .join(' OR ');
    if (ftsQuery) {
      const rows = await db
        .prepare('SELECT item_id, rank FROM items_fts WHERE items_fts MATCH ? ORDER BY rank LIMIT 30')
        .bind(ftsQuery)
        .all<{ item_id: string; rank: number }>();
      rows.results.forEach((r, idx) => {
        scores.set(r.item_id, Math.max(scores.get(r.item_id) ?? 0, 1 - idx * 0.03));
      });
    }
  } catch {
    // FTS syntax edge — fall through to semantic only.
  }

  // Semantic half: reuses the same embeddings as recapture-match (§10.3).
  const qEmb = await embed(env, q);
  const rows = await db
    .prepare("SELECT id, embedding FROM items WHERE status != 'deleted' AND embedding IS NOT NULL")
    .all<{ id: string; embedding: ArrayBuffer }>();
  const sims = rows.results.map((r) => ({ id: r.id, sim: cosine(qEmb, blobToEmbedding(r.embedding)) }));
  const cut = semanticCut(sims.map((s) => s.sim), qEmb.length);
  const top = Math.max(...sims.map((s) => s.sim), 0);
  for (const { id, sim } of sims) {
    if (sim < cut) continue;
    // Rescale into a band comparable with keyword scores: best semantic hit
    // ~1.0, a borderline one ~0.6. Raw cosine can't be blended directly —
    // bge packs everything into a narrow band, so raw gaps are tiny.
    const sem = 0.6 + 0.4 * (top > cut ? (sim - cut) / (top - cut) : 1);
    scores.set(id, Math.max(scores.get(id) ?? 0, sem));
  }

  if (!scores.size) return { itemIds: [], items: {} };

  const all = await listItems(db, { statuses: ['active', 'completed', 'dismissed', 'passed', 'missed'] });
  const tz = await getTzOffset(db);
  const views: Record<string, ItemView> = {};
  const ranked: { id: string; score: number }[] = [];
  for (const item of all) {
    const s = scores.get(item.id);
    if (s === undefined) continue;
    const view = toItemView(item, now, tz);
    views[item.id] = view;
    // Relevance, lightly lifted by priority and recency (§6). Kept an order of
    // magnitude below real score gaps so it breaks ties instead of shuffling.
    const recencyDays = (now.getTime() - new Date(item.lastTouchedAt).getTime()) / 86_400_000;
    const lift = view.effectivePriority * 0.03 + Math.max(0, 0.03 - recencyDays * 0.001);
    ranked.push({ id: item.id, score: s + lift });
  }
  ranked.sort((a, b) => b.score - a.score);
  return { itemIds: ranked.slice(0, 25).map((r) => r.id), items: views };
}

// The similarity bar a semantic hit must clear. Absolute thresholds don't
// transfer across embedding backends: bge-base gives ~0.6-0.75 cosine to
// completely unrelated English phrases (which is how "sim > 0.3" returned the
// whole corpus), while the sparse dev trigram fallback sits near 0 for
// unrelated text. So: a per-backend floor for "plausibly related at all",
// tightened to just-below-the-best-hit so only items competitive with the top
// match survive — not everything the backend considers vaguely English.
// Exported for tests.
export function semanticCut(sims: number[], queryDims: number): number {
  const fallback = queryDims === FALLBACK_DIMS;
  const floor = fallback ? 0.18 : 0.72;
  const margin = fallback ? 0.15 : 0.08;
  const top = Math.max(...sims, 0);
  return Math.max(floor, top - margin);
}
