import * as chrono from 'chrono-node';

// Deterministic date resolution (§12): AI extracts the date *phrase*;
// converting phrase → calendar date happens here, deterministically.

export interface ResolvedDate {
  iso: string; // ISO datetime
  hasTime: boolean; // whether the phrase specified a time of day
  endIso?: string; // for range phrases ("July 20 to July 25")
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const HAS_MONTH_OR_RELATIVE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|today|tomorrow|tonight|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[/.-]\d{1,2})/i;

// chrono cannot parse bare day ordinals ("the 20th", "the 20th to the 25th") —
// they need a month. Expand them deterministically against the user's local
// date: an ordinal on/after today's day-of-month means this month, else next.
export function expandBareOrdinals(phrase: string, ref: Date, tzOffsetMinutes = 0): string {
  if (HAS_MONTH_OR_RELATIVE.test(phrase)) return phrase;
  if (!/\d{1,2}(st|nd|rd|th)\b/i.test(phrase)) return phrase;
  const local = new Date(ref.getTime() + tzOffsetMinutes * 60_000);
  const refDay = local.getUTCDate();
  const refMonth = local.getUTCMonth();
  const refYear = local.getUTCFullYear();
  return phrase.replace(/\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/gi, (_m, d: string) => {
    const day = parseInt(d, 10);
    if (day < 1 || day > 31) return _m;
    let month = refMonth;
    let year = refYear;
    if (day < refDay) {
      month = (refMonth + 1) % 12;
      if (month === 0) year = refYear + 1;
    }
    return `${MONTHS[month]} ${day} ${year}`;
  });
}

// tzOffsetMinutes: the client's UTC offset in minutes (Date#getTimezoneOffset
// sign-flipped, i.e. UTC+2 → 120). The server runs in UTC, so "tomorrow" and
// "next Tuesday" must be resolved against the *user's* calendar, not the server's.
// Before this hour (user-local), relative dates resolve against the previous
// day: at 12:31am, "tomorrow" means the morning a few hours away — the same
// calendar day — not the day after it. 5am is the sleep-cycle boundary.
export const EARLY_MORNING_CUTOFF_MINUTES = 5 * 60;

export function resolveDatePhrase(phrase: string, ref: Date, tzOffsetMinutes?: number): ResolvedDate | null {
  const tz = tzOffsetMinutes ?? 0;

  // Night-owl rule: before the 5am cutoff, shift the reference to 11pm of the
  // previous local day so "tomorrow"/"tonight" follow the sleep cycle, not the
  // calendar. forwardDate keeps already-past results from resolving backwards.
  let effRef = ref;
  const local = new Date(ref.getTime() + tz * 60_000);
  const minutesIntoDay = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (minutesIntoDay < EARLY_MORNING_CUTOFF_MINUTES) {
    effRef = new Date(ref.getTime() - (minutesIntoDay + 60) * 60_000);
  }

  const reference = tzOffsetMinutes === undefined ? effRef : { instant: effRef, timezone: tz };
  let results = chrono.parse(phrase, reference, { forwardDate: true });
  if (!results.length) {
    // Fallback: expand bare day ordinals ("the 20th to the 25th") that chrono
    // cannot read without a month, then retry. Still fully deterministic.
    const expanded = expandBareOrdinals(phrase, effRef, tz);
    if (expanded === phrase) return null;
    results = chrono.parse(expanded, reference, { forwardDate: true });
    if (!results.length) return null;
  }
  const r = results[0];
  const hasTime = r.start.isCertain('hour');
  // Date-only phrases anchor to NOON local — "tomorrow" captured at 1:48am
  // must not produce a 1:48am deadline.
  const iso = hasTime ? r.start.date().toISOString() : localNoonIso(r.start.date(), tz);
  let endIso: string | undefined;
  if (r.end) {
    endIso = r.end.isCertain('hour') ? r.end.date().toISOString() : localNoonIso(r.end.date(), tz);
  }
  return { iso, hasTime, ...(endIso ? { endIso } : {}) };
}

function localNoonIso(d: Date, tzOffsetMinutes: number): string {
  const local = new Date(d.getTime() + tzOffsetMinutes * 60_000);
  const noonLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 12, 0, 0);
  return new Date(noonLocal - tzOffsetMinutes * 60_000).toISOString();
}

// Soft-deadline cue words (§3.1): a plainly-stated date defaults to *hard*;
// explicit low-pressure phrasing softens it.
const SOFT_CUES = /\b(ideally|sometime|some time|no rush|eventually|at some point|when i can|if i can|would be nice|hopefully|loosely|roughly|-ish)\b/i;

export function inferHardness(text: string): 'hard' | 'soft' {
  return SOFT_CUES.test(text) ? 'soft' : 'hard';
}

// Optionality cues (§3.1): inferred from phrasing ("maybe", "if I get to it").
const OPTIONAL_CUES = /\b(maybe|might|if i get to it|if i have time|would be nice|nice to|optional|no big deal|not urgent|someday|could)\b/i;

export function inferOptionality(text: string): 'must' | 'nice' {
  return OPTIONAL_CUES.test(text) ? 'nice' : 'must';
}

export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
