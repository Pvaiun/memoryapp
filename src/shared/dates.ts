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

// The five windows a day is divided into, in order. The capture model picks a
// window; this table is the only place that turns one into an hour. Code never
// tries to read a time of day out of the text — "after work", "once the kids
// are down" and "before standup" are language, and classifying them is the
// model's job, not a regex's.
export const DAY_PARTS = ['morning', 'midday', 'afternoon', 'evening', 'night'] as const;
export type DayPart = (typeof DAY_PARTS)[number];

const DAY_PART_HOURS: Record<DayPart, number> = {
  morning: 9,
  midday: 12,
  afternoon: 16,
  evening: 19,
  night: 22,
};

// Each window runs until the next one starts; night runs to the end of the day.
function windowEnd(part: DayPart): number {
  const next = DAY_PARTS[DAY_PARTS.indexOf(part) + 1];
  return next ? DAY_PART_HOURS[next] : 24;
}

// The window an hour belongs to — the inverse of the table above, so a stored
// anchor always describes itself with the word it came from.
export function dayPartWord(localHour: number): DayPart {
  let word: DayPart = DAY_PARTS[0];
  for (const p of DAY_PARTS) if (localHour >= DAY_PART_HOURS[p]) word = p;
  return word;
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
  // must not produce a 1:48am deadline. A window named in the text reaches us
  // as the model's dayPart, applied by withDayPart once we're back in capture.
  const iso = hasTime ? r.start.date().toISOString() : localNoonIso(r.start.date(), tz);
  let endIso: string | undefined;
  if (r.end) {
    endIso = r.end.isCertain('hour') ? r.end.date().toISOString() : localNoonIso(r.end.date(), tz);
  }
  return { iso, precision: hasTime ? 'time' : 'day', ...(endIso ? { endIso } : {}) };
}

function localHourIso(d: Date, tzOffsetMinutes: number, hour: number, minute: number): string {
  const local = new Date(d.getTime() + tzOffsetMinutes * 60_000);
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute, 0);
  return new Date(wall - tzOffsetMinutes * 60_000).toISOString();
}

function localNoonIso(d: Date, tzOffsetMinutes: number): string {
  return localHourIso(d, tzOffsetMinutes, 12, 0);
}

// A window anchors at its start hour — unless the capture is already inside it,
// which would make the item overdue the moment it was written ("do the dishes
// tonight", typed at 8pm). Slide to the window's last minute instead; if that
// has passed too, the anchor stands as written.
function dayPartIso(d: Date, tzOffsetMinutes: number, part: DayPart, ref: Date): string {
  const at = localHourIso(d, tzOffsetMinutes, DAY_PART_HOURS[part], 0);
  if (new Date(at).getTime() > ref.getTime()) return at;
  const last = localHourIso(d, tzOffsetMinutes, windowEnd(part) - 1, 59);
  return new Date(last).getTime() > ref.getTime() ? last : at;
}

// Place a day-only resolution in the window the capture model picked. This is
// the one way a time of day other than noon gets set without a stated clock
// time — and it can only ever land on a window start, never an invented hour.
// A stated clock time is already 'time' precision, so it is never touched.
export function withDayPart(
  resolved: ResolvedDate | null,
  part: DayPart | null,
  ref: Date,
  tzOffsetMinutes?: number,
): ResolvedDate | null {
  if (!resolved || !part || resolved.precision !== 'day') return resolved;
  if (!(part in DAY_PART_HOURS)) return resolved;
  return { ...resolved, iso: dayPartIso(new Date(resolved.iso), tzOffsetMinutes ?? 0, part, ref), precision: 'daypart' };
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

// Recovery net for dropped clock times: when the extracted phrase resolved
// date-only (noon anchor) but the item's own raw text carries a time on the
// SAME local day ("put laundry away before 3:00 p.m." → phrase "today"),
// take the time from the source. Same-day guard keeps unrelated dates in
// multi-intent text from hijacking it.
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
