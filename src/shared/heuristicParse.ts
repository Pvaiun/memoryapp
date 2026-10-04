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

const WEEKDAY_NUM: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const WEEKDAY = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
// One or more weekdays as a list: "monday", "mondays and thursdays", "mon, wed & fri".
const WEEKDAY_LIST = `${WEEKDAY}s?(?:(?:\\s*,\\s*|\\s+and\\s+|\\s*&\\s*)${WEEKDAY}s?)*`;

// The N in "every N weeks", however it's said: "3", "3rd", "three", "third",
// "other", "couple of".
const COUNT_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  other: 2, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12,
};
const COUNT = `(\\d+(?:st|nd|rd|th)?|couple(?: of)?|${Object.keys(COUNT_WORDS).join('|')})`;
const UNIT_FREQ: Record<string, Cadence['freq']> = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' };

function countOf(word: string): number {
  const n = /^\d/.test(word) ? parseInt(word, 10) : word.startsWith('couple') ? 2 : COUNT_WORDS[word] ?? 1;
  return Math.min(Math.max(1, n), 365);
}

// Where in the text the cadence was said, so the parser can keep it out of
// the title and stop chrono reading "every 3 weeks" as "in 3 weeks". index/
// length cover the rhythm phrase itself; detailSpans cover the day details
// ("on Mon and Thu", "on the 15th") that only make sense as part of it.
export interface CadenceMatch {
  cadence: Cadence;
  index: number;
  length: number;
  detailSpans: [number, number][];
}

export function matchCadencePhrase(text: string): CadenceMatch | null {
  const t = text.toLowerCase();
  const found = matchBase(t);
  if (!found) return null;
  const { cadence } = found;
  // A weekly rhythm's days are the weekdays said as part of it — in the rhythm
  // phrase ("every Monday and Thursday") or an "on …" list after it ("every 2
  // weeks on Sundays") — not any weekday elsewhere ("…, bins due Friday").
  if (cadence.freq === 'weekly') {
    const on = t.match(new RegExp(`\\bon ${WEEKDAY_LIST}\\b`));
    if (on) found.detailSpans.push([on.index!, on.index! + on[0].length]);
    const said = t.slice(found.index, found.index + found.length) + ' ' + (on?.[0] ?? '');
    const days = [...new Set([...said.matchAll(new RegExp(`\\b${WEEKDAY}s?\\b`, 'g'))].map((x) => WEEKDAY_NUM[x[1]]))];
    if (days.length) cadence.byWeekday = days.sort((a, b) => a - b);
  }
  // A monthly rhythm pinned to a date: "every 3 months on the 15th".
  if (cadence.freq === 'monthly') {
    const day = t.match(/\b(?:on )?the (\d{1,2})(?:st|nd|rd|th)\b/);
    if (day && +day[1] >= 1 && +day[1] <= 31) {
      cadence.byMonthDay = +day[1];
      found.detailSpans.push([day.index!, day.index! + day[0].length]);
    }
  }
  return found;
}

function matchBase(t: string): CadenceMatch | null {
  let m: RegExpMatchArray | null;
  const hit = (cadence: Cadence): CadenceMatch => ({ cadence, index: m!.index!, length: m![0].length, detailSpans: [] });
  // Explicit intervals first, so "every 3 weeks" is never read as plain weekly.
  if ((m = t.match(new RegExp(`\\bevery other ${WEEKDAY_LIST}\\b`)))) return hit({ freq: 'weekly', interval: 2 });
  if ((m = t.match(new RegExp(`\\b(?:once )?every ${COUNT} (day|week|month|year)s?\\b`))))
    return hit({ freq: UNIT_FREQ[m[2]], interval: countOf(m[1]) });
  if ((m = t.match(/\b(bi-?weekly|fortnightly|(?:once )?(?:every|a) fortnight)\b/))) return hit({ freq: 'weekly', interval: 2 });
  if ((m = t.match(/\b(quarterly|(?:once )?(?:every|a) quarter)\b/))) return hit({ freq: 'monthly', interval: 3 });
  if ((m = t.match(/\b(semi-?annually|twice a year)\b/))) return hit({ freq: 'monthly', interval: 6 });
  if ((m = t.match(/\b(every ?day|daily|each day|\/day|per day|a day)\b/))) return hit({ freq: 'daily', interval: 1 });
  if ((m = t.match(new RegExp(`\\bevery ${WEEKDAY_LIST}\\b`)))) return hit({ freq: 'weekly', interval: 1 });
  if ((m = t.match(new RegExp(`\\bon ${WEEKDAY}s\\b`)))) return hit({ freq: 'weekly', interval: 1 });
  if ((m = t.match(/\b(every ?week|weekly|per week|a week|\/week)\b/))) return hit({ freq: 'weekly', interval: 1 });
  if ((m = t.match(/\b(every ?month|monthly|per month|a month|\/month)\b/))) return hit({ freq: 'monthly', interval: 1 });
  if ((m = t.match(/\b(every ?year|yearly|annually)\b/))) return hit({ freq: 'yearly', interval: 1 });
  return null;
}

export function parseCadencePhrase(text: string): Cadence | null {
  return matchCadencePhrase(text)?.cadence ?? null;
}

// Calendar-worthiness fallback when no semantics are available (heuristic
// parse, or the LLM omitted the field): frequency is the best proxy —
// daily-scale rhythms are chores/habits, weekly-and-slower recurrences are
// more likely commitments. The LLM decides semantically; the user overrides.
export function defaultCalendarWorthy(cadence: Cadence | null): boolean {
  return !cadence || cadence.freq !== 'daily';
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
  t = t.replace(/\s+(at|on|by|before|until|from|every|each)(\s+(the|a|an|this|next))?\s*(?=[,.;]|$)/gi, '');
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
    // chrono reads the "3 weeks" in "every 3 weeks" as a date three weeks out;
    // a hit that lies wholly inside the cadence phrase is the rhythm, not a date.
    const cadenceMatch = matchCadencePhrase(text);
    const cadenceEnd = cadenceMatch ? cadenceMatch.index + cadenceMatch.length : -1;
    const dateResults = cadenceMatch
      ? chronoResults.filter((r) => r.index < cadenceMatch.index || r.index + r.text.length > cadenceEnd)
      : chronoResults;
    const dateResult = dateResults[0] ?? null;
    const datePhrase = dateResult?.text ?? null;
    const type = inferType(text, !!datePhrase);
    let cadence = type === 'KNOW' ? null : cadenceMatch?.cadence ?? null;
    // A recurring DO with a stated clock time ("every Thursday at 8pm") anchors
    // its occurrences there. chrono's components are wall-clock as written —
    // exactly the user-local "HH:MM" cadence.atTime wants.
    const timed = dateResults.find((r) => r.start.isCertain('hour'));
    if (cadence && timed) {
      const h = timed.start.get('hour') ?? 0;
      const m = timed.start.get('minute') ?? 0;
      cadence = { ...cadence, atTime: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
    }
    // The title drops the date phrase, the rhythm's day details, and an
    // "every …" rhythm phrase (other rhythm wordings — "daily", "twice a
    // year" — read fine left in).
    const cuts: [number, number][] = [];
    if (dateResult && type !== 'KNOW') cuts.push([dateResult.index, dateResult.index + dateResult.text.length]);
    if (cadence && cadenceMatch) {
      cuts.push(...cadenceMatch.detailSpans);
      if (/^(once )?every\b/i.test(text.slice(cadenceMatch.index, cadenceEnd))) cuts.push([cadenceMatch.index, cadenceEnd]);
    }
    const ping = PING_CUES.test(text) && !LARGE_EFFORT_CUES.test(text);
    return {
      type,
      title: cleanTitle(cuts.length ? cutSpans(text, cuts).replace(/\s+(at|on|by|before|until)\s*$/i, '') : text),
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
      affect: [],
      calendarWorthy: defaultCalendarWorthy(cadence),
      matchItemId: null,
    };
  });
  return {
    items: items.length ? items : [emptyFallback(raw)],
    // The heuristic parser is always low-confidence — it exists to be reviewed.
    confidence: 'low',
  };
}

// Remove the given [start, end) ranges (overlaps allowed) from text.
function cutSpans(text: string, spans: [number, number][]): string {
  let out = '';
  let pos = 0;
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (s > pos) out += text.slice(pos, s);
    pos = Math.max(pos, e);
  }
  return out + text.slice(pos);
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
    affect: [],
    calendarWorthy: true,
    matchItemId: null,
  };
}
