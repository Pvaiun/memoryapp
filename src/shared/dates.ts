import * as chrono from 'chrono-node';

// Deterministic date resolution (§12): AI extracts the date *phrase*;
// converting phrase → calendar date happens here, deterministically.

// How precisely the user pinned the moment. The stored ISO is always a single
// instant — an app needs one to sort, compare and alert on — but the precision
// says how much of it the user actually meant, so the UI never reads a clock
// time back to someone who only said "evening".
export type TimePrecision = 'time' | 'daypart' | 'day';

export interface ResolvedDate {
  iso: string; // ISO datetime
  precision: TimePrecision;
  endIso?: string; // for range phrases ("July 20 to July 25")
}

export const DAY_PARTS = ['morning', 'afternoon', 'evening', 'night'] as const;
export type DayPart = (typeof DAY_PARTS)[number];

// Parts of the day, as anchor hours in the user's local clock. chrono knows
// these words but reports isCertain('hour') === false for them, so before this
// table "tomorrow evening" fell through to the date-only noon anchor — an
// evening errand sorted ahead of a 3pm meeting and read as "due at 12pm".
//
// `hour` is where the part is anchored; `until` is the hour it stops making
// sense, used when the capture happens mid-part ("tonight" typed at 8pm must
// not land at 7pm and read as already overdue).
interface DayPartAnchor {
  part: DayPart;
  hour: number;
  minute: number;
  until: number;
}

const DAY_PART_ANCHORS: Record<DayPart, DayPartAnchor> = {
  morning: { part: 'morning', hour: 9, minute: 0, until: 12 },
  afternoon: { part: 'afternoon', hour: 16, minute: 0, until: 17 },
  evening: { part: 'evening', hour: 19, minute: 0, until: 22 },
  night: { part: 'night', hour: 22, minute: 0, until: 23 },
};

// Ordered most-specific-first: "tonight" must be read before "night", "early
// morning" before "morning". Entries that aren't one of the four day parts
// (lunchtime, end of day) still resolve to an anchor — they're stated times of
// day, just not ones chrono marks certain.
const DAY_PART_PHRASES: [RegExp, DayPartAnchor][] = [
  [/\b(first thing|at dawn|early (in the )?morning)\b/i, { part: 'morning', hour: 8, minute: 30, until: 11 }],
  // Later than a plain "night", which now anchors at 10pm — there is nowhere
  // left to slide to, so this one stands as written.
  [/\b(late (at )?night|middle of the night|overnight)\b/i, { part: 'night', hour: 23, minute: 0, until: 23 }],
  [/\b(tonight|this evening)\b/i, DAY_PART_ANCHORS.evening],
  [/\b(end of (the )?(day|workday)|eod)\b/i, { part: 'evening', hour: 18, minute: 0, until: 20 }],
  [/\b(lunch ?time|over lunch|at lunch)\b/i, { part: 'afternoon', hour: 12, minute: 0, until: 14 }],
  [/\bmorning\b/i, DAY_PART_ANCHORS.morning],
  [/\bafternoon\b/i, DAY_PART_ANCHORS.afternoon],
  [/\bevening\b/i, DAY_PART_ANCHORS.evening],
  [/\bnight(-?time)?\b/i, DAY_PART_ANCHORS.night],
];

function matchDayPart(phrase: string): DayPartAnchor | null {
  for (const [re, anchor] of DAY_PART_PHRASES) if (re.test(phrase)) return anchor;
  return null;
}

// The word a 'daypart' anchor stands for, read back off the hour it landed on
// so a nudged time still describes itself correctly.
export function dayPartWord(localHour: number): DayPart | 'midday' {
  if (localHour < 11) return 'morning';
  if (localHour < 14) return 'midday';
  if (localHour < 18) return 'afternoon';
  if (localHour < 21) return 'evening';
  return 'night';
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
  // A stated clock time wins; failing that, a stated part of the day; failing
  // that, the phrase names a day and nothing more.
  const dayPart = r.start.isCertain('hour') ? null : matchDayPart(phrase);
  const precision: TimePrecision = r.start.isCertain('hour') ? 'time' : dayPart ? 'daypart' : 'day';
  // Date-only phrases anchor to NOON local — "tomorrow" captured at 1:48am
  // must not produce a 1:48am deadline.
  const iso =
    precision === 'time'
      ? r.start.date().toISOString()
      : dayPart
        ? dayPartIso(r.start.date(), tz, dayPart, ref)
        : localNoonIso(r.start.date(), tz);
  let endIso: string | undefined;
  if (r.end) {
    endIso = r.end.isCertain('hour') ? r.end.date().toISOString() : localNoonIso(r.end.date(), tz);
  }
  return { iso, precision, ...(endIso ? { endIso } : {}) };
}

function localHourIso(d: Date, tzOffsetMinutes: number, hour: number, minute: number): string {
  const local = new Date(d.getTime() + tzOffsetMinutes * 60_000);
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute, 0);
  return new Date(wall - tzOffsetMinutes * 60_000).toISOString();
}

function localNoonIso(d: Date, tzOffsetMinutes: number): string {
  return localHourIso(d, tzOffsetMinutes, 12, 0);
}

// A day part anchors at its hour — unless the capture is already inside it, in
// which case anchoring backwards would make the item overdue the moment it was
// written ("do the dishes tonight", typed at 8pm). Slide to the part's closing
// hour instead; only if that has passed too does the anchor stand as written.
function dayPartIso(d: Date, tzOffsetMinutes: number, anchor: DayPartAnchor, ref: Date): string {
  const at = localHourIso(d, tzOffsetMinutes, anchor.hour, anchor.minute);
  if (new Date(at).getTime() > ref.getTime()) return at;
  const closing = localHourIso(d, tzOffsetMinutes, anchor.until, 0);
  return new Date(closing).getTime() > ref.getTime() ? closing : at;
}

// Raise a day-only resolution to a part of the day the capture's *meaning*
// implies rather than states (§10: the parser may colour in a default, but it
// may never invent precision it didn't have). Never touches a resolution that
// already carries a stated time or day part.
export function withDayPart(
  resolved: ResolvedDate | null,
  part: DayPart | null,
  ref: Date,
  tzOffsetMinutes?: number,
): ResolvedDate | null {
  if (!resolved || !part || resolved.precision !== 'day') return resolved;
  const anchor = DAY_PART_ANCHORS[part];
  if (!anchor) return resolved;
  return { ...resolved, iso: dayPartIso(new Date(resolved.iso), tzOffsetMinutes ?? 0, anchor, ref), precision: 'daypart' };
}

// Items stored before time_precision existed carry null; the convention then
// was "local noon means no time was stated". (The old test compared the UTC
// string against 'T12:00:00', so it only ever fired for users actually in UTC —
// this reads the local wall clock and is right everywhere.)
export function inferPrecision(iso: string, stored: TimePrecision | null, tzOffsetMinutes: number): TimePrecision {
  if (stored) return stored;
  const local = new Date(new Date(iso).getTime() + tzOffsetMinutes * 60_000);
  return local.getUTCHours() === 12 && local.getUTCMinutes() === 0 && local.getUTCSeconds() === 0 ? 'day' : 'time';
}

// Recovery net for dropped times: when the extracted phrase resolved date-only
// (noon anchor) but the item's own raw text carries a clock time or a part of
// the day on the SAME local day ("put laundry away before 3:00 p.m." → phrase
// "today"; "grab milk tomorrow evening" → phrase "tomorrow"), take it from the
// source. Same-day guard keeps unrelated dates in multi-intent text from
// hijacking it.
export function refineWithSourceTime(
  resolved: ResolvedDate | null,
  sourceText: string,
  ref: Date,
  tzOffsetMinutes?: number,
): ResolvedDate | null {
  if (!resolved || resolved.precision !== 'day') return resolved;
  const fromSource = resolveDatePhrase(sourceText, ref, tzOffsetMinutes);
  if (!fromSource || fromSource.precision === 'day') return resolved;
  const tz = tzOffsetMinutes ?? 0;
  const localDay = (iso: string) => Math.floor((new Date(iso).getTime() + tz * 60_000) / 86_400_000);
  if (localDay(fromSource.iso) !== localDay(resolved.iso)) return resolved;
  return { ...resolved, iso: fromSource.iso, precision: fromSource.precision };
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

// ---------- Canonical sleep-cycle day math ----------
// The app has ONE answer to "what day is it": the sleep-cycle day, running
// 5am → 5am (EARLY_MORNING_CUTOFF_MINUTES). A 1am deadline belongs to the
// evening before it. Every day-distance the user sees — the Descent notch,
// the tile chip, the Brain's due=+Nd tokens, row date labels — must come
// from these helpers so two surfaces can never disagree about "4 days".

const DAY_MS = 86_400_000;

// The sleep-day index of a UTC instant, given the user's UTC offset in
// minutes (Date#getTimezoneOffset sign-flipped). Same arithmetic as
// completedWithinSleepDay/happeningToday.
export function sleepDayOf(msUtc: number, tzOffsetMinutes: number): number {
  return Math.floor((msUtc + (tzOffsetMinutes - EARLY_MORNING_CUTOFF_MINUTES) * 60_000) / DAY_MS);
}

// Whole sleep-days from `now` to `t` (negative = past). Fixed-offset flavour
// for the worker, which runs in UTC and receives the client's offset.
export function sleepDayDiff(t: number, now: number, tzOffsetMinutes: number): number {
  return sleepDayOf(t, tzOffsetMinutes) - sleepDayOf(now, tzOffsetMinutes);
}

// Browser flavour: reads each instant's own local offset, so a DST change
// between now and the target can't skew the count.
export function sleepDayDiffLocal(t: number, now: number): number {
  const idx = (ms: number) => sleepDayOf(ms, -new Date(ms).getTimezoneOffset());
  return idx(t) - idx(now);
}

export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The sleep-day the user is *in* right now, as the YYYY-MM-DD key the map is
// stored under. The client gets this from its own clock (api.ts localDay());
// the worker runs in UTC, so it shifts by the reported offset instead. Both
// must agree to the character or the scheduled rebuild builds a day the app
// then treats as stale.
export function sleepDayKey(msUtc: number, tzOffsetMinutes: number): string {
  const shifted = new Date(msUtc + (tzOffsetMinutes - EARLY_MORNING_CUTOFF_MINUTES) * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
