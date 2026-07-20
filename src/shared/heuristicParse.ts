import * as chrono from 'chrono-node';
import type { BackendType, Cadence, ParsedItem, ParseResult, PriorityLevel } from './types';
import { expandBareOrdinals, inferHardness, inferOptionality } from './dates';

// Deterministic fallback parser, used when no LLM is configured (local dev,
// missing key) so capture always works. Intentionally modest: no intent-based
// segmentation (newline-split only), keyword classification, chrono dates.
// The real Smart Capture path is the LLM parse (worker/ai.ts); both resolve
// date phrases deterministically (§12).

const PING_CUES = /\b(remind me|don'?t forget|remember to|make sure (i|to))\b/i;
const KNOW_CUES = /\b(remember that|note that|note:|fyi|is allergic|likes|hates|loves|prefers|lives at|birthday is|is called)\b/i;
const HAPPEN_CUES = /\b(appointment|meeting|visit|visits|arrives|flight|party|dinner with|lunch with|concert|wedding|dentist at|doctor'?s)\b/i;
const HIGH_PRIORITY_CUES = /\b(really important|very important|crucial|critical|urgent|must not forget|asap|top priority)\b/i;
const LOW_PRIORITY_CUES = /\b(minor|trivial|no big deal|whenever|low priority|casual)\b/i;
const LARGE_EFFORT_CUES = /\b(project|taxes|renovate|plan (the|a|my)|organize (the|a|my)|write (the|a|my) (report|thesis|book)|deep clean)\b/i;
const QUICK_EFFORT_CUES = /\b(call|text|email|ping|book|take out|water|feed|send)\b/i;

export function parseCadencePhrase(text: string): Cadence | null {
  const t = text.toLowerCase();
  let m: RegExpMatchArray | null;
  if (/\b(every ?day|daily|each day|\/day|per day|a day)\b/.test(t)) return { freq: 'daily', interval: 1 };
  if ((m = t.match(/\bevery (\d+) days?\b/))) return { freq: 'daily', interval: parseInt(m[1], 10) };
  if (/\bevery other day\b/.test(t)) return { freq: 'daily', interval: 2 };
  const WEEKDAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  if ((m = t.match(/\bevery (sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/)))
    return { freq: 'weekly', interval: 1, byWeekday: [WEEKDAYS[m[1]]] };
  if ((m = t.match(/\bon (sunday|monday|tuesday|wednesday|thursday|friday|saturday)s\b/)))
    return { freq: 'weekly', interval: 1, byWeekday: [WEEKDAYS[m[1]]] };
  if (/\b(every ?week|weekly|per week|a week|\/week)\b/.test(t)) return { freq: 'weekly', interval: 1 };
  if ((m = t.match(/\bevery (\d+) weeks?\b/))) return { freq: 'weekly', interval: parseInt(m[1], 10) };
  if (/\bevery other week\b/.test(t)) return { freq: 'weekly', interval: 2 };
  if (/\b(every ?month|monthly|per month|a month|\/month)\b/.test(t)) return { freq: 'monthly', interval: 1 };
  if ((m = t.match(/\bevery (\d+) months?\b/))) return { freq: 'monthly', interval: parseInt(m[1], 10) };
  if (/\b(every ?year|yearly|annually)\b/.test(t)) return { freq: 'yearly', interval: 1 };
  return null;
}

function inferType(text: string, hasDate: boolean): BackendType {
  if (PING_CUES.test(text)) return 'DO';
  if (KNOW_CUES.test(text)) return 'KNOW';
  if (HAPPEN_CUES.test(text) && hasDate) return 'HAPPEN';
  // A bare statement with no verb-ish action cue and no date reads as a fact.
  return 'DO';
}

function inferPriority(text: string): PriorityLevel {
  if (HIGH_PRIORITY_CUES.test(text)) return 'high';
  if (LOW_PRIORITY_CUES.test(text)) return 'low';
  return 'medium';
}

function inferEffort(text: string): 'quick' | 'medium' | 'large' {
  if (LARGE_EFFORT_CUES.test(text)) return 'large';
  if (QUICK_EFFORT_CUES.test(text)) return 'quick';
  return 'medium';
}

function cleanTitle(text: string): string {
  let t = text.trim();
  t = t.replace(/^(remind me to|remember to|don'?t forget to|remember that|note that|note:|todo:?)\s*/i, '');
  // Tidy the seam left where a date phrase was removed mid-sentence:
  // "do taxes by , really important" → "do taxes, really important".
  t = t.replace(/\s+(at|on|by|before|until|from)(\s+(the|a|an|this|next))?\s*(?=[,.;]|$)/gi, '');
  t = t.replace(/\s*,\s*,/g, ',').replace(/^[\s,.;]+|[\s,.;]+$/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length ? t[0].toUpperCase() + t.slice(1) : text.trim();
}

export function heuristicParse(raw: string, ref: Date, tzOffsetMinutes?: number): ParseResult {
  const segments = raw
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const items: ParsedItem[] = segments.map((text) => {
    const reference = tzOffsetMinutes === undefined ? ref : { instant: ref, timezone: tzOffsetMinutes };
    let chronoResults = chrono.parse(text, reference, { forwardDate: true });
    if (!chronoResults.length) {
      // Bare day ordinals ("the 20th to the 25th") need month expansion.
      const expanded = expandBareOrdinals(text, ref, tzOffsetMinutes ?? 0);
      if (expanded !== text) chronoResults = chrono.parse(expanded, reference, { forwardDate: true });
    }
    const datePhrase = chronoResults.length ? chronoResults[0].text : null;
    const type = inferType(text, !!datePhrase);
    const cadence = type === 'KNOW' ? null : parseCadencePhrase(text);
    const ping = PING_CUES.test(text) && !LARGE_EFFORT_CUES.test(text);
    return {
      type,
      title: cleanTitle(datePhrase && type !== 'KNOW' ? text.replace(datePhrase, '').replace(/\s+(at|on|by|before|until)\s*$/i, '') : text),
      deadlinePhrase: type === 'DO' && !cadence ? datePhrase : null,
      deadlineHardness: type === 'DO' && datePhrase ? inferHardness(text) : null,
      cadence,
      optionality: inferOptionality(text),
      effort: inferEffort(text),
      pingNatured: ping,
      eventAtPhrase: type === 'HAPPEN' ? datePhrase : null,
      alertLeadMinutes: null,
      priority: inferPriority(text),
      themes: [],
      matchItemId: null,
    };
  });
  return {
    items: items.length ? items : [emptyFallback(raw)],
    // The heuristic parser is always low-confidence — it exists to be reviewed.
    confidence: 'low',
  };
}

function emptyFallback(raw: string): ParsedItem {
  return {
    type: 'DO',
    title: cleanTitle(raw),
    deadlinePhrase: null,
    deadlineHardness: null,
    cadence: null,
    optionality: 'must',
    effort: 'medium',
    pingNatured: false,
    eventAtPhrase: null,
    alertLeadMinutes: null,
    priority: 'medium',
    themes: [],
    matchItemId: null,
  };
}
