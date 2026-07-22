import type { AffectEntry, BackendType, Cadence, EventActor, Flavour, Item, ItemView, RawText, Theme } from '../shared/types';
import { deriveFlavour } from '../shared/flavour';
import { effectivePriority } from '../shared/priority';
import { completedWithinLocalDay, isNeglected } from '../shared/cadence';

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

interface ItemRow {
  id: string;
  type: string;
  title: string;
  raw_texts: string;
  status: string;
  deadline: string | null;
  deadline_hardness: string | null;
  cadence: string | null;
  optionality: string;
  effort: string;
  ping_natured: number;
  event_at: string | null;
  event_end: string | null;
  alert_lead_minutes: number | null;
  priority_base: number;
  priority_boost: number;
  boost_updated_at: string | null;
  user_priority: number | null;
  flavour_override: string | null;
  created_at: string;
  updated_at: string;
  last_touched_at: string;
  last_completed_at: string | null;
  completion_count: number;
  streak: number;
  last_surfaced_at: string | null;
  parse_confidence: number;
  capture_id: string | null;
  affect_tags: string | null;
}

export function rowToItem(row: ItemRow, themes: Theme[] = []): Item {
  return {
    id: row.id,
    type: row.type as BackendType,
    title: row.title,
    rawTexts: JSON.parse(row.raw_texts) as RawText[],
    status: row.status as Item['status'],
    deadline: row.deadline,
    deadlineHardness: (row.deadline_hardness as Item['deadlineHardness']) ?? null,
    cadence: row.cadence ? (JSON.parse(row.cadence) as Cadence) : null,
    optionality: row.optionality as Item['optionality'],
    effort: row.effort as Item['effort'],
    pingNatured: !!row.ping_natured,
    eventAt: row.event_at,
    eventEnd: row.event_end,
    alertLeadMinutes: row.alert_lead_minutes,
    priorityBase: row.priority_base,
    priorityBoost: row.priority_boost,
    boostUpdatedAt: row.boost_updated_at,
    userPriority: row.user_priority,
    flavourOverride: (row.flavour_override as Flavour | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTouchedAt: row.last_touched_at,
    lastCompletedAt: row.last_completed_at,
    completionCount: row.completion_count,
    streak: row.streak,
    lastSurfacedAt: row.last_surfaced_at,
    parseConfidence: row.parse_confidence,
    affects: row.affect_tags ? (JSON.parse(row.affect_tags) as AffectEntry[]) : [],
    themes,
  };
}

export function toItemView(item: Item, now: Date, tzOffsetMinutes = 0): ItemView {
  return {
    ...item,
    flavour: deriveFlavour(item),
    effectivePriority: effectivePriority(item, now),
    neglected: item.type === 'DO' && item.status === 'active'
      ? isNeglected(item.cadence, item.lastCompletedAt, item.createdAt, now)
      : false,
    doneToday: item.type === 'DO' && completedWithinLocalDay(item.lastCompletedAt, now, tzOffsetMinutes),
  };
}

async function themesForItems(db: D1Database, itemIds: string[]): Promise<Map<string, Theme[]>> {
  const map = new Map<string, Theme[]>();
  if (!itemIds.length) return map;
  // D1 bind-parameter limit is generous, but chunk to stay safe.
  for (let i = 0; i < itemIds.length; i += 50) {
    const chunk = itemIds.slice(i, i + 50);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db
      .prepare(
        `SELECT it.item_id, t.id, t.name FROM item_themes it
         JOIN themes t ON t.id = it.theme_id AND t.deleted_at IS NULL
         WHERE it.item_id IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<{ item_id: string; id: string; name: string }>();
    for (const r of rows.results) {
      const list = map.get(r.item_id) ?? [];
      list.push({ id: r.id, name: r.name });
      map.set(r.item_id, list);
    }
  }
  return map;
}

export async function getItem(db: D1Database, id: string): Promise<Item | null> {
  const row = await db.prepare('SELECT * FROM items WHERE id = ?').bind(id).first<ItemRow>();
  if (!row) return null;
  const themes = await themesForItems(db, [id]);
  return rowToItem(row, themes.get(id) ?? []);
}

export async function listItems(
  db: D1Database,
  opts: { statuses?: string[]; types?: string[] } = {},
): Promise<Item[]> {
  const statuses = opts.statuses ?? ['active'];
  const conds = [`status IN (${statuses.map(() => '?').join(',')})`];
  const binds: unknown[] = [...statuses];
  if (opts.types?.length) {
    conds.push(`type IN (${opts.types.map(() => '?').join(',')})`);
    binds.push(...opts.types);
  }
  const rows = await db
    .prepare(`SELECT * FROM items WHERE ${conds.join(' AND ')} ORDER BY created_at DESC`)
    .bind(...binds)
    .all<ItemRow>();
  const themeMap = await themesForItems(db, rows.results.map((r) => r.id));
  return rows.results.map((r) => rowToItem(r, themeMap.get(r.id) ?? []));
}

// ---------- Tier-0 event log (§7.1): append-only, structured ----------

export async function logEvent(
  db: D1Database,
  actor: EventActor,
  type: string,
  opts: { itemId?: string | null; bubbleId?: string | null; payload?: unknown } = {},
): Promise<void> {
  await db
    .prepare('INSERT INTO events (id, ts, actor, type, item_id, bubble_id, payload) VALUES (?,?,?,?,?,?,?)')
    .bind(newId(), nowIso(), actor, type, opts.itemId ?? null, opts.bubbleId ?? null, JSON.stringify(opts.payload ?? {}))
    .run();
}

// ---------- Item persistence ----------

export interface NewItemInput {
  type: BackendType;
  title: string;
  rawText: RawText;
  deadline?: string | null;
  deadlineHardness?: 'hard' | 'soft' | null;
  cadence?: Cadence | null;
  optionality?: 'must' | 'nice';
  effort?: 'quick' | 'medium' | 'large';
  pingNatured?: boolean;
  eventAt?: string | null;
  eventEnd?: string | null;
  alertLeadMinutes?: number | null;
  priorityBase?: number;
  parseConfidence?: number;
  captureId?: string | null;
  affects?: AffectEntry[];
  embedding?: Float32Array | null;
}

export async function insertItem(db: D1Database, input: NewItemInput): Promise<string> {
  const id = newId();
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO items (
        id, type, title, raw_texts, status,
        deadline, deadline_hardness, cadence, optionality, effort, ping_natured,
        event_at, event_end, alert_lead_minutes,
        priority_base, priority_boost, boost_updated_at, user_priority,
        flavour_override, created_at, updated_at, last_touched_at,
        last_completed_at, completion_count, streak, last_surfaced_at,
        parse_confidence, capture_id, affect_tags, embedding
      ) VALUES (?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?,0,NULL,NULL,NULL,?,?,?,NULL,0,0,NULL,?,?,?,?)`,
    )
    .bind(
      id,
      input.type,
      input.title,
      JSON.stringify([input.rawText]),
      input.deadline ?? null,
      input.deadlineHardness ?? null,
      input.cadence ? JSON.stringify(input.cadence) : null,
      input.optionality ?? 'must',
      input.effort ?? 'medium',
      input.pingNatured ? 1 : 0,
      input.eventAt ?? null,
      input.eventEnd ?? null,
      input.alertLeadMinutes ?? null,
      input.priorityBase ?? 0.5,
      ts,
      ts,
      ts,
      input.parseConfidence ?? 1.0,
      input.captureId ?? null,
      input.affects?.length ? JSON.stringify(input.affects) : null,
      input.embedding ? embeddingToBlob(input.embedding) : null,
    )
    .run();
  await syncFts(db, id, input.title, input.rawText.text);
  return id;
}

export async function updateItemFields(db: D1Database, id: string, fields: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  await db
    .prepare(`UPDATE items SET ${sets}, updated_at = ?, last_touched_at = ? WHERE id = ?`)
    .bind(...cols.map((c) => fields[c]), nowIso(), nowIso(), id)
    .run();
}

export async function syncFts(db: D1Database, itemId: string, title: string, rawText: string): Promise<void> {
  await db.prepare('DELETE FROM items_fts WHERE item_id = ?').bind(itemId).run();
  await db.prepare('INSERT INTO items_fts (item_id, title, raw_text) VALUES (?,?,?)').bind(itemId, title, rawText).run();
}

// ---------- Embeddings (Float32 blobs, brute-force cosine — fine at §7.5 volume) ----------

export function embeddingToBlob(v: Float32Array): ArrayBuffer {
  return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
}

// D1 may hand blobs back as ArrayBuffer, Uint8Array, or a plain number[] of
// bytes depending on runtime — normalize all three to the Float32 view.
export function blobToEmbedding(b: ArrayBuffer | Uint8Array | number[]): Float32Array {
  if (Array.isArray(b)) {
    const bytes = Uint8Array.from(b);
    return new Float32Array(bytes.buffer);
  }
  if (b instanceof Uint8Array) {
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }
  return new Float32Array(b);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

export async function nearestItems(
  db: D1Database,
  query: Float32Array,
  k: number,
  opts: { excludeIds?: string[] } = {},
): Promise<{ id: string; score: number }[]> {
  const rows = await db
    .prepare("SELECT id, embedding FROM items WHERE status != 'deleted' AND embedding IS NOT NULL")
    .all<{ id: string; embedding: ArrayBuffer }>();
  const scored: { id: string; score: number }[] = [];
  for (const r of rows.results) {
    if (opts.excludeIds?.includes(r.id)) continue;
    scored.push({ id: r.id, score: cosine(query, blobToEmbedding(r.embedding)) });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, k);
}

// ---------- Themes (§5) ----------

export async function listThemes(db: D1Database): Promise<Theme[]> {
  const rows = await db
    .prepare('SELECT id, name FROM themes WHERE deleted_at IS NULL ORDER BY name')
    .all<{ id: string; name: string }>();
  return rows.results;
}

// Get-or-create by name (case-insensitive match on existing).
export async function ensureTheme(db: D1Database, name: string): Promise<Theme> {
  const trimmed = name.trim();
  const existing = await db
    .prepare('SELECT id, name FROM themes WHERE deleted_at IS NULL AND lower(name) = lower(?)')
    .bind(trimmed)
    .first<{ id: string; name: string }>();
  if (existing) return existing;
  const id = newId();
  await db.prepare('INSERT INTO themes (id, name, created_at) VALUES (?,?,?)').bind(id, trimmed, nowIso()).run();
  return { id, name: trimmed };
}

export async function setItemThemes(
  db: D1Database,
  itemId: string,
  themeNames: string[],
  assignedBy: 'ai' | 'user',
): Promise<Theme[]> {
  // No-dangling invariant (§5): an item's theme-set is never empty.
  const names = themeNames.map((n) => n.trim()).filter(Boolean);
  const finalNames = names.length ? names : ['Misc'];
  const themes: Theme[] = [];
  for (const n of finalNames) themes.push(await ensureTheme(db, n));
  await db.prepare('DELETE FROM item_themes WHERE item_id = ?').bind(itemId).run();
  for (const t of themes) {
    await db
      .prepare('INSERT OR IGNORE INTO item_themes (item_id, theme_id, assigned_by) VALUES (?,?,?)')
      .bind(itemId, t.id, assignedBy)
      .run();
  }
  return themes;
}

// ---------- App state ----------

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

// The user's tz offset, captured client-side on capture/map/push calls. Every
// user-local day computation (doneToday, occurrence-today, push windows) must
// go through the same stored offset or the Brain and the checkbox drift apart.
export async function getTzOffset(db: D1Database): Promise<number> {
  return parseInt((await getState(db, 'tz_offset_minutes')) ?? '0', 10) || 0;
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO app_state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}
