import type { Cadence } from './types';

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
  if (anchor.getTime() >= from.getTime()) return anchor;
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

function startOfWeek(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - s.getDay());
  return s;
}

// Human-readable cadence, for the UI.
export function describeCadence(cadence: Cadence): string {
  const interval = Math.max(1, cadence.interval || 1);
  const every = interval === 1 ? 'every' : `every ${interval}`;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  switch (cadence.freq) {
    case 'daily':
      return interval === 1 ? 'daily' : `every ${interval} days`;
    case 'weekly':
      if (cadence.byWeekday?.length) {
        const days = cadence.byWeekday.map((d) => WEEKDAYS[d]).join(', ');
        return interval === 1 ? `weekly on ${days}` : `${every} weeks on ${days}`;
      }
      return interval === 1 ? 'weekly' : `every ${interval} weeks`;
    case 'monthly':
      return interval === 1 ? 'monthly' : `every ${interval} months`;
    case 'yearly':
      return interval === 1 ? 'yearly' : `every ${interval} years`;
  }
}
