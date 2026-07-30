import type { Cadence, ItemView } from '../shared/types';
import {
  cadenceGridGapMs,
  completedWithinSleepDay,
  nextAtTimeOccurrence,
  nextOccurrence,
} from '../shared/cadence';
import { EARLY_MORNING_CUTOFF_MINUTES, sleepDayDiff, sleepDayOf } from '../shared/dates';

// Placement (§9.2 staged Brain, layer 1): the deterministic skeleton of the
// day's map. Code — not the model — decides which items are REQUIRED today
// and the minimum tier each may sit at; the model's job starts after this
// (layer 2 curates what *else* earns a place, layer 3 writes the cards).
//
// The rules exist to fix an observed failure: a single "what's salient?"
// objective let deadline proximity dominate everything, so quick tasks
// surfaced days early while undated items starved. Here, when a dated item
// enters the map is a function of its effort (lead time = runway), and
// early surfacing stops being the model's default and becomes a deliberate
// curation act with a stated reason.
//
// Everything in this module is pure and unit-tested. Floors are floors:
// later layers may raise a tier or add items, never lower or drop.

// ---------- tiers ----------

// Tier judgment from the Brain, numbers from code. Asked for a 0-1 number the
// model emits an evenly spaced ladder (rank order, not salience); ordinal
// judgment is what it does well, so the prompts ask for a tier and this maps
// tiers into fixed bands. Bands sit ≥0.10 apart in p — past the descent
// view's spacing floor — so a tier boundary always renders as a felt cliff,
// while within-band gaps stay shelf-tight.
export type BrainTier = 'loud' | 'mid' | 'quiet' | 'dot';
const TIER_BANDS: Record<BrainTier, [top: number, bottom: number]> = {
  loud: [0.95, 0.78],
  mid: [0.68, 0.5],
  quiet: [0.4, 0.28],
  dot: [0.18, 0.08],
};

// Members of a tier spread evenly from the band top in output order; a lone
// member sits at the top. Output order across tiers may interleave.
export function tierProminences(tiers: BrainTier[]): number[] {
  const counts = new Map<BrainTier, number>();
  for (const t of tiers) counts.set(t, (counts.get(t) ?? 0) + 1);
  const seen = new Map<BrainTier, number>();
  return tiers.map((t) => {
    const [top, bottom] = TIER_BANDS[t];
    const n = counts.get(t)!;
    const k = seen.get(t) ?? 0;
    seen.set(t, k + 1);
    const p = n === 1 ? top : top - ((top - bottom) * k) / (n - 1);
    return Math.round(p * 100) / 100; // clean two-decimal p — no float dust in the data
  });
}

const TIER_RANK: Record<BrainTier, number> = { loud: 3, mid: 2, quiet: 1, dot: 0 };

export function isBrainTier(t: unknown): t is BrainTier {
  return t === 'loud' || t === 'mid' || t === 'quiet' || t === 'dot';
}

export function maxTier(a: BrainTier, b: BrainTier): BrainTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export function compareTier(a: BrainTier, b: BrainTier): number {
  return TIER_RANK[b] - TIER_RANK[a]; // sort comparator: loudest first
}

// One step down the ladder; dot is the floor of floors.
function quieterTier(t: BrainTier): BrainTier {
  return t === 'loud' ? 'mid' : t === 'mid' ? 'quiet' : 'dot';
}

// ---------- the user-local day window ----------

const DAY = 86_400_000;

function dayWindowUtc(now: Date, tzOffsetMinutes: number): { start: number; end: number } {
  const start =
    sleepDayOf(now.getTime(), tzOffsetMinutes) * DAY + (EARLY_MORNING_CUTOFF_MINUTES - tzOffsetMinutes) * 60_000;
  return { start, end: start + DAY };
}

// An event spanning any part of the user-local today (sleep-cycle day,
// 5am → 5am — the app's one day system).
function eventSpansToday(atMs: number, endMs: number, now: Date, tzOffsetMinutes: number): boolean {
  const { start, end } = dayWindowUtc(now, tzOffsetMinutes);
  return atMs < end && endMs >= start;
}

// ---------- reliable floor (§7 reliable-vs-advisory split) ----------

// An item due today, overdue, or happening today must reach the map no matter
// what the Brain decides. Pure so it's unit-testable; tzOffsetMinutes defines
// the user's "today" — the sleep-cycle day (5am → 5am), so a deadline at 1am
// still counts as the evening before it. This predicate is the belt-and-braces
// net; placeItems below is its superset (everything today-relevant is also
// mandatory under placement — asserted by test).
export function isTodayRelevant(
  i: {
    status: string;
    deadline: string | null;
    eventAt: string | null;
    eventEnd: string | null;
    cadence?: Cadence | null;
    createdAt?: string;
    lastCompletedAt?: string | null;
  },
  now: Date,
  tzOffsetMinutes: number,
): boolean {
  if (i.status !== 'active') return false;
  // Compare by sleep DAY, not instant. A day-precision deadline due today is
  // anchored at noon here, but nothing about this test may depend on where in
  // the day the anchor sits — a strict instant comparison against dayEndUtc
  // silently drops anything anchored at the boundary itself, and dropping a
  // same-day item is this app's cardinal failure.
  if (i.deadline && sleepDayOf(new Date(i.deadline).getTime(), tzOffsetMinutes) <= sleepDayOf(now.getTime(), tzOffsetMinutes))
    return true; // due today or overdue
  if (i.eventAt) {
    const at = new Date(i.eventAt).getTime();
    // Clamped: the sheet edits eventAt and eventEnd independently, so an
    // inverted range is reachable — it degrades to a point event here rather
    // than making a today event silently invisible to the floor.
    const end = Math.max(at, i.eventEnd ? new Date(i.eventEnd).getTime() : at);
    if (eventSpansToday(at, end, now, tzOffsetMinutes)) return true; // spans some part of today
  }
  // Recurring rhythms: a cadence whose next occurrence lands today counts.
  // Without this, a "daily at 7pm" DO has neither deadline nor eventAt and the
  // floor silently excludes it — the exact hole that dropped a daily task.
  if (cadenceOccurrenceToday(i, now, tzOffsetMinutes)) return true;
  return false;
}

// ---------- cadence standing ----------

// Where a recurring rhythm stands relative to the user-local today: its turn
// falls today, its last turn passed unmet, or it next comes round in N days.
// One axis, one derivation — the same-day floor, the happens=today token and
// the next= token all read it, so the guarantee and the Brain's input can
// never disagree.
export type CadenceStanding =
  | { kind: 'today'; at: Date }
  | { kind: 'overdue'; at: Date; days: number }
  | { kind: 'upcoming'; at: Date; days: number };

type CadenceItem = {
  cadence?: Cadence | null;
  eventAt: string | null;
  createdAt?: string;
  lastCompletedAt?: string | null;
};

export function cadenceStanding(i: CadenceItem, now: Date, tzOffsetMinutes: number): CadenceStanding | null {
  if (!i.cadence) return null;
  const { start: dayStartUtc, end: dayEndUtc } = dayWindowUtc(now, tzOffsetMinutes);
  const anchor = i.eventAt ?? i.createdAt ?? now.toISOString();
  const occurrenceFrom = (from: Date): Date =>
    i.cadence!.atTime
      ? nextAtTimeOccurrence(i.cadence!, anchor, from, tzOffsetMinutes)
      : nextOccurrence(i.cadence!, anchor, from);

  // Same predicate that derives ItemView.doneToday — the checkbox and the
  // Brain's release must agree on what "done for today" means (sleep-cycle
  // day: a 9:30pm completion stays done through the small hours).
  const releasedToday = completedWithinSleepDay(i.lastCompletedAt ?? null, now, tzOffsetMinutes);
  if (!releasedToday) {
    const occ = occurrenceFrom(new Date(dayStartUtc));
    if (occ.getTime() < dayEndUtc) return { kind: 'today', at: occ };
  }

  // Nothing is being asked today, which reads two ways the item line used to
  // render identically: the rhythm is kept and merely upcoming, or its last
  // turn went by unmet. Walk the grid backwards one worst-case gap to tell
  // them apart; a turn that predates the item was never asked, so the anchor
  // floors the window.
  const anchorMs = new Date(anchor).getTime();
  const windowStart = Math.max(dayStartUtc - cadenceGridGapMs(i.cadence), anchorMs);
  let previous: Date | null = null;
  let cursor = new Date(windowStart);
  for (let n = 0; n < 40 && cursor.getTime() < dayStartUtc; n++) {
    const occ = occurrenceFrom(cursor);
    if (occ.getTime() >= dayStartUtc) break;
    previous = occ;
    cursor = new Date(occ.getTime() + 60_000);
  }
  // A turn counts as met by a completion on its sleep day or any later one —
  // never by instant, because last_completed_at is the moment of the TAP, not
  // the occurrence. Comparing instants made "take out the recycling", ticked
  // at 8pm on its own Tuesday, read as unmet against a 9:30pm turn and stay
  // that way every day after. Same rule as doneToday, one turn further back.
  const completedDay = i.lastCompletedAt
    ? sleepDayOf(new Date(i.lastCompletedAt).getTime(), tzOffsetMinutes)
    : null;
  if (previous && (completedDay === null || completedDay < sleepDayOf(previous.getTime(), tzOffsetMinutes))) {
    return { kind: 'overdue', at: previous, days: -sleepDayDiff(previous.getTime(), now.getTime(), tzOffsetMinutes) };
  }
  // Today's turn already done releases the rhythm until tomorrow, so the
  // search for the next one starts past the end of today.
  const next = occurrenceFrom(new Date(releasedToday ? dayEndUtc : dayStartUtc));
  return { kind: 'upcoming', at: next, days: sleepDayDiff(next.getTime(), now.getTime(), tzOffsetMinutes) };
}

// The occurrence of a recurring rhythm that falls within the user-local today,
// or null. An occurrence already completed within the local today doesn't
// count — the rhythm releases until tomorrow.
export function cadenceOccurrenceToday(i: CadenceItem, now: Date, tzOffsetMinutes: number): Date | null {
  const standing = cadenceStanding(i, now, tzOffsetMinutes);
  return standing?.kind === 'today' ? standing.at : null;
}

// ---------- lead-time rules ----------

// When a dated DO ENTERS the map, by effort. Lead time is runway: a
// big-effort thing needs attention days before its moment; a quick one needs
// exactly its day — surfacing it earlier is the "prompted me for a two-minute
// task three days out" failure this layer exists to end. A soft deadline or
// an optional item gets one day less lead and one tier quieter: the date is
// advisory, so the runway is too. Tunable constants, not model judgment.
export const DO_LEAD_DAYS: Record<'quick' | 'medium' | 'large', number> = {
  quick: 0,
  medium: 1,
  large: 6,
};

// Multi-day events (trips) enter early — they consume upcoming days and
// imply packing — where a single-moment event just needs seeing the day
// before. Events further out stay curation-eligible (the "horizon" glance),
// never required.
export const TRIP_LEAD_DAYS = 3;

// Within a big-effort item's runway, the floor steps up as the date closes:
// distant runway is a quiet keep-in-view, the final stretch sits mid.
export const LARGE_MID_WITHIN_DAYS = 2;

export interface Placement {
  item: ItemView;
  floor: BrainTier; // minimum tier — later layers may raise, never lower
  rule: string; // the rule identifier that fired, e.g. 'due-today', 'runway-4d-left'
}

export interface PlacementResult {
  mandatory: Placement[];
  eligible: ItemView[]; // active items placement does not require today — layer 2's pile
}

// The one rule table. For each active item, the strongest firing rule wins
// (an item can be both due today and happening today; the louder floor and
// its rule carry). Returns null when nothing fires — the item is eligible,
// not required.
export function placeItem(i: ItemView, now: Date, tzOffsetMinutes: number): { floor: BrainTier; rule: string } | null {
  if (i.status !== 'active') return null;
  const hard = (i.deadlineHardness ?? 'hard') === 'hard';
  const optional = i.optionality === 'nice';
  // Same insistence line the legacy prominence floor drew (must-do or hard
  // deadline ⇒ at least mid on its day) so the two guarantees can't disagree.
  const insistent = !optional || hard;

  let best: { floor: BrainTier; rule: string } | null = null;
  const take = (floor: BrainTier, rule: string) => {
    if (!best || TIER_RANK[floor] > TIER_RANK[best.floor]) best = { floor, rule };
  };

  if (i.deadline) {
    const d = sleepDayDiff(new Date(i.deadline).getTime(), now.getTime(), tzOffsetMinutes);
    if (d < 0) {
      take(insistent ? 'mid' : 'quiet', `overdue-${-d}d`);
    } else if (d === 0) {
      take(insistent ? 'mid' : 'quiet', 'due-today');
    } else {
      // Future-dated: entry is effort-driven runway, softened for advisory dates.
      const soften = !hard || optional;
      const lead = Math.max(0, DO_LEAD_DAYS[i.effort] - (soften ? 1 : 0));
      if (d <= lead) {
        let floor: BrainTier =
          i.effort === 'large' ? (d <= LARGE_MID_WITHIN_DAYS ? 'mid' : 'quiet') : 'dot';
        if (soften) floor = quieterTier(floor);
        take(floor, i.effort === 'large' ? `runway-${d}d-left` : 'due-tomorrow');
      }
    }
  }

  if (i.eventAt) {
    const at = new Date(i.eventAt).getTime();
    // Same clamp as isTodayRelevant: an inverted range (independently edited
    // eventEnd before eventAt) reads as a point event, never as "no event".
    const end = Math.max(at, i.eventEnd ? new Date(i.eventEnd).getTime() : at);
    if (eventSpansToday(at, end, now, tzOffsetMinutes)) {
      // Fires with or without a cadence: the reliable floor's eventAt branch
      // doesn't care that the item recurs, so neither may this one — the
      // "everything isTodayRelevant is mandatory" invariant holds by
      // construction, never by luck.
      take(optional ? 'quiet' : 'mid', 'event-today');
    } else if (!i.cadence) {
      const d = sleepDayDiff(at, now.getTime(), tzOffsetMinutes);
      const spanDays = sleepDayDiff(end, at, tzOffsetMinutes);
      if (d === 1) {
        take(optional ? 'dot' : 'quiet', 'event-tomorrow');
      } else if (d >= 2 && d <= TRIP_LEAD_DAYS && spanDays >= 1) {
        take(optional ? 'dot' : 'quiet', `trip-in-${d}d`);
      }
      // Events further out — and past events awaiting the sweep — are never
      // required; the curator may still offer a horizon glance.
    }
    // A cadence item's future eventAt is an anchor, not a plan — standing
    // (below) owns where the rhythm sits, so the day-before and trip rules
    // stay one-shot only.
  }

  if (i.cadence) {
    const standing = cadenceStanding(i, now, tzOffsetMinutes);
    if (standing?.kind === 'today') {
      take(optional ? 'quiet' : 'mid', 'rhythm-today');
    } else if (standing?.kind === 'overdue') {
      // A slipped rhythm is a nudge, not an alarm — quiet regardless.
      take('quiet', `rhythm-unmet-${standing.days}d`);
    }
  }

  return best;
}

// Split the active set into the required skeleton and the curation pile.
// Invariant (tested): everything isTodayRelevant lands in mandatory — the
// skeleton is a strict superset of the old reliable floor.
export function placeItems(items: ItemView[], now: Date, tzOffsetMinutes: number): PlacementResult {
  const mandatory: Placement[] = [];
  const eligible: ItemView[] = [];
  for (const item of items) {
    if (item.status !== 'active') continue;
    const placed = placeItem(item, now, tzOffsetMinutes);
    if (placed) mandatory.push({ item, floor: placed.floor, rule: placed.rule });
    else eligible.push(item);
  }
  return { mandatory, eligible };
}
