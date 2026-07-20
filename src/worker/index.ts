import { Hono } from 'hono';
import type { Env } from './env';
import { handleCapture, undoRecapture, type CaptureRequest } from './capture';
import { brainSnapshot, getMap, rebuildMap } from './brain';
import { browse, calendar, completeItem, editItem, rejectItem, search, uncompleteItem, type ItemEdits } from './items';
import { runPushScan, saveSubscription } from './push';
import { getItem, getState, listItems, setState, toItemView } from './db';

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
app.post('/api/map/rebuild', async (c) => {
  const { day, tzOffsetMinutes, force } = await c.req.json<{ day: string; tzOffsetMinutes?: number; force?: boolean }>();
  if (!day) return c.json({ error: 'day required' }, 400);
  if (typeof tzOffsetMinutes === 'number') {
    await setState(c.env.DB, 'tz_offset_minutes', String(tzOffsetMinutes));
  }
  return c.json(await rebuildMap(c.env, day, !!force));
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
    db.prepare('SELECT id,type,title,raw_texts,status,deadline,deadline_hardness,cadence,optionality,effort,ping_natured,event_at,event_end,alert_lead_minutes,priority_base,priority_boost,boost_updated_at,user_priority,flavour_override,created_at,updated_at,last_touched_at,last_completed_at,completion_count,streak,last_surfaced_at,parse_confidence,capture_id FROM items').all(),
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
  const items = await listItems(c.env.DB, { statuses: ['active', 'completed'] });
  return c.json({ items: items.map((i) => toItemView(i, now)) });
});

app.get('/api/items/:id', async (c) => {
  const item = await getItem(c.env.DB, c.req.param('id'));
  if (!item) return c.json({ error: 'not found' }, 404);
  return c.json({ item: toItemView(item, new Date()) });
});

app.patch('/api/items/:id', async (c) => {
  const edits = await c.req.json<ItemEdits>();
  const item = await editItem(c.env, c.req.param('id'), edits);
  if (!item) return c.json({ error: 'not found' }, 404);
  return c.json({ item });
});

app.post('/api/items/:id/complete', async (c) => {
  const item = await completeItem(c.env, c.req.param('id'));
  if (!item) return c.json({ error: 'not found or not a DO' }, 404);
  return c.json({ item });
});

app.post('/api/items/:id/uncomplete', async (c) => {
  const item = await uncompleteItem(c.env, c.req.param('id'));
  if (!item) return c.json({ error: 'not found' }, 404);
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
  });
});

export default {
  fetch: app.fetch,
  // Layer-1 punctual push scan (§11.4): every 5 minutes, deterministic.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runPushScan(env));
  },
};
