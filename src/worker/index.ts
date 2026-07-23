import { Hono } from 'hono';
import type { Env } from './env';
import { handleCapture, undoRecapture, type CaptureRequest } from './capture';
import { addFirstStep, brainSnapshot, composeBrainSystem, getMap, rebuildMap } from './brain';
import { browse, calendar, completeItem, dismissItem, editItem, missItem, rejectItem, reopenItem, search, uncompleteItem, type ItemEdits } from './items';
import { runPushScan, saveSubscription } from './push';
import { getItem, getState, getTzOffset, listItems, setState, toItemView } from './db';

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  console.error('API error', err);
  return c.json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
});

// Access gate: when SECRET_PASSWORD is set, every API call must present it.
// The client stores it once per device (unlock screen) and sends it as a header.
app.use('/api/*', async (c, next) => {
  const expected = c.env.SECRET_PASSWORD;
  if (expected && !constantTimeEqual(c.req.header('x-memory-auth') ?? '', expected)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i % Math.max(1, ab.length)] ?? 0) ^ (bb[i % Math.max(1, bb.length)] ?? 0);
  return diff === 0;
}

// ---------- Capture (§10) ----------

app.post('/api/capture', async (c) => {
  const body = await c.req.json<CaptureRequest>();
  if (!body.text?.trim()) return c.json({ error: 'empty capture' }, 400);
  if (typeof body.tzOffsetMinutes === 'number') {
    await setState(c.env.DB, 'tz_offset_minutes', String(body.tzOffsetMinutes));
  }
  return c.json(await handleCapture(c.env, body));
});

app.post('/api/items/:id/undo-recapture', async (c) => {
  const { appendedText } = await c.req.json<{ appendedText: string }>();
  const fresh = await undoRecapture(c.env, c.req.param('id'), appendedText);
  return c.json({ newItem: fresh });
});

// ---------- Map (§6, §9.1) ----------

app.get('/api/map', async (c) => {
  const day = c.req.query('day');
  if (!day) return c.json({ error: 'day required (YYYY-MM-DD, user-local)' }, 400);
  return c.json(await getMap(c.env, day));
});

// First-open-of-day rebuild; the client shows a loading screen while this runs.
// force=true is the user-initiated "Organize now" re-run (bulk-import days).
// noHistory=true is the workshop variant: the Brain composes without
// yesterday's groupings (librarian and profile still see full history).
// promptVariant pins a specific Brain prompt for this run (workshop buttons);
// omitted, the stored preference decides (the morning-prompt toggle).
app.post('/api/map/rebuild', async (c) => {
  const { day, tzOffsetMinutes, force, noHistory, promptVariant } = await c.req.json<{
    day: string;
    tzOffsetMinutes?: number;
    force?: boolean;
    noHistory?: boolean;
    promptVariant?: 'full' | 'minimal';
  }>();
  if (!day) return c.json({ error: 'day required' }, 400);
  if (typeof tzOffsetMinutes === 'number') {
    await setState(c.env.DB, 'tz_offset_minutes', String(tzOffsetMinutes));
  }
  const variant = promptVariant === 'full' || promptVariant === 'minimal' ? promptVariant : undefined;
  return c.json(await rebuildMap(c.env, day, !!force, !!noHistory, variant));
});

// Which Brain prompt the morning rebuild uses — the workshop shootout's
// longitudinal arm. Stored server-side so first-open-of-day picks it up.
app.post('/api/settings/brain-prompt', async (c) => {
  const { variant } = await c.req.json<{ variant: string }>();
  if (variant !== 'full' && variant !== 'minimal') return c.json({ error: 'variant must be "full" or "minimal"' }, 400);
  await setState(c.env.DB, 'brain_prompt_variant', variant);
  return c.json({ ok: true, variant });
});

// User-authored text appended verbatim to whichever Brain prompt runs — the
// self-serve workshop layer (tone experiments and the like). Empty clears it.
app.post('/api/settings/brain-addendum', async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  if (typeof text !== 'string') return c.json({ error: 'text must be a string' }, 400);
  await setState(c.env.DB, 'brain_prompt_addendum', text.trim().slice(0, 4000));
  return c.json({ ok: true });
});

// Full prompt override: while enabled AND non-empty, the saved text IS the
// whole Brain prompt (variant toggle and addendum ignored). The enabled flag
// and the text are stored separately so unchecking leaves the draft intact
// but completely inert. Fields are optional — only what's sent is updated.
app.post('/api/settings/brain-override', async (c) => {
  const { enabled, text } = await c.req.json<{ enabled?: boolean; text?: string }>();
  if (enabled === undefined && text === undefined) return c.json({ error: 'enabled or text required' }, 400);
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') return c.json({ error: 'enabled must be a boolean' }, 400);
    await setState(c.env.DB, 'brain_prompt_override_enabled', enabled ? '1' : '');
  }
  if (text !== undefined) {
    if (typeof text !== 'string') return c.json({ error: 'text must be a string' }, 400);
    await setState(c.env.DB, 'brain_prompt_override', text.trim().slice(0, 20000));
  }
  return c.json({ ok: true });
});

// The composed default prompt (current variant + addendum), fetched fresh —
// what the override editor prefills and what Reset restores.
app.get('/api/settings/brain-prompt-text', async (c) => {
  const db = c.env.DB;
  const variant = (await getState(db, 'brain_prompt_variant')) === 'full' ? 'full' : 'minimal';
  const addendum = (await getState(db, 'brain_prompt_addendum'))?.trim() || null;
  return c.json({ variant, text: composeBrainSystem(variant, addendum) });
});

// The user answers a bubble's break-it-down invitation (§9.2): their typed
// step is parsed like any capture and becomes a real item on the card.
// Returns the updated map plus a CaptureResponse for the review sheet.
app.post('/api/bubbles/:id/first-step', async (c) => {
  const { title } = await c.req.json<{ title: string }>();
  if (!title?.trim()) return c.json({ error: 'empty step' }, 400);
  const res = await addFirstStep(c.env, c.req.param('id'), title);
  if (!res) return c.json({ error: 'bubble not found' }, 404);
  return c.json(res);
});

// Brain workshop snapshot: the exact input the Brain sees + the current map
// output, as one small JSON — for tuning the clustering without full exports.
app.get('/api/debug/brain', async (c) => {
  const day = c.req.query('day') ?? (await getState(c.env.DB, 'map_day'));
  if (!day) return c.json({ error: 'no map built yet' }, 400);
  return c.json(await brainSnapshot(c.env, day));
});

// Full backup: everything, as one JSON document. Behind the access gate.
app.get('/api/export', async (c) => {
  const db = c.env.DB;
  const [items, captures, themes, itemThemes, events, bubbles, bubbleItems, profiles, themeNotes] = await Promise.all([
    db.prepare('SELECT id,type,title,raw_texts,status,deadline,deadline_hardness,cadence,optionality,effort,ping_natured,event_at,event_end,alert_lead_minutes,priority_base,priority_boost,boost_updated_at,user_priority,flavour_override,created_at,updated_at,last_touched_at,last_completed_at,completion_count,streak,last_surfaced_at,parse_confidence,capture_id,affect_tags FROM items').all(),
    db.prepare('SELECT * FROM captures').all(),
    db.prepare('SELECT * FROM themes').all(),
    db.prepare('SELECT * FROM item_themes').all(),
    db.prepare('SELECT * FROM events').all(),
    db.prepare('SELECT * FROM bubbles').all(),
    db.prepare('SELECT * FROM bubble_items').all(),
    db.prepare('SELECT * FROM profiles').all(),
    db.prepare('SELECT * FROM theme_notes').all(),
  ]);
  return c.json({
    exportedAt: new Date().toISOString(),
    format: 'memory-v1',
    items: items.results,
    captures: captures.results,
    themes: themes.results,
    itemThemes: itemThemes.results,
    events: events.results,
    bubbles: bubbles.results,
    bubbleItems: bubbleItems.results,
    profiles: profiles.results,
    themeNotes: themeNotes.results,
  });
});

// ---------- Items ----------

app.get('/api/items', async (c) => {
  const now = new Date();
  const tz = await getTzOffset(c.env.DB);
  const items = await listItems(c.env.DB, { statuses: ['active', 'completed', 'dismissed', 'passed', 'missed'] });
  return c.json({ items: items.map((i) => toItemView(i, now, tz)) });
});

app.get('/api/items/:id', async (c) => {
  const item = await getItem(c.env.DB, c.req.param('id'));
  if (!item) return c.json({ error: 'not found' }, 404);
  return c.json({ item: toItemView(item, new Date(), await getTzOffset(c.env.DB)) });
});

app.patch('/api/items/:id', async (c) => {
  const edits = await c.req.json<ItemEdits>();
  const item = await editItem(c.env, c.req.param('id'), edits);
  if (!item) return c.json({ error: 'not found' }, 404);
  return c.json({ item });
});

app.post('/api/items/:id/complete', async (c) => {
  // Optional body { terminal: true } retires a recurring DO for good
  // ("goal achieved") instead of checking off today's occurrence.
  const body = await c.req.json<{ terminal?: boolean }>().catch(() => ({ terminal: false }));
  const item = await completeItem(c.env, c.req.param('id'), { terminal: !!body.terminal });
  if (!item) return c.json({ error: 'not found or not completable (events pass or are missed)' }, 404);
  return c.json({ item });
});

app.post('/api/items/:id/uncomplete', async (c) => {
  const item = await uncompleteItem(c.env, c.req.param('id'));
  if (!item) return c.json({ error: 'not found' }, 404);
  return c.json({ item });
});

app.post('/api/items/:id/dismiss', async (c) => {
  const item = await dismissItem(c.env, c.req.param('id'));
  if (!item) return c.json({ error: 'not found' }, 404);
  return c.json({ item });
});

app.post('/api/items/:id/miss', async (c) => {
  const item = await missItem(c.env, c.req.param('id'));
  if (!item) return c.json({ error: 'not found or not a one-shot event' }, 404);
  return c.json({ item });
});

app.post('/api/items/:id/reopen', async (c) => {
  const item = await reopenItem(c.env, c.req.param('id'));
  if (!item) return c.json({ error: 'not found or not closed' }, 404);
  return c.json({ item });
});

app.delete('/api/items/:id', async (c) => {
  const ok = await rejectItem(c.env, c.req.param('id'));
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

// ---------- Browse, calendar, search (§6) ----------

app.get('/api/browse', async (c) => c.json(await browse(c.env)));

app.get('/api/calendar', async (c) => {
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (!from || !to) return c.json({ error: 'from/to required (ISO)' }, 400);
  return c.json(await calendar(c.env, from, to));
});

app.get('/api/search', async (c) => {
  const q = c.req.query('q') ?? '';
  return c.json(await search(c.env, q));
});

// ---------- Push (§11) ----------

app.get('/api/push/public-key', (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY ?? null }));

app.post('/api/push/subscribe', async (c) => {
  const body = await c.req.json<{ subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; tzOffsetMinutes?: number }>();
  if (!body.subscription?.endpoint) return c.json({ error: 'invalid subscription' }, 400);
  await saveSubscription(c.env, body.subscription);
  if (typeof body.tzOffsetMinutes === 'number') {
    await setState(c.env.DB, 'tz_offset_minutes', String(body.tzOffsetMinutes));
  }
  return c.json({ ok: true });
});

// ---------- Diagnostics ----------

app.get('/api/status', async (c) => {
  const db = c.env.DB;
  const [items, active, themes, events, subs] = await Promise.all([
    db.prepare("SELECT COUNT(*) as n FROM items WHERE status != 'deleted'").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) as n FROM items WHERE status = 'active'").first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) as n FROM themes WHERE deleted_at IS NULL').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) as n FROM events').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) as n FROM push_subscriptions').first<{ n: number }>(),
  ]);
  return c.json({
    ok: true,
    items: items?.n ?? 0,
    activeItems: active?.n ?? 0,
    themes: themes?.n ?? 0,
    events: events?.n ?? 0,
    llm: !!c.env.ANTHROPIC_API_KEY,
    workersAi: !!c.env.AI,
    push: !!(c.env.VAPID_PUBLIC_KEY && c.env.VAPID_PRIVATE_KEY),
    pushSubscriptions: subs?.n ?? 0,
    captureModel: c.env.CAPTURE_MODEL,
    brainModel: c.env.BRAIN_MODEL,
    mapDay: await getState(db, 'map_day'),
    mapBuiltAt: await getState(db, 'map_built_at'),
    brainPrompt: (await getState(db, 'brain_prompt_variant')) === 'full' ? 'full' : 'minimal',
    brainAddendum: (await getState(db, 'brain_prompt_addendum')) ?? '',
    brainOverrideEnabled: (await getState(db, 'brain_prompt_override_enabled')) === '1',
    brainOverride: (await getState(db, 'brain_prompt_override')) ?? '',
  });
});

export default {
  fetch: app.fetch,
  // Layer-1 punctual push scan (§11.4): every 5 minutes, deterministic.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runPushScan(env));
  },
};
