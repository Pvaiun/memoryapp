import type { Bubble, ItemView } from '../../shared/types';
import { isResolvedForNow } from '../../shared/cadence';
import { sleepDayDiffLocal } from '../../shared/dates';

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

// All day distances here are sleep-cycle days (5am boundary, sleepDayDiffLocal)
// — the app's one day system, shared with the Descent notch and the Brain's
// due=+Nd tokens, so an event at 9am tomorrow says "tomorrow" even when it's
// under 24h away, and every surface prints the same count.

function fmtEventDay(t: number, now: number): string {
  const d = new Date(t);
  if (sleepDayDiffLocal(t, now) < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function bubbleStatus(bubble: Bubble, items: Record<string, ItemView>): BubbleStatus {
  if (bubble.kind === 'rotation') return { tone: 'purple', color: TONE_COLORS.purple, label: 'rehearsal' };
  const now = Date.now();
  let overdue = false;
  let dueToday = false;
  let happeningNow = false;
  let redEventDiff = Infinity; // sleep-day distance of the nearest ≤2-day event
  let soonestDueDays = Infinity; // sleep-day distance of the nearest deadline
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
      const dueDays = sleepDayDiffLocal(due, now);
      if (due < now) overdue = true;
      else if (dueDays <= 0) dueToday = true;
      else if (dueDays < 7) soonestDueDays = Math.min(soonestDueDays, dueDays);
    }
    if (it.neglected) slipped = true;
    if (it.eventAt) {
      const at = new Date(it.eventAt).getTime();
      const end = it.eventEnd ? new Date(it.eventEnd).getTime() : at;
      if (at <= now && end > now - DAY_MS) happeningNow = true;
      else if (at > now && sleepDayDiffLocal(at, now) <= 2) redEventDiff = Math.min(redEventDiff, sleepDayDiffLocal(at, now));
      else if (at > now) nextEvent = Math.min(nextEvent, at);
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
  if (soonestDueDays < Infinity) {
    return {
      tone: 'amber',
      color: TONE_COLORS.amber,
      label: soonestDueDays === 1 ? 'tomorrow' : `${soonestDueDays} days`,
    };
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
