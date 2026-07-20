import type { CaptureResponse, Item, ItemView, ParseResult, ParsedItem, RawText } from '../shared/types';
import { PRIORITY_BASE, RECAPTURE_BOOST } from '../shared/priority';
import { resolveDatePhrase } from '../shared/dates';
import { heuristicParse } from '../shared/heuristicParse';
import type { Env } from './env';
import { anthropicJson, llmAvailable } from './ai';
import { embed } from './embeddings';
import {
  getItem,
  getState,
  insertItem,
  listThemes,
  logEvent,
  nearestItems,
  newId,
  nowIso,
  setItemThemes,
  syncFts,
  toItemView,
  updateItemFields,
} from './db';

// Smart Capture (§10): raw text saved unconditionally, structured items created
// optimistically, every inferred field reversible, recapture-merge visible+undoable.

export interface CaptureRequest {
  text: string;
  localTime?: string; // client's current time, ISO
  tzOffsetMinutes?: number; // client UTC offset, Date#getTimezoneOffset sign-flipped
}

export async function handleCapture(env: Env, req: CaptureRequest): Promise<CaptureResponse> {
  const db = env.DB;
  const now = new Date();
  const ref = req.localTime ? new Date(req.localTime) : now;
  const tz = req.tzOffsetMinutes;

  // 1. Raw text first, unconditionally (§12): the backstop; nothing is ever lost.
  const captureId = newId();
  await db.prepare('INSERT INTO captures (id, ts, raw_text) VALUES (?,?,?)').bind(captureId, nowIso(), req.text).run();
  await logEvent(db, 'user', 'captured', { payload: { captureId, text: req.text } });

  // 2. Retrieve recapture-match candidates (§10.3 stage 1): embedding retrieval
  //    bounds what the model sees; the LLM adjudicates sameness within it.
  const captureEmbedding = await embed(env, req.text);
  const nearest = await nearestItems(db, captureEmbedding, 8);
  const candidates: Item[] = [];
  for (const n of nearest) {
    if (n.score < 0.45) continue; // clearly-unrelated items aren't candidates
    const item = await getItem(db, n.id);
    if (item && item.status === 'active') candidates.push(item);
  }

  // 3. Parse: segment + classify + themes + match adjudication in one cheap-tier
  //    call (§10.3 "folded into the parse call"), or the deterministic fallback.
  let parsed: ParseResult;
  if (llmAvailable(env)) {
    try {
      parsed = await llmParse(env, req.text, ref, tz, candidates);
    } catch (err) {
      console.error('LLM parse failed; falling back to heuristics', err);
      parsed = heuristicParse(req.text, ref, tz);
    }
  } else {
    parsed = heuristicParse(req.text, ref, tz);
    // Without an LLM there is no sameness adjudication (§10.3) — but a
    // near-identical re-entry is safe to treat as a recapture. Conservative:
    // only single-item captures at very high similarity.
    if (parsed.items.length === 1 && nearest[0] && nearest[0].score >= 0.93) {
      const c = candidates.find((x) => x.id === nearest[0].id);
      if (c) parsed.items[0].matchItemId = c.id;
    }
  }

  // 4. Act on each segmented item independently (§10.2).
  const created: ItemView[] = [];
  const boosted: { item: ItemView; appendedText: string }[] = [];

  for (const p of parsed.items) {
    const matched = p.matchItemId ? candidates.find((c) => c.id === p.matchItemId) : undefined;
    if (matched) {
      // Recapture-as-boost (§9.3): raise priority, append the new phrasing —
      // never synthesise a merged replacement. Visible + undoable (§10.1).
      const rawTexts: RawText[] = [...matched.rawTexts, { ts: nowIso(), text: p.title }];
      await updateItemFields(db, matched.id, {
        priority_boost: matched.priorityBoost + RECAPTURE_BOOST,
        boost_updated_at: nowIso(),
        raw_texts: JSON.stringify(rawTexts),
      });
      await syncFts(db, matched.id, matched.title, rawTexts.map((r) => r.text).join('\n'));
      await logEvent(db, 'ai', 'recaptured', {
        itemId: matched.id,
        payload: { appendedText: p.title, boost: RECAPTURE_BOOST, captureId },
      });
      const fresh = await getItem(db, matched.id);
      if (fresh) boosted.push({ item: toItemView(fresh, now), appendedText: p.title });
      continue;
    }

    // Deterministic date resolution (§12): the model only extracted phrases.
    const deadline = p.deadlinePhrase ? resolveDatePhrase(p.deadlinePhrase, ref, tz) : null;
    const eventAt = p.eventAtPhrase ? resolveDatePhrase(p.eventAtPhrase, ref, tz) : null;

    const itemEmbedding = await embed(env, p.title);
    const id = await insertItem(db, {
      type: p.type,
      title: p.title,
      rawText: { ts: nowIso(), text: parsed.items.length > 1 ? p.title : req.text },
      deadline: p.type === 'DO' ? deadline?.iso ?? null : null,
      deadlineHardness: p.type === 'DO' && deadline ? p.deadlineHardness ?? 'hard' : null,
      cadence: p.type === 'KNOW' ? null : p.cadence,
      optionality: p.optionality,
      effort: p.effort,
      pingNatured: p.type === 'DO' ? p.pingNatured : false,
      eventAt: p.type === 'HAPPEN' ? eventAt?.iso ?? null : null,
      alertLeadMinutes: p.alertLeadMinutes,
      priorityBase: PRIORITY_BASE[p.priority] ?? 0.5,
      parseConfidence: parsed.confidence === 'high' ? 0.9 : 0.4,
      captureId,
      embedding: itemEmbedding,
    });
    const themes = await setItemThemes(db, id, p.themes, 'ai');
    await logEvent(db, 'ai', 'created', {
      itemId: id,
      payload: { type: p.type, title: p.title, themes: themes.map((t) => t.name), captureId },
    });
    const item = await getItem(db, id);
    if (item) created.push(toItemView(item, now));
  }

  // 5. Nudge only when the parse warrants it (§10.1).
  const nudge: CaptureResponse['nudge'] = boosted.length
    ? 'merge'
    : parsed.items.length > 1
      ? 'split'
      : parsed.confidence === 'low'
        ? 'low-confidence'
        : null;

  return { captureId, created, boosted, nudge };
}

// Undo a recapture-merge (§10.3): revert the boost AND split the appended
// phrasing back out into its own fresh item — a compensating event, not an erasure.
export async function undoRecapture(env: Env, itemId: string, appendedText: string): Promise<ItemView | null> {
  const db = env.DB;
  const now = new Date();
  const item = await getItem(db, itemId);
  if (!item) return null;

  const idx = item.rawTexts.map((r) => r.text).lastIndexOf(appendedText);
  const rawTexts = idx >= 0 ? [...item.rawTexts.slice(0, idx), ...item.rawTexts.slice(idx + 1)] : item.rawTexts;
  await updateItemFields(db, itemId, {
    priority_boost: Math.max(0, item.priorityBoost - RECAPTURE_BOOST),
    raw_texts: JSON.stringify(rawTexts),
  });
  await syncFts(db, itemId, item.title, rawTexts.map((r) => r.text).join('\n'));

  // Recreate the appended phrasing as a fresh item via the normal parse path,
  // skipping recapture-match so it cannot immediately re-merge.
  const parsed = heuristicParse(appendedText, now);
  const p = parsed.items[0];
  const embedding = await embed(env, p.title);
  const newItemId = await insertItem(db, {
    type: p.type,
    title: p.title,
    rawText: { ts: nowIso(), text: appendedText },
    deadline: p.deadlinePhrase ? resolveDatePhrase(p.deadlinePhrase, now)?.iso ?? null : null,
    deadlineHardness: p.deadlineHardness,
    cadence: p.cadence,
    optionality: p.optionality,
    effort: p.effort,
    pingNatured: p.pingNatured,
    priorityBase: PRIORITY_BASE[p.priority] ?? 0.5,
    parseConfidence: 0.4,
    embedding,
  });
  await setItemThemes(db, newItemId, item.themes.map((t) => t.name), 'ai');

  await logEvent(db, 'user', 'recapture_undone', {
    itemId,
    payload: { appendedText, newItemId },
  });
  const fresh = await getItem(db, newItemId);
  return fresh ? toItemView(fresh, now) : null;
}

// ---------- The cheap-tier parse call ----------

interface LlmParsedItem extends Omit<ParsedItem, 'matchItemId'> {
  matchItemId: string | null;
  matchConfidence?: 'high' | 'low';
}

async function llmParse(
  env: Env,
  text: string,
  ref: Date,
  tzOffsetMinutes: number | undefined,
  candidates: Item[],
): Promise<ParseResult> {
  const themes = await listThemes(env.DB);
  const profile = await getState(env.DB, 'profile_text');

  const localDate = tzOffsetMinutes !== undefined ? new Date(ref.getTime() + tzOffsetMinutes * 60_000) : ref;
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][localDate.getUTCDay()];

  const system = `You are Smart Capture, the parsing layer of "Memory", a personal memory-aid app for a user with ADHD. You turn one raw capture into structured item proposals. Reply with ONLY a JSON object, no prose.

BACKEND TYPES (never shown to the user):
- DO: something the user does; has a done-state. Tasks, goals, reminders.
- KNOW: a fact the user knows; never "done". ("Sarah is allergic to nuts")
- HAPPEN: occurs at a time, then is past. Appointments, visits, events.

SEGMENTATION: split by distinct intent/referent, not punctuation. One action with several objects stays ONE item ("buy milk, eggs, bread" = one). Genuinely separate intents split ("call the dentist, Sarah's allergic to nuts" = a DO + a KNOW). Lean toward splitting on genuine ambiguity — under-segmentation is the lossier failure.

FOR EACH ITEM emit:
- "type": "DO" | "KNOW" | "HAPPEN"
- "title": a clean short imperative/declarative restatement (keep the user's vocabulary; do not embellish)
- "deadlinePhrase": for a DO with a due date, the EXACT date/time phrase from the text, else null. Do NOT compute dates yourself.
- "deadlineHardness": "hard" | "soft" | null. A plainly-stated date defaults to "hard"; explicit low-pressure phrasing ("ideally", "sometime", "no rush") makes it "soft".
- "cadence": recurrence as {"freq":"daily"|"weekly"|"monthly"|"yearly","interval":N,"byWeekday":[0-6 Sun=0]?,"byMonthDay":N?,"atTime":"HH:MM"?} or null.
- "optionality": "must" | "nice" — must-do vs nice-to-do, inferred from phrasing ("maybe", "if I get to it" → "nice"). Orthogonal to priority.
- "effort": "quick" | "medium" | "large" — coarse magnitude ("do taxes" is large, "call grandma" is quick).
- "pingNatured": true if this DO is a nudge to do a small thing at a moment rather than a deliverable ("remind me to take the bins out" → true; "finish the report by Friday" → false). Only for DO.
- "eventAtPhrase": for HAPPEN, the EXACT date/time phrase, else null.
- "alertLeadMinutes": only if the user explicitly asked when to be alerted ("remind me the night before" → 720), else null.
- "priority": "low" | "medium" | "high". Default "medium"; "this is really important" → "high"; a casual aside → "low".
- "themes": 1-3 theme names. You are the librarian of an EMERGENT taxonomy: strongly prefer reusing an existing theme; coin a new short name (1-2 words, e.g. "Home", "Health", "Sarah") only when nothing fits. Multi-theme is encouraged when genuinely apt.
- "matchItemId": if this capture refers to the SAME thing as one of the existing candidate items (same referent/intent, phrasing-independent), that item's id — else null. BE CONSERVATIVE: a false merge is worse than a missed match. "Sarah likes soy milk" vs "Sarah hates soy milk" are DIFFERENT. Only match on high-confidence sameness.

TOP-LEVEL: {"items":[...], "confidence":"high"|"low"} — "low" if the capture was ambiguous, hard to segment, or you guessed on anything load-bearing.`;

  const user = JSON.stringify({
    capture: text,
    localNow: ref.toISOString(),
    userLocalWeekday: weekday,
    existingThemes: themes.map((t) => t.name),
    candidateItems: candidates.map((c) => ({
      id: c.id,
      type: c.type,
      title: c.title,
      phrasings: c.rawTexts.map((r) => r.text).slice(-3),
    })),
    userProfileNotes: profile ?? null,
  });

  // Generous output budget: a bulk-pasted list can segment into dozens of items.
  const out = await anthropicJson<{ items: LlmParsedItem[]; confidence: 'high' | 'low' }>(
    env,
    env.CAPTURE_MODEL,
    system,
    user,
    16384,
  );

  const items: ParsedItem[] = (out.items ?? []).map((p) => ({
    type: p.type === 'KNOW' || p.type === 'HAPPEN' ? p.type : 'DO',
    title: String(p.title ?? text).slice(0, 300),
    deadlinePhrase: p.deadlinePhrase ?? null,
    deadlineHardness: p.deadlineHardness === 'soft' ? 'soft' : p.deadlinePhrase ? 'hard' : null,
    cadence: sanitizeCadence(p.cadence),
    optionality: p.optionality === 'nice' ? 'nice' : 'must',
    effort: p.effort === 'quick' || p.effort === 'large' ? p.effort : 'medium',
    pingNatured: !!p.pingNatured,
    eventAtPhrase: p.eventAtPhrase ?? null,
    alertLeadMinutes:
      typeof p.alertLeadMinutes === 'number' && p.alertLeadMinutes > 0
        ? Math.min(Math.round(p.alertLeadMinutes), 14 * 24 * 60)
        : null,
    priority: p.priority === 'low' || p.priority === 'high' ? p.priority : 'medium',
    themes: Array.isArray(p.themes) ? p.themes.map(String).slice(0, 3) : [],
    matchItemId: p.matchItemId && candidates.some((c) => c.id === p.matchItemId) ? p.matchItemId : null,
  }));

  if (!items.length) return heuristicParse(text, ref, tzOffsetMinutes);
  return { items, confidence: out.confidence === 'low' ? 'low' : 'high' };
}

// Model output feeds the scheduler (occurrence math, §11.4) — never trust the
// shape blindly.
function sanitizeCadence(c: unknown): ParsedItem['cadence'] {
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  const freq = o.freq;
  if (freq !== 'daily' && freq !== 'weekly' && freq !== 'monthly' && freq !== 'yearly') return null;
  const interval = typeof o.interval === 'number' && o.interval >= 1 ? Math.min(Math.round(o.interval), 365) : 1;
  const byWeekday = Array.isArray(o.byWeekday)
    ? o.byWeekday.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6).slice(0, 7)
    : undefined;
  const byMonthDay =
    typeof o.byMonthDay === 'number' && o.byMonthDay >= 1 && o.byMonthDay <= 31 ? Math.round(o.byMonthDay) : undefined;
  const atTime = typeof o.atTime === 'string' && /^\d{1,2}:\d{2}$/.test(o.atTime) ? o.atTime : undefined;
  return {
    freq,
    interval,
    ...(byWeekday?.length ? { byWeekday } : {}),
    ...(byMonthDay ? { byMonthDay } : {}),
    ...(atTime ? { atTime } : {}),
  };
}
