import * as chrono from 'chrono-node';

// Deterministic date resolution (§12): AI extracts the date *phrase*;
// converting phrase → calendar date happens here, deterministically.

export interface ResolvedDate {
  iso: string; // ISO datetime
  hasTime: boolean; // whether the phrase specified a time of day
}

// tzOffsetMinutes: the client's UTC offset in minutes (Date#getTimezoneOffset
// sign-flipped, i.e. UTC+2 → 120). The server runs in UTC, so "tomorrow" and
// "next Tuesday" must be resolved against the *user's* calendar, not the server's.
export function resolveDatePhrase(phrase: string, ref: Date, tzOffsetMinutes?: number): ResolvedDate | null {
  const reference = tzOffsetMinutes === undefined ? ref : { instant: ref, timezone: tzOffsetMinutes };
  const results = chrono.parse(phrase, reference, { forwardDate: true });
  if (!results.length) return null;
  const r = results[0];
  const date = r.start.date();
  // When no time is given, chrono implies 12:00 in the reference timezone —
  // a safe canonical anchor for date-only deadlines.
  const hasTime = r.start.isCertain('hour');
  return { iso: date.toISOString(), hasTime };
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
