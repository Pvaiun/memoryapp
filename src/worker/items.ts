import type { Cadence, Flavour, ItemView } from '../shared/types';
import { cadencePeriodMs, occurrencesBetween } from '../shared/cadence';
import { resolveDatePhrase } from '../shared/dates';
import type { Env } from './env';
import { embed } from './embeddings';
import {
  blobToEmbedding,
  cosine,
  embeddingToBlob,
  getItem,
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

export async function completeItem(env: Env, id: string): Promise<ItemView | null> {
  const db = env.DB;
  const item = await getItem(db, id);
  if (!item || item.type !== 'DO') return null;
  const ts = nowIso();
  // Streak (§7.2): consecutive completions within cadence rhythm; simple bump/reset.
  const withinRhythm =
    !item.cadence || !item.lastCompletedAt
      ? true
      : Date.now() - new Date(item.lastCompletedAt).getTime() < 2 * cadencePeriodMs(item.cadence);
  await updateItemFields(db, id, {
    // A recurring DO stays active (cadence is a rhythm, not a one-shot);
    // a one-shot DO is completed.
    status: item.cadence ? 'active' : 'completed',
    last_completed_at: ts,
    completion_count: item.completionCount + 1,
    streak: withinRhythm ? item.streak + 1 : 1,
    // Completing clears accumulated recapture boost (§9.3).
    priority_boost: 0,
  });
  await logEvent(db, 'user', 'completed', { itemId: id, payload: { before: { status: item.status }, after: { status: item.cadence ? 'active' : 'completed' } } });
  const fresh = await getItem(db, id);
  return fresh ? toItemView(fresh, new Date()) : null;
}

export async function uncompleteItem(env: Env, id: string): Promise<ItemView | null> {
  const db = env.DB;
  const item = await getItem(db, id);
  if (!item) return null;
  await updateItemFields(db, id, {
    status: 'active',
    completion_count: Math.max(0, item.completionCount - 1),
    streak: Math.max(0, item.streak - 1),
    last_completed_at: null,
  });
  // Immutable correction model (§7.1): a compensating "reverted" event.
  await logEvent(db, 'user', 'completion_reverted', { itemId: id, payload: { before: { status: item.status }, after: { status: 'active' } } });
  const fresh = await getItem(db, id);
  return fresh ? toItemView(fresh, new Date()) : null;
}

// Reject/delete (§10.2): deletes that one item, everything else untouched.
export async function rejectItem(env: Env, id: string): Promise<boolean> {
  const db = env.DB;
  const item = await getItem(db, id);
  if (!item) return false;
  await updateItemFields(db, id, { status: 'deleted' });
  await db.prepare('DELETE FROM items_fts WHERE item_id = ?').bind(id).run();
  await logEvent(db, 'user', 'rejected', { itemId: id, payload: { title: item.title } });
  return true;
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
  alertLeadMinutes?: number | null;
  priority?: number | null; // user edit; null clears the override
  flavourOverride?: Flavour | null;
  themes?: string[];
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
  if (edits.alertLeadMinutes !== undefined) set('alert_lead_minutes', 'alertLeadMinutes', edits.alertLeadMinutes);
  if (edits.priority !== undefined) set('user_priority', 'userPriority', edits.priority);
  // Flavour override is presentation-only (§4): stored, wins over derived,
  // never mutates the behaviour-driving parameters above.
  if (edits.flavourOverride !== undefined) set('flavour_override', 'flavourOverride', edits.flavourOverride);

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
  return fresh ? toItemView(fresh, new Date()) : null;
}

// ---------- Browse (§6): stable, by theme, filterable by flavour ----------

export async function browse(env: Env): Promise<{
  themes: { id: string; name: string; itemIds: string[] }[];
  items: Record<string, ItemView>;
}> {
  const db = env.DB;
  const now = new Date();
  const items = await listItems(db, { statuses: ['active', 'completed'] });
  const views: Record<string, ItemView> = {};
  for (const i of items) views[i.id] = toItemView(i, now);

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
  const items = await listItems(db, { statuses: ['active', 'completed'] });
  const entries: CalendarEntry[] = [];
  const used = new Set<string>();

  for (const item of items) {
    if (item.type === 'HAPPEN' && item.eventAt) {
      if (item.cadence) {
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
      // Recurring DOs with a time anchor also render per-occurrence.
      if (item.cadence?.atTime) {
        for (const occ of occurrencesBetween(item.cadence, item.createdAt, from, to)) {
          const [h, m] = item.cadence.atTime.split(':').map(Number);
          occ.setUTCHours(h, m, 0, 0);
          entries.push({ itemId: item.id, date: occ.toISOString(), kind: 'occurrence' });
          used.add(item.id);
        }
      }
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));
  const views: Record<string, ItemView> = {};
  for (const item of items) if (used.has(item.id)) views[item.id] = toItemView(item, now);
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
  for (const r of rows.results) {
    const sim = cosine(qEmb, blobToEmbedding(r.embedding));
    if (sim > 0.3) scores.set(r.id, Math.max(scores.get(r.id) ?? 0, sim));
  }

  if (!scores.size) return { itemIds: [], items: {} };

  const all = await listItems(db, { statuses: ['active', 'completed'] });
  const views: Record<string, ItemView> = {};
  const ranked: { id: string; score: number }[] = [];
  for (const item of all) {
    const s = scores.get(item.id);
    if (s === undefined) continue;
    const view = toItemView(item, now);
    views[item.id] = view;
    // Relevance, lightly lifted by priority and recency (§6).
    const recencyDays = (now.getTime() - new Date(item.lastTouchedAt).getTime()) / 86_400_000;
    const lift = view.effectivePriority * 0.1 + Math.max(0, 0.08 - recencyDays * 0.002);
    ranked.push({ id: item.id, score: s + lift });
  }
  ranked.sort((a, b) => b.score - a.score);
  return { itemIds: ranked.slice(0, 25).map((r) => r.id), items: views };
}
