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
