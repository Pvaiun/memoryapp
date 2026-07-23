import type { Cadence } from './types';
import { EARLY_MORNING_CUTOFF_MINUTES, sleepDayOf } from './dates';

// Shared RRULE-like recurrence core (§3.1). For a DO, cadence is a rhythm that
// drives neglect-nudging (now − lastCompleted vs cadence), not a hard gate.
// For a HAPPEN, it generates per-occurrence times (and per-occurrence pushes, §11.4).

const DAY_MS = 86_400_000;

// The nominal period of one cadence cycle, in ms.
export function cadencePeriodMs(cadence: Cadence): number {
  const interval = Math.max(1, cadence.interval || 1);
  switch (cadence.freq) {
    case 'daily':
      return interval * DAY_MS;
    case 'weekly': {
      // "3x a week" style rhythms: byWeekday shrinks the effective period.
      const perWeek = cadence.byWeekday?.length || 1;
      return (interval * 7 * DAY_MS) / perWeek;
    }
    case 'monthly':
      return interval * 30 * DAY_MS;
    case 'yearly':
      return interval * 365 * DAY_MS;
  }
}

// Neglect (§7.2): computed, never logged. A missed occurrence resurfaces the
// item; it does not fail it. Grace of half a period avoids nagging at the edge.
export function isNeglected(
  cadence: Cadence | null,
  lastCompletedAt: string | null,
  createdAt: string,
  now: Date,
): boolean {
  if (!cadence) return false;
  const anchor = lastCompletedAt ?? createdAt;
  const elapsed = now.getTime() - new Date(anchor).getTime();
  return elapsed > cadencePeriodMs(cadence) * 1.5;
}

// "Done for today" (§7.2): completed within the user-local SLEEP-CYCLE day —
// the same 5am boundary as localDay() and the date parser's night-owl rule,
// not calendar midnight. Finishing the recycling at 9:30pm and glancing at the
// app at 12:30am must not uncheck it mid-evening; doneness releases when the
// user wakes, and the next occurrence takes over from there. For a recurring
// DO this is the per-occurrence done state — the item stays active forever.
// One definition shared by the Brain's suppression and the ItemView
// derivation so the two can never disagree.
export function completedWithinSleepDay(
  lastCompletedAt: string | null,
  now: Date,
  tzOffsetMinutes: number,
): boolean {
  if (!lastCompletedAt) return false;
  return sleepDayOf(new Date(lastCompletedAt).getTime(), tzOffsetMinutes) === sleepDayOf(now.getTime(), tzOffsetMinutes);
}

// The user-facing "checked" state of a DO. One-shots check by status; a
// recurring DO never reaches status='completed', so it checks by doneToday —
// done for this occurrence, released when the sleep-cycle day rolls (5am).
export function isDoneForNow(item: { status: string; cadence: Cadence | null; doneToday: boolean }): boolean {
  return item.status === 'completed' || (!!item.cadence && item.doneToday);
}

// A one-shot event whose moment has passed (with an hour's grace for
// overruns) is spent: it reads like a completed task — "Lunch with Seb"
// must not hold its place in the day all afternoon. Recurring events
// re-arm per occurrence, so they never go spent this way.
export const EVENT_PASSED_GRACE_MS = 3_600_000;

export function eventPassed(
  item: { eventAt: string | null; eventEnd: string | null; cadence: Cadence | null },
  now: number,
): boolean {
  if (!item.eventAt || item.cadence) return false;
  return new Date(item.eventEnd ?? item.eventAt).getTime() + EVENT_PASSED_GRACE_MS < now;
}

// Resolved = nothing left to want from the item right now: checked off for
// the occasion, or an event that already happened.
export function isResolvedForNow(
  item: {
    status: string;
    cadence: Cadence | null;
    doneToday: boolean;
    eventAt: string | null;
    eventEnd: string | null;
  },
  now: number,
): boolean {
  return isDoneForNow(item) || eventPassed(item, now);
}

// Captured-today relevance (Now screen, §9.1): does this item carry TODAY's
// pressure? "Today" is the user-local sleep-cycle day (5am boundary — the
// same frame as doneToday and the date parser's night-owl rule). Qualifies:
//   - a deadline due today or already blown (overdue is today's pressure),
//   - an event whose span touches today,
//   - a cadence whose next occurrence lands today (a daily rhythm always
//     does; "weekly on Sun" captured on a Tuesday waits for Sunday).
// Undated items and future-dated items don't qualify — they wait in the
// bucket for the morning build instead of crowding the map.
export function happeningToday(
  item: {
    deadline: string | null;
    eventAt: string | null;
    eventEnd: string | null;
    cadence: Cadence | null;
    createdAt: string;
  },
  now: Date,
  tzOffsetMinutes: number,
): boolean {
  const shift = (tzOffsetMinutes - EARLY_MORNING_CUTOFF_MINUTES) * 60_000;
  const dayOf = (t: number) => sleepDayOf(t, tzOffsetMinutes);
  const today = dayOf(now.getTime());
  if (item.deadline && dayOf(new Date(item.deadline).getTime()) <= today) return true;
  if (item.eventAt) {
    const at = new Date(item.eventAt).getTime();
    const end = item.eventEnd ? new Date(item.eventEnd).getTime() : at;
    if (dayOf(at) <= today && dayOf(end) >= today) return true;
  }
  if (item.cadence) {
    // Walk from the START of the current sleep day, not from `now` — an
    // occurrence that already passed this afternoon still makes it today's.
    const dayStart = new Date(today * DAY_MS - shift);
    const next = item.cadence.atTime
      ? nextAtTimeOccurrence(item.cadence, item.createdAt, dayStart, tzOffsetMinutes)
      : nextOccurrence(item.cadence, item.eventAt ?? item.createdAt, dayStart);
    if (dayOf(next.getTime()) === today) return true;
  }
  return false;
}

export function neglectedByDays(
  cadence: Cadence,
  lastCompletedAt: string | null,
  createdAt: string,
  now: Date,
): number {
  const anchor = lastCompletedAt ?? createdAt;
  const elapsed = now.getTime() - new Date(anchor).getTime();
  return Math.max(0, Math.round((elapsed - cadencePeriodMs(cadence)) / DAY_MS));
}

// Next occurrence of a recurring time-anchored item at or after `from`.
// anchor = the first/reference occurrence (eventAt for HAPPEN, createdAt for DO).
export function nextOccurrence(cadence: Cadence, anchorIso: string, from: Date): Date {
  const anchor = new Date(anchorIso);
  // The anchor is a reference point, not automatically an occurrence: a
  // "weekly on Sun" DO created on a Tuesday anchors at that Tuesday, and
  // short-circuiting on it would invent a Tuesday occurrence. Only return the
  // anchor directly when it matches the cadence's own pattern.
  const anchorOnPattern =
    (cadence.freq !== 'weekly' || !cadence.byWeekday?.length || cadence.byWeekday.includes(anchor.getDay())) &&
    (cadence.freq !== 'monthly' || !cadence.byMonthDay || anchor.getDate() === cadence.byMonthDay);
  if (anchor.getTime() >= from.getTime() && anchorOnPattern) return anchor;
  const interval = Math.max(1, cadence.interval || 1);

  if (cadence.freq === 'daily') {
    const periods = Math.ceil((from.getTime() - anchor.getTime()) / (interval * DAY_MS));
    return new Date(anchor.getTime() + periods * interval * DAY_MS);
  }

  if (cadence.freq === 'weekly') {
    const days = cadence.byWeekday?.length ? [...cadence.byWeekday].sort() : [anchor.getDay()];
    // Walk day by day from `from`; bounded (≤ 7 * interval + 7 steps).
    const cursor = new Date(from);
    cursor.setHours(anchor.getHours(), anchor.getMinutes(), 0, 0);
    if (cursor.getTime() < from.getTime()) cursor.setDate(cursor.getDate() + 1);
    for (let i = 0; i < interval * 7 + 8; i++) {
      if (days.includes(cursor.getDay())) {
        // Respect the week interval relative to the anchor's week.
        const weeksFromAnchor = Math.floor((cursor.getTime() - startOfWeek(anchor).getTime()) / (7 * DAY_MS));
        if (weeksFromAnchor % interval === 0) return new Date(cursor);
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return cursor;
  }

  if (cadence.freq === 'monthly') {
    const targetDay = cadence.byMonthDay ?? anchor.getDate();
    const cursor = new Date(from.getFullYear(), from.getMonth(), 1, anchor.getHours(), anchor.getMinutes());
    for (let i = 0; i < 24; i++) {
      const monthsFromAnchor =
        (cursor.getFullYear() - anchor.getFullYear()) * 12 + (cursor.getMonth() - anchor.getMonth());
      if (monthsFromAnchor >= 0 && monthsFromAnchor % interval === 0) {
        const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
        const candidate = new Date(
          cursor.getFullYear(),
          cursor.getMonth(),
          Math.min(targetDay, lastDay),
          anchor.getHours(),
          anchor.getMinutes(),
        );
        if (candidate.getTime() >= from.getTime()) return candidate;
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return cursor;
  }

  // yearly
  const candidate = new Date(from.getFullYear(), anchor.getMonth(), anchor.getDate(), anchor.getHours(), anchor.getMinutes());
  if (candidate.getTime() >= from.getTime()) return candidate;
  candidate.setFullYear(candidate.getFullYear() + interval);
  return candidate;
}

// All occurrences within [from, to) — used by the calendar view and push scan.
export function occurrencesBetween(cadence: Cadence, anchorIso: string, from: Date, to: Date, cap = 100): Date[] {
  const out: Date[] = [];
  let cursor = new Date(from);
  while (out.length < cap) {
    const next = nextOccurrence(cadence, anchorIso, cursor);
    if (next.getTime() >= to.getTime()) break;
    out.push(next);
    cursor = new Date(next.getTime() + 60_000);
  }
  return out;
}

// Recurring DOs anchor at cadence.atTime, a wall-clock "HH:MM" in the USER'S
// timezone. The occurrence walk must run in that frame: a Thursday-8pm rhythm
// at UTC-4 lands on Friday 00:00 UTC, so matching byWeekday against UTC days
// (or treating "20:00" as UTC) would drift the ping by hours or a whole day.
// These helpers shift into the user frame, walk, and shift the result back.
function localAtTimeAnchor(cadence: Cadence, createdAtIso: string, tzMs: number): Date {
  const [h, m] = (cadence.atTime ?? '00:00').split(':').map(Number);
  const local = new Date(new Date(createdAtIso).getTime() + tzMs);
  local.setUTCHours(h, m, 0, 0);
  return local;
}

export function nextAtTimeOccurrence(
  cadence: Cadence,
  createdAtIso: string,
  from: Date,
  tzOffsetMinutes = 0,
): Date {
  const tzMs = tzOffsetMinutes * 60_000;
  const anchor = localAtTimeAnchor(cadence, createdAtIso, tzMs);
  const occ = nextOccurrence(cadence, anchor.toISOString(), new Date(from.getTime() + tzMs));
  return new Date(occ.getTime() - tzMs);
}

export function atTimeOccurrencesBetween(
  cadence: Cadence,
  createdAtIso: string,
  from: Date,
  to: Date,
  tzOffsetMinutes = 0,
): Date[] {
  const tzMs = tzOffsetMinutes * 60_000;
  const anchor = localAtTimeAnchor(cadence, createdAtIso, tzMs);
  return occurrencesBetween(
    cadence,
    anchor.toISOString(),
    new Date(from.getTime() + tzMs),
    new Date(to.getTime() + tzMs),
  ).map((d) => new Date(d.getTime() - tzMs));
}

function startOfWeek(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - s.getDay());
  return s;
}

// Human-readable cadence, for the UI. atTime is user-local wall clock, so it
// renders directly with no timezone conversion.
export function describeCadence(cadence: Cadence): string {
  const interval = Math.max(1, cadence.interval || 1);
  const every = interval === 1 ? 'every' : `every ${interval}`;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const at = cadence.atTime ? ` at ${describeAtTime(cadence.atTime)}` : '';
  switch (cadence.freq) {
    case 'daily':
      return (interval === 1 ? 'daily' : `every ${interval} days`) + at;
    case 'weekly':
      if (cadence.byWeekday?.length) {
        const days = cadence.byWeekday.map((d) => WEEKDAYS[d]).join(', ');
        return (interval === 1 ? `weekly on ${days}` : `${every} weeks on ${days}`) + at;
      }
      return (interval === 1 ? 'weekly' : `every ${interval} weeks`) + at;
    case 'monthly':
      return (interval === 1 ? 'monthly' : `every ${interval} months`) + at;
    case 'yearly':
      return (interval === 1 ? 'yearly' : `every ${interval} years`) + at;
  }
}

export function describeAtTime(atTime: string): string {
  const [h, m] = atTime.split(':').map(Number);
  const ampm = h >= 12 ? 'pm' : 'am';
  const hr = ((h + 11) % 12) + 1;
  return m ? `${hr}:${String(m).padStart(2, '0')}${ampm}` : `${hr}${ampm}`;
}
