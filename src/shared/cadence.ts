import type { Cadence, DatePrecision } from './types';
import { isClosedStatus } from './types';
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

// The longest gap the grid can leave between two consecutive occurrences —
// unlike cadencePeriodMs, which averages a multi-day week down ("3x a week"
// → 2.3 days). A backward scan for the previous occurrence needs the worst
// case: any window this wide contains one, or the grid has none to find.
export function cadenceGridGapMs(cadence: Cadence): number {
  const interval = Math.max(1, cadence.interval || 1);
  switch (cadence.freq) {
    case 'daily':
      return interval * DAY_MS;
    case 'weekly':
      return interval * 7 * DAY_MS;
    case 'monthly':
      return interval * 31 * DAY_MS;
    case 'yearly':
      return interval * 366 * DAY_MS;
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

// Has a particular OCCURRENCE been ticked off? last_completed_at is the moment
// of the TAP, not the occurrence it settles, so a turn counts as met by a
// completion on its sleep day or any later one — never by instant. Comparing
// instants made "take out the recycling", ticked at 8pm on its own Tuesday,
// read as unmet against its 9:30pm turn and stay that way every day after.
//
// One definition, shared by the map's cadence standing and the push scan, so
// the thing the user sees ticked and the thing that pings can never disagree.
export function completedForOccurrence(
  lastCompletedAt: string | null | undefined,
  occurrenceMs: number,
  tzOffsetMinutes: number,
): boolean {
  if (!lastCompletedAt) return false;
  return (
    sleepDayOf(new Date(lastCompletedAt).getTime(), tzOffsetMinutes) >= sleepDayOf(occurrenceMs, tzOffsetMinutes)
  );
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
//
// A DAY-precision event has no moment to pass. "Gabe comes over Thursday"
// is live all Thursday; it is spent when Thursday is, at the 5am rollover.
// Reading its noon anchor as a moment retired it at 1pm on its own day.
export const EVENT_PASSED_GRACE_MS = 3_600_000;

export function eventPassed(
  item: {
    eventAt: string | null;
    eventEnd: string | null;
    cadence: Cadence | null;
    datePrecision?: DatePrecision;
  },
  now: number,
  tzOffsetMinutes?: number,
): boolean {
  if (!item.eventAt || item.cadence) return false;
  const last = new Date(item.eventEnd ?? item.eventAt).getTime();
  if (item.datePrecision === 'day') return sleepDayIndex(last, now, tzOffsetMinutes) < 0;
  return last + EVENT_PASSED_GRACE_MS < now;
}

// When does any of the above next change its answer? Lateness is a step
// function: it flips at instants that are already known — a deadline, a
// rhythm's turn today, an event's grace running out — and is constant in
// between. So a view that shows it needs one wake-up per instant, not a poll.
//
// Always finite, because the sleep-day rollover is a boundary in its own
// right: at 5am all-day deadlines go overdue, spent events close, and every
// day-distance label re-counts.
export function nextLatenessBoundary(
  items: {
    type: string;
    status: string;
    deadline: string | null;
    datePrecision?: DatePrecision;
    cadence: Cadence | null;
    doneToday: boolean;
    createdAt: string;
    eventAt: string | null;
    eventEnd: string | null;
  }[],
  now: number,
  tzOffsetMinutes?: number,
): number {
  const tz = tzOffsetMinutes ?? -new Date(now).getTimezoneOffset();
  const dayStart = (idx: number) => idx * DAY_MS + (EARLY_MORNING_CUTOFF_MINUTES - tz) * 60_000;
  const today = sleepDayOf(now, tz);
  let next = dayStart(today + 1);
  const consider = (t: number) => {
    if (t > now && t < next) next = t;
  };
  for (const it of items) {
    if (isClosedStatus(it.status)) continue;
    if (it.type === 'DO') {
      if (isDoneForNow(it)) continue;
      // An all-day deadline has no instant to flip at — only the rollover,
      // which already floors this.
      if (it.deadline && it.datePrecision !== 'day') consider(new Date(it.deadline).getTime());
      if (it.cadence?.atTime) {
        const occ = nextAtTimeOccurrence(it.cadence, it.eventAt ?? it.createdAt, new Date(dayStart(today)), tz);
        consider(occ.getTime());
      }
    } else if (it.type === 'HAPPEN' && it.eventAt && !it.cadence && it.datePrecision !== 'day') {
      consider(new Date(it.eventEnd ?? it.eventAt).getTime() + EVENT_PASSED_GRACE_MS);
    }
  }
  return next;
}

// Sleep-day distance from `now` to `t`, using the caller's fixed offset when
// given (worker, which runs in UTC) and each instant's own local offset when
// not (browser, so a DST change between the two can't skew the count). The
// one place the two flavours of day math are chosen between.
function sleepDayIndex(t: number, now: number, tzOffsetMinutes?: number): number {
  if (tzOffsetMinutes === undefined) {
    const idx = (ms: number) => sleepDayOf(ms, -new Date(ms).getTimezoneOffset());
    return idx(t) - idx(now);
  }
  return sleepDayOf(t, tzOffsetMinutes) - sleepDayOf(now, tzOffsetMinutes);
}

// Has this item's DEADLINE gone by? The precision decides what "gone by"
// can even mean: a moment is late the instant the clock passes it, a day is
// late only once the sleep day has ended. Nothing may compare a day-precision
// deadline to the clock — its noon anchor is a placement, not a time, and
// treating it as one is what turned every date-only chore red at 12:01pm.
export function deadlinePassed(
  item: { deadline: string | null; datePrecision?: DatePrecision },
  now: number,
  tzOffsetMinutes?: number,
): boolean {
  if (!item.deadline) return false;
  const due = new Date(item.deadline).getTime();
  if (item.datePrecision === 'day') return sleepDayIndex(due, now, tzOffsetMinutes) < 0;
  return due < now;
}

// The card-level question behind a late chip (descent option B): does this DO
// have a moment TODAY that the clock has gone past while it sits unticked?
// Deliberately narrow — it is the only honest form of "going late" the app
// can show during a day:
//   • a timed deadline that has passed, or any deadline from a day now over;
//   • a recurring DO whose at-time turn today has come and gone unticked.
// A day-precision deadline due today is never late today, which is the whole
// point of storing precision.
export function momentPassed(
  item: {
    type: string;
    status: string;
    deadline: string | null;
    datePrecision?: DatePrecision;
    cadence: Cadence | null;
    doneToday: boolean;
    createdAt: string;
    eventAt: string | null;
  },
  now: number,
  tzOffsetMinutes?: number,
): boolean {
  if (item.type !== 'DO' || item.status !== 'active') return false;
  if (isDoneForNow({ status: item.status, cadence: item.cadence, doneToday: item.doneToday })) return false;
  if (item.deadline) return deadlinePassed(item, now, tzOffsetMinutes);
  if (item.cadence?.atTime) {
    const tz = tzOffsetMinutes ?? -new Date(now).getTimezoneOffset();
    const dayStart = new Date(sleepDayOf(now, tz) * DAY_MS + (EARLY_MORNING_CUTOFF_MINUTES - tz) * 60_000);
    const occ = nextAtTimeOccurrence(item.cadence, item.eventAt ?? item.createdAt, dayStart, tz);
    return occ.getTime() <= now && sleepDayIndex(occ.getTime(), now, tz) === 0;
  }
  return false;
}

// A recurring event's eventAt is the anchor of its grid, not a standing date:
// once an occurrence's day has gone, everything that reads eventAt raw — the
// Brain's happens= token, the map's happening-now check, every date badge —
// must see the NEXT occurrence, or a bi-weekly appointment reads "overdue"
// forever off its own first date. Rolls the anchor to the next slot at or
// after `from`, shifting a multi-day end by the same delta so the span's
// shape survives. The grid itself is unchanged — the new anchor is on it.
export function rollEventAnchor(
  item: { cadence: Cadence; eventAt: string; eventEnd: string | null },
  from: Date,
): { eventAt: string; eventEnd: string | null } {
  const next = nextOccurrence(item.cadence, item.eventAt, from);
  const delta = next.getTime() - new Date(item.eventAt).getTime();
  return {
    eventAt: next.toISOString(),
    eventEnd: item.eventEnd ? new Date(new Date(item.eventEnd).getTime() + delta).toISOString() : null,
  };
}

// A RECURRING event's occurrence today, once its moment (plus the same grace
// hour) has gone, is as spent as a one-shot: the 2pm appointment at 5pm no
// longer wants anything, and its card settles the same way — the occasion
// resolves neutrally, the rhythm re-arms for the next slot. Day-precision
// occurrences stay live all their day (they lapse at the 5am rollover, like
// day-precision one-shots); occurrences on other days are not today's to
// spend. Derived only — no status is written; the item stays active.
export function occurrencePassedForNow(
  item: {
    cadence: Cadence | null;
    eventAt: string | null;
    eventEnd: string | null;
    datePrecision?: DatePrecision;
  },
  now: number,
  tzOffsetMinutes?: number,
): boolean {
  if (!item.cadence || !item.eventAt) return false;
  if (item.datePrecision === 'day') return false;
  const tz = tzOffsetMinutes ?? -new Date(now).getTimezoneOffset();
  const dayStart = new Date(sleepDayOf(now, tz) * DAY_MS + (EARLY_MORNING_CUTOFF_MINUTES - tz) * 60_000);
  const occ = nextOccurrence(item.cadence, item.eventAt, dayStart);
  if (sleepDayOf(occ.getTime(), tz) !== sleepDayOf(now, tz)) return false;
  const span = item.eventEnd ? new Date(item.eventEnd).getTime() - new Date(item.eventAt).getTime() : 0;
  return occ.getTime() + Math.max(0, span) + EVENT_PASSED_GRACE_MS < now;
}

// Resolved = nothing left to want from the item right now: checked off for
// the occasion, closed out of its lifecycle (dismissed / passed / missed),
// an event that already happened, or a recurring occurrence spent today.
export function isResolvedForNow(
  item: {
    status: string;
    cadence: Cadence | null;
    doneToday: boolean;
    eventAt: string | null;
    eventEnd: string | null;
    datePrecision?: DatePrecision;
  },
  now: number,
  tzOffsetMinutes?: number,
): boolean {
  return (
    isDoneForNow(item) ||
    isClosedStatus(item.status) ||
    eventPassed(item, now, tzOffsetMinutes) ||
    occurrencePassedForNow(item, now, tzOffsetMinutes)
  );
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

// The occurrence walk reads calendar fields (weekday, hour, month), so it
// must know which frame those fields live in. Real-instant callers walk in
// the host's local frame (browser = the user's clock; worker = UTC). The
// atTime helpers below build a SHIFTED timeline whose UTC fields hold the
// user's sleep-frame clock, so their walk must read UTC fields: host-local
// accessors there apply the host offset on top of the manual shift, which
// is what pushed a Mon/Wed/Fri-at-12am rhythm onto Thursday in the browser
// (12am minus the offset crosses midnight, so every day matched one late —
// while the UTC-hosted worker agreed with itself and said "tonight").
interface CalendarFrame {
  day(d: Date): number;
  date(d: Date): number;
  month(d: Date): number;
  year(d: Date): number;
  hours(d: Date): number;
  minutes(d: Date): number;
  setTime(d: Date, h: number, m: number): void;
  addDays(d: Date, n: number): void;
  addMonths(d: Date, n: number): void;
  make(y: number, month: number, day: number, h: number, m: number): Date;
}

const LOCAL_FRAME: CalendarFrame = {
  day: (d) => d.getDay(),
  date: (d) => d.getDate(),
  month: (d) => d.getMonth(),
  year: (d) => d.getFullYear(),
  hours: (d) => d.getHours(),
  minutes: (d) => d.getMinutes(),
  setTime: (d, h, m) => d.setHours(h, m, 0, 0),
  addDays: (d, n) => d.setDate(d.getDate() + n),
  addMonths: (d, n) => d.setMonth(d.getMonth() + n),
  make: (y, month, day, h, m) => new Date(y, month, day, h, m),
};

const UTC_FRAME: CalendarFrame = {
  day: (d) => d.getUTCDay(),
  date: (d) => d.getUTCDate(),
  month: (d) => d.getUTCMonth(),
  year: (d) => d.getUTCFullYear(),
  hours: (d) => d.getUTCHours(),
  minutes: (d) => d.getUTCMinutes(),
  setTime: (d, h, m) => d.setUTCHours(h, m, 0, 0),
  addDays: (d, n) => d.setUTCDate(d.getUTCDate() + n),
  addMonths: (d, n) => d.setUTCMonth(d.getUTCMonth() + n),
  make: (y, month, day, h, m) => new Date(Date.UTC(y, month, day, h, m)),
};

// Next occurrence of a recurring time-anchored item at or after `from`.
// anchor = the first/reference occurrence (eventAt for HAPPEN, createdAt for DO).
export function nextOccurrence(cadence: Cadence, anchorIso: string, from: Date): Date {
  return nextOccurrenceIn(LOCAL_FRAME, cadence, anchorIso, from);
}

function nextOccurrenceIn(f: CalendarFrame, cadence: Cadence, anchorIso: string, from: Date): Date {
  const anchor = new Date(anchorIso);
  // The anchor is a reference point, not automatically an occurrence: a
  // "weekly on Sun" DO created on a Tuesday anchors at that Tuesday, and
  // short-circuiting on it would invent a Tuesday occurrence. Only return the
  // anchor directly when it matches the cadence's own pattern.
  const anchorOnPattern =
    (cadence.freq !== 'weekly' || !cadence.byWeekday?.length || cadence.byWeekday.includes(f.day(anchor))) &&
    (cadence.freq !== 'monthly' || !cadence.byMonthDay || f.date(anchor) === cadence.byMonthDay);
  if (anchor.getTime() >= from.getTime() && anchorOnPattern) return anchor;
  const interval = Math.max(1, cadence.interval || 1);

  if (cadence.freq === 'daily') {
    const periods = Math.ceil((from.getTime() - anchor.getTime()) / (interval * DAY_MS));
    return new Date(anchor.getTime() + periods * interval * DAY_MS);
  }

  if (cadence.freq === 'weekly') {
    const days = cadence.byWeekday?.length ? [...cadence.byWeekday].sort() : [f.day(anchor)];
    // Walk day by day from `from`; bounded (≤ 7 * interval + 7 steps).
    const cursor = new Date(from);
    f.setTime(cursor, f.hours(anchor), f.minutes(anchor));
    if (cursor.getTime() < from.getTime()) f.addDays(cursor, 1);
    for (let i = 0; i < interval * 7 + 8; i++) {
      if (days.includes(f.day(cursor))) {
        // Respect the week interval relative to the anchor's week.
        const weeksFromAnchor = Math.floor((cursor.getTime() - startOfWeek(f, anchor).getTime()) / (7 * DAY_MS));
        if (weeksFromAnchor % interval === 0) return new Date(cursor);
      }
      f.addDays(cursor, 1);
    }
    return cursor;
  }

  if (cadence.freq === 'monthly') {
    const targetDay = cadence.byMonthDay ?? f.date(anchor);
    const cursor = f.make(f.year(from), f.month(from), 1, f.hours(anchor), f.minutes(anchor));
    for (let i = 0; i < 24; i++) {
      const monthsFromAnchor = (f.year(cursor) - f.year(anchor)) * 12 + (f.month(cursor) - f.month(anchor));
      if (monthsFromAnchor >= 0 && monthsFromAnchor % interval === 0) {
        const lastDay = f.date(f.make(f.year(cursor), f.month(cursor) + 1, 0, 12, 0));
        const candidate = f.make(
          f.year(cursor),
          f.month(cursor),
          Math.min(targetDay, lastDay),
          f.hours(anchor),
          f.minutes(anchor),
        );
        if (candidate.getTime() >= from.getTime()) return candidate;
      }
      f.addMonths(cursor, 1);
    }
    return cursor;
  }

  // yearly
  const candidate = f.make(f.year(from), f.month(anchor), f.date(anchor), f.hours(anchor), f.minutes(anchor));
  if (candidate.getTime() >= from.getTime()) return candidate;
  return f.make(f.year(from) + interval, f.month(anchor), f.date(anchor), f.hours(anchor), f.minutes(anchor));
}

// All occurrences within [from, to) — used by the calendar view and push scan.
export function occurrencesBetween(cadence: Cadence, anchorIso: string, from: Date, to: Date, cap = 100): Date[] {
  return occurrencesBetweenIn(LOCAL_FRAME, cadence, anchorIso, from, to, cap);
}

function occurrencesBetweenIn(
  f: CalendarFrame,
  cadence: Cadence,
  anchorIso: string,
  from: Date,
  to: Date,
  cap = 100,
): Date[] {
  const out: Date[] = [];
  let cursor = new Date(from);
  while (out.length < cap) {
    const next = nextOccurrenceIn(f, cadence, anchorIso, cursor);
    if (next.getTime() >= to.getTime()) break;
    out.push(next);
    cursor = new Date(next.getTime() + 60_000);
  }
  return out;
}

// Recurring DOs anchor at cadence.atTime, a wall-clock "HH:MM" in the USER'S
// timezone, and byWeekday names the user's SLEEP days (5am → 5am), not
// calendar days. The two differ only for times in the 12am–5am window:
// "litter boxes Mon/Wed/Fri at 12am" means the midnight that ENDS Monday's
// evening — calendar Tuesday 00:00 — exactly as the date parser's night-owl
// rule reads one-shot phrases. So the walk runs in a frame shifted by the
// user's offset MINUS the sleep cutoff: in that frame the 5am boundary is
// midnight, a frame day IS a sleep day, and an atTime before 5am wraps to
// the tail of its named day. For times from 5am on, the frame day equals
// the calendar day and nothing changes.
const SLEEP_SHIFT_MS = EARLY_MORNING_CUTOFF_MINUTES * 60_000;

function sleepFrameAnchor(cadence: Cadence, createdAtIso: string, frameShiftMs: number): Date {
  const [h, m] = (cadence.atTime ?? '00:00').split(':').map(Number);
  const frameMinutes = (h * 60 + m - EARLY_MORNING_CUTOFF_MINUTES + 1440) % 1440;
  const frame = new Date(new Date(createdAtIso).getTime() + frameShiftMs);
  frame.setUTCHours(Math.floor(frameMinutes / 60), frameMinutes % 60, 0, 0);
  return frame;
}

export function nextAtTimeOccurrence(
  cadence: Cadence,
  createdAtIso: string,
  from: Date,
  tzOffsetMinutes = 0,
): Date {
  const shiftMs = tzOffsetMinutes * 60_000 - SLEEP_SHIFT_MS;
  const anchor = sleepFrameAnchor(cadence, createdAtIso, shiftMs);
  const occ = nextOccurrenceIn(UTC_FRAME, cadence, anchor.toISOString(), new Date(from.getTime() + shiftMs));
  return new Date(occ.getTime() - shiftMs);
}

export function atTimeOccurrencesBetween(
  cadence: Cadence,
  createdAtIso: string,
  from: Date,
  to: Date,
  tzOffsetMinutes = 0,
): Date[] {
  const shiftMs = tzOffsetMinutes * 60_000 - SLEEP_SHIFT_MS;
  const anchor = sleepFrameAnchor(cadence, createdAtIso, shiftMs);
  return occurrencesBetweenIn(
    UTC_FRAME,
    cadence,
    anchor.toISOString(),
    new Date(from.getTime() + shiftMs),
    new Date(to.getTime() + shiftMs),
  ).map((d) => new Date(d.getTime() - shiftMs));
}

function startOfWeek(f: CalendarFrame, d: Date): Date {
  const s = new Date(d);
  f.setTime(s, 0, 0);
  f.addDays(s, -f.day(s));
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
