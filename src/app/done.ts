import type { ItemView } from '../shared/types';
import { doneUntil, isDoneForNow } from '../shared/cadence';

// Client lens on done-for-now (shared/cadence.ts): same derivation, device
// timezone. Every checkbox, pip, and count in the app answers through here so
// a recurring DO reads as checked for the occurrence it just covered.

const localTz = () => -new Date().getTimezoneOffset();

export function isDone(item: ItemView, now = new Date()): boolean {
  return isDoneForNow(item, now, localTz());
}

// When a done-for-now rhythm comes back ("tomorrow", "Sun", "Aug 15"), or null
// when the item isn't in a done-for-now window.
export function comesBackLabel(item: ItemView, now = new Date()): string | null {
  if (item.status !== 'active' || !item.cadence || !item.lastCompletedAt) return null;
  const until = doneUntil(item.cadence, item.lastCompletedAt, item.createdAt, localTz());
  if (now.getTime() >= until.getTime()) return null;
  const a = new Date(until);
  const b = new Date(now);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  const days = Math.round((a.getTime() - b.getTime()) / 86_400_000);
  if (days <= 1) return 'tomorrow';
  if (days < 7) return until.toLocaleDateString([], { weekday: 'short' });
  return until.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
