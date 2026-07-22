import type { Bubble, ItemView } from '../../shared/types';
import { isResolvedForNow } from '../../shared/cadence';

// Status = tone + the time word printed on the chip, both from one scan of the
// bubble's ACTIVE items, so the scale needs no legend and completing the
// urgent item downgrades the chip immediately. Tone precedence:
// red > amber > blue > grey; rotation is always purple.
// Shared by both Now renderers (tile mosaic and Descent).

const DAY_MS = 86_400_000;

export type Tone = 'red' | 'amber' | 'blue' | 'grey' | 'purple';

export const TONE_COLORS: Record<Tone, string> = {
  red: 'hsl(348 75% 66%)', // due now / happening now
  amber: 'hsl(40 75% 62%)', // pressing
  blue: 'hsl(215 80% 68%)', // upcoming event
  grey: 'hsl(222 18% 62%)', // standing
  purple: 'hsl(260 30% 55%)', // rotation
};

export interface BubbleStatus {
  tone: Tone;
  color: string;
  label: string;
}

// Calendar-day distance (local), so an event at 9am tomorrow says "tomorrow"
// even when it's under 24h away.
function calDayDiff(t: number, now: number): number {
  const a = new Date(t);
  const b = new Date(now);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}

function fmtEventDay(t: number, now: number): string {
  const d = new Date(t);
  if (calDayDiff(t, now) < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function bubbleStatus(bubble: Bubble, items: Record<string, ItemView>): BubbleStatus {
  if (bubble.kind === 'rotation') return { tone: 'purple', color: TONE_COLORS.purple, label: 'rehearsal' };
  const now = Date.now();
  let overdue = false;
  let dueToday = false;
  let happeningNow = false;
  let redEventDiff = Infinity; // calendar-day distance of the nearest <48h event
  let soonestDue = Infinity;
  let slipped = false;
  let nextEvent = Infinity;
  for (const id of bubble.itemIds) {
    const it = items[id];
    // Done-for-today recurring items go quiet like completed ones — checking
    // off the recycling downgrades the chip the same as any other completion.
    // Passed one-shot events go quiet too: lunch, once eaten, stops being "now".
    if (!it || isResolvedForNow(it, now)) continue;
    if (it.deadline) {
      const due = new Date(it.deadline).getTime();
      if (due < now) overdue = true;
      else if (due < now + DAY_MS) dueToday = true;
      else if (due < now + 7 * DAY_MS) soonestDue = Math.min(soonestDue, due);
    }
    if (it.neglected) slipped = true;
    if (it.eventAt) {
      const at = new Date(it.eventAt).getTime();
      const end = it.eventEnd ? new Date(it.eventEnd).getTime() : at;
      if (at < now + 2 * DAY_MS && end > now - DAY_MS) {
        if (at <= now) happeningNow = true;
        else redEventDiff = Math.min(redEventDiff, calDayDiff(at, now));
      } else if (at > now) nextEvent = Math.min(nextEvent, at);
    }
  }
  if (overdue || dueToday || happeningNow || redEventDiff < Infinity) {
    const label = overdue
      ? 'overdue'
      : happeningNow
        ? 'now'
        : dueToday
          ? 'due today'
          : redEventDiff <= 0
            ? 'today'
            : redEventDiff === 1
              ? 'tomorrow'
              : 'in 2 days';
    return { tone: 'red', color: TONE_COLORS.red, label };
  }
  if (soonestDue < Infinity) {
    const days = Math.max(2, Math.ceil((soonestDue - now) / DAY_MS));
    return { tone: 'amber', color: TONE_COLORS.amber, label: `${days} days` };
  }
  if (slipped) return { tone: 'amber', color: TONE_COLORS.amber, label: 'slipped' };
  if (bubble.prominence >= 0.7) return { tone: 'amber', color: TONE_COLORS.amber, label: 'pressing' };
  if (nextEvent < Infinity) return { tone: 'blue', color: TONE_COLORS.blue, label: fmtEventDay(nextEvent, now) };
  return { tone: 'grey', color: TONE_COLORS.grey, label: 'standing' };
}

export function bubbleCounts(bubble: Bubble, items: Record<string, ItemView>, now = Date.now()) {
  const doneCount = bubble.itemIds.filter((id) => {
    const it = items[id];
    return it && isResolvedForNow(it, now);
  }).length;
  const total = bubble.itemIds.length;
  return { doneCount, total, allDone: total > 0 && doneCount === total };
}
