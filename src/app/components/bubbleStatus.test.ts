import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bubble, ItemView } from '../../shared/types';
import { deriveDeadlineNotch } from '../../shared/cards';
import { bubbleStatus } from './bubbleStatus';

// Day math here runs through the runtime's local timezone; pin it so the
// asserted counts don't depend on where the tests run.
vi.stubEnv('TZ', 'UTC');

// The regression behind these tests: the tile chip counted rolling 24h
// windows (ceil) while the Descent notch counted calendar days, so the same
// deadline read "5 DAYS" on one screen and "4 DAYS" on the other. Both must
// count sleep-cycle days (5am boundary) — one system, one number.

const item = (over: Partial<ItemView>): ItemView =>
  ({
    id: 'x',
    type: 'DO',
    title: 'Call the doctor',
    status: 'active',
    deadline: null,
    deadlineHardness: null,
    datePrecision: 'time',
    cadence: null,
    doneToday: false,
    eventAt: null,
    eventEnd: null,
    neglected: false,
    themes: [],
    ...over,
  }) as unknown as ItemView;

const bubble = (itemIds: string[]): Bubble =>
  ({ id: 'b', kind: 'situation', prominence: 0.4, itemIds }) as unknown as Bubble;

describe('countdown badges agree across surfaces (sleep-cycle days)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('chip and notch print the same day count for the same deadline', () => {
    // Deadline 4 days and 3 hours from now: the rolling-ceil chip used to say
    // "5 days" while the midnight-diff notch said "4 days".
    const now = Date.parse('2026-07-23T09:00:00Z');
    vi.setSystemTime(now);
    const due = new Date(now + 4 * 86_400_000 + 3 * 3_600_000).toISOString();
    const it1 = item({ deadline: due, deadlineHardness: 'hard' });

    const chip = bubbleStatus(bubble(['x']), { x: it1 });
    const notch = deriveDeadlineNotch([it1], now);

    expect(notch).not.toBeNull();
    expect(chip.label).toBe(`${notch!.days} days`);
  });

  it('a deadline one sleep day out reads "tomorrow", not "2 days"', () => {
    const now = Date.parse('2026-07-23T09:00:00Z');
    vi.setSystemTime(now);
    const due = new Date(now + 30 * 3_600_000).toISOString(); // tomorrow afternoon
    const chip = bubbleStatus(bubble(['x']), { x: item({ deadline: due, deadlineHardness: 'hard' }) });
    expect(chip.tone).toBe('amber');
    expect(chip.label).toBe('tomorrow');
  });
});

describe('an all-day deadline does not go red at midday', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // "Do the cat litters, today" — captured with no time, stored at the local
  // noon anchor. The chip used to compare that anchor to the clock, so the
  // card turned red "overdue" at 12:01pm every single day, while the notch
  // (which counts whole sleep-days) still read TODAY on the same card.
  const litters = () =>
    item({ deadline: '2026-07-26T12:00:00.000Z', deadlineHardness: 'hard', datePrecision: 'day' });

  it('reads "due today" all day, not "overdue" from 12:01pm', () => {
    vi.setSystemTime(Date.parse('2026-07-26T12:01:00Z'));
    expect(bubbleStatus(bubble(['x']), { x: litters() }).label).toBe('due today');
    vi.setSystemTime(Date.parse('2026-07-26T23:30:00Z'));
    expect(bubbleStatus(bubble(['x']), { x: litters() }).label).toBe('due today');
  });

  it('agrees with the notch on the same card at the same minute', () => {
    const now = Date.parse('2026-07-26T13:39:00Z');
    vi.setSystemTime(now);
    const it1 = litters();
    expect(deriveDeadlineNotch([it1], now)!.label).toBe('today');
    expect(bubbleStatus(bubble(['x']), { x: it1 }).label).toBe('due today');
  });

  it('turns over at the 5am boundary, with the map rebuild', () => {
    vi.setSystemTime(Date.parse('2026-07-27T04:59:00Z'));
    expect(bubbleStatus(bubble(['x']), { x: litters() }).label).toBe('due today');
    vi.setSystemTime(Date.parse('2026-07-27T05:00:00Z'));
    expect(bubbleStatus(bubble(['x']), { x: litters() }).label).toBe('overdue');
  });

  it('a timed deadline still goes overdue the moment it passes', () => {
    const timed = () =>
      item({ deadline: '2026-07-26T19:00:00.000Z', deadlineHardness: 'hard', datePrecision: 'time' });
    vi.setSystemTime(Date.parse('2026-07-26T18:00:00Z'));
    expect(bubbleStatus(bubble(['x']), { x: timed() }).label).toBe('due today');
    vi.setSystemTime(Date.parse('2026-07-26T19:30:00Z'));
    expect(bubbleStatus(bubble(['x']), { x: timed() }).label).toBe('overdue');
  });

  it('a rhythm whose hour went by unticked reads "went by"', () => {
    // "Speak French with Kayla", daily at 7pm — no deadline, so not overdue;
    // its moment today is simply behind us.
    const french = () =>
      item({ cadence: { freq: 'daily', interval: 1, atTime: '19:00' }, createdAt: '2026-07-01T09:00:00.000Z' });
    vi.setSystemTime(Date.parse('2026-07-26T18:00:00Z'));
    expect(bubbleStatus(bubble(['x']), { x: french() }).label).not.toBe('went by');
    vi.setSystemTime(Date.parse('2026-07-26T22:40:00Z'));
    expect(bubbleStatus(bubble(['x']), { x: french() }).label).toBe('went by');
  });
});
