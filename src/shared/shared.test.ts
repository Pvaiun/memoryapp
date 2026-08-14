import { describe, expect, it } from 'vitest';
import { deriveFlavour } from './flavour';
import { effectivePriority, decayedBoost, PRIORITY_BASE, RECAPTURE_BOOST, priorityLabel } from './priority';
import { atTimeOccurrencesBetween, completedWithinSleepDay, deadlinePassed, eventPassed, happeningToday, isNeglected, isResolvedForNow, momentPassed, nextAtTimeOccurrence, nextLatenessBoundary, nextOccurrence, occurrencesBetween, cadencePeriodMs, describeCadence, rollEventAnchor } from './cadence';
import { expandBareOrdinals, refineWithSourceTime, resolveDatePhrase, inferHardness, inferOptionality, dayKey, sleepDayDiff, sleepDayKey, snoozeActive } from './dates';
import { heuristicParse, parseCadencePhrase } from './heuristicParse';
import type { Cadence } from './types';

const base = {
  type: 'DO' as const,
  pingNatured: false,
  deadline: null,
  deadlineHardness: null,
  cadence: null,
  flavourOverride: null,
};

describe('flavour derivation (§4, first match wins)', () => {
  it('KNOW → Note', () => {
    expect(deriveFlavour({ ...base, type: 'KNOW' })).toBe('Note');
  });
  it('HAPPEN → Event', () => {
    expect(deriveFlavour({ ...base, type: 'HAPPEN' })).toBe('Event');
  });
  it('ping-natured DO → Reminder, even with a hard deadline (rule 3 first)', () => {
    expect(deriveFlavour({ ...base, pingNatured: true })).toBe('Reminder');
    expect(
      deriveFlavour({ ...base, pingNatured: true, deadline: '2026-07-21T18:00:00Z', deadlineHardness: 'hard' }),
    ).toBe('Reminder');
  });
  it('hard deadline DO → Task', () => {
    expect(deriveFlavour({ ...base, deadline: '2026-07-21T12:00:00Z', deadlineHardness: 'hard' })).toBe('Task');
  });
  it('cadence + no hard deadline → Goal, soft deadline is invisible to derivation', () => {
    const cadence: Cadence = { freq: 'daily', interval: 1 };
    expect(deriveFlavour({ ...base, cadence })).toBe('Goal');
    expect(
      deriveFlavour({ ...base, cadence, deadline: '2026-07-31T12:00:00Z', deadlineHardness: 'soft' }),
    ).toBe('Goal');
  });
  it('plain DO → Task (default)', () => {
    expect(deriveFlavour(base)).toBe('Task');
  });
  it('override wins and is presentation-only', () => {
    expect(deriveFlavour({ ...base, type: 'KNOW', flavourOverride: 'Reminder' })).toBe('Reminder');
  });
});

describe('priority (§9.3)', () => {
  const now = new Date('2026-07-20T12:00:00Z');
  it('user edit takes precedence', () => {
    expect(
      effectivePriority({ priorityBase: 0.25, priorityBoost: 0.6, boostUpdatedAt: now.toISOString(), userPriority: 0.9 }, now),
    ).toBe(0.9);
  });
  it('base + fresh boost', () => {
    const v = effectivePriority(
      { priorityBase: PRIORITY_BASE.low, priorityBoost: RECAPTURE_BOOST, boostUpdatedAt: now.toISOString(), userPriority: null },
      now,
    );
    expect(v).toBeCloseTo(0.4);
  });
  it('boost decays with a 21-day half-life', () => {
    const past = new Date(now.getTime() - 21 * 86_400_000).toISOString();
    expect(decayedBoost(0.3, past, now)).toBeCloseTo(0.15);
  });
  it('clamps to [0,1] and labels bands', () => {
    const v = effectivePriority(
      { priorityBase: 0.75, priorityBoost: 0.9, boostUpdatedAt: now.toISOString(), userPriority: null },
      now,
    );
    expect(v).toBe(1);
    expect(priorityLabel(0.8)).toBe('high');
    expect(priorityLabel(0.5)).toBe('medium');
    expect(priorityLabel(0.2)).toBe('low');
  });
});

describe('cadence & neglect (§3.1, §7.2)', () => {
  const now = new Date('2026-07-20T12:00:00Z');
  it('neglect = now − lastCompleted vs cadence, with grace', () => {
    const daily: Cadence = { freq: 'daily', interval: 1 };
    expect(isNeglected(daily, '2026-07-19T12:00:00Z', '2026-07-01T00:00:00Z', now)).toBe(false);
    expect(isNeglected(daily, '2026-07-17T12:00:00Z', '2026-07-01T00:00:00Z', now)).toBe(true);
  });
  it('falls back to createdAt when never completed', () => {
    const weekly: Cadence = { freq: 'weekly', interval: 1 };
    expect(isNeglected(weekly, null, '2026-07-01T00:00:00Z', now)).toBe(true);
    expect(isNeglected(weekly, null, '2026-07-18T00:00:00Z', now)).toBe(false);
  });
  it('3x-a-week style shrinks the effective period', () => {
    const threePerWeek: Cadence = { freq: 'weekly', interval: 1, byWeekday: [1, 3, 5] };
    expect(cadencePeriodMs(threePerWeek)).toBeCloseTo((7 / 3) * 86_400_000);
  });
  it('nextOccurrence daily', () => {
    const daily: Cadence = { freq: 'daily', interval: 2 };
    const next = nextOccurrence(daily, '2026-07-10T09:00:00Z', new Date('2026-07-20T12:00:00Z'));
    expect(next.toISOString()).toBe('2026-07-22T09:00:00.000Z');
  });
  it('an off-pattern anchor is a reference point, not an occurrence', () => {
    // "weekly on Sunday" anchored at a Tuesday (item created that day): the
    // next occurrence is Sunday, not the anchor itself echoed back.
    const weeklySun: Cadence = { freq: 'weekly', interval: 1, byWeekday: [0] };
    const next = nextOccurrence(weeklySun, '2026-07-21T15:00:00Z', new Date('2026-07-21T04:00:00Z'));
    expect(next.getDay()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(new Date('2026-07-25T00:00:00Z').getTime());
  });
  it('occurrencesBetween respects the window', () => {
    const daily: Cadence = { freq: 'daily', interval: 1 };
    const occ = occurrencesBetween(daily, '2026-07-01T08:00:00Z', new Date('2026-07-20T00:00:00Z'), new Date('2026-07-23T00:00:00Z'));
    expect(occ.length).toBe(3);
  });
  it('describes cadences', () => {
    expect(describeCadence({ freq: 'daily', interval: 1 })).toBe('daily');
    expect(describeCadence({ freq: 'weekly', interval: 1, byWeekday: [1] })).toContain('Mon');
  });
  it('describes the anchor time in the user clock', () => {
    expect(describeCadence({ freq: 'weekly', interval: 1, byWeekday: [4], atTime: '20:00' })).toBe('weekly on Thu at 8pm');
    expect(describeCadence({ freq: 'daily', interval: 1, atTime: '09:30' })).toBe('daily at 9:30am');
  });
  it('completedWithinSleepDay: done-for-today is bounded by the USER-LOCAL sleep-cycle day', () => {
    // now = July 20 08:00 local at UTC-4 (12:00Z). The sleep day rolls at 5am
    // local, so "today" spans 2026-07-20T09:00Z .. 2026-07-21T09:00Z.
    const now = new Date('2026-07-20T12:00:00Z');
    const tz = -240;
    expect(completedWithinSleepDay(null, now, tz)).toBe(false);
    // Completed an hour ago — done today.
    expect(completedWithinSleepDay('2026-07-20T11:00:00Z', now, tz)).toBe(true);
    // 01:30Z is 21:30 July 19 local — yesterday, not today.
    expect(completedWithinSleepDay('2026-07-20T01:30:00Z', now, tz)).toBe(false);
    // 00:30 local is before the 5am cutoff — that completion was last night's.
    expect(completedWithinSleepDay('2026-07-20T04:30:00Z', now, tz)).toBe(false);
    // Yesterday evening's completion released by wake-up.
    expect(completedWithinSleepDay('2026-07-19T23:00:00Z', now, tz)).toBe(false);
  });
  it('completedWithinSleepDay: a 9:30pm completion stays done past midnight, releases on waking', () => {
    const tz = -240;
    // Done Tuesday July 21 21:30 local (Wed 01:30Z).
    const doneAt = '2026-07-22T01:30:00Z';
    // Still up at 12:30am (04:30Z) — same sleep day, still checked.
    expect(completedWithinSleepDay(doneAt, new Date('2026-07-22T04:30:00Z'), tz)).toBe(true);
    // Awake Wednesday 09:00 local (13:00Z) — released for the next occurrence.
    expect(completedWithinSleepDay(doneAt, new Date('2026-07-22T13:00:00Z'), tz)).toBe(false);
  });
  it('walks atTime occurrences in the user frame, returning UTC instants', () => {
    // "every Thursday at 8pm" at UTC-4: local Thursday 20:00 is Friday 00:00
    // UTC — the walk must match byWeekday against LOCAL days, not UTC days.
    const weekly: Cadence = { freq: 'weekly', interval: 1, byWeekday: [4], atTime: '20:00' };
    const next = nextAtTimeOccurrence(weekly, '2026-07-01T12:00:00Z', new Date('2026-07-20T00:00:00Z'), -240);
    expect(next.toISOString()).toBe('2026-07-24T00:00:00.000Z');
    const occ = atTimeOccurrencesBetween(
      weekly,
      '2026-07-01T12:00:00Z',
      new Date('2026-07-20T00:00:00Z'),
      new Date('2026-08-03T00:00:00Z'),
      -240,
    );
    expect(occ.map((d) => d.toISOString())).toEqual(['2026-07-24T00:00:00.000Z', '2026-07-31T00:00:00.000Z']);
  });
  it('byWeekday names SLEEP days: a 12am–5am atTime lands at the END of its named day', () => {
    // "litter boxes weekly on Mon, Wed, Fri at 12am" at UTC-4. Under the 5am
    // sleep-day rule, "Monday at 12am" is the midnight that ends Monday's
    // evening — calendar Tuesday 00:00 local — exactly how the night-owl
    // parse rule reads one-shot phrases. So the occurrence grid is calendar
    // Tue/Thu/Sat 00:00 local, while everything shown to the user keeps
    // saying Mon/Wed/Fri.
    const cadence: Cadence = { freq: 'weekly', interval: 1, byWeekday: [1, 3, 5], atTime: '00:00' };
    // From Monday's sleep-day start (Mon Aug 3 05:00 local, 09:00Z): Monday
    // night is a litter night — calendar Tue Aug 4 00:00 local (04:00Z).
    const fromMonday = nextAtTimeOccurrence(cadence, '2026-07-31T18:00:00Z', new Date('2026-08-03T09:00:00Z'), -240);
    expect(fromMonday.toISOString()).toBe('2026-08-04T04:00:00.000Z');
    // From Tuesday's sleep-day start: Tuesday is NOT a litter day — the next
    // slot is Wednesday night (calendar Thu Aug 6 00:00 local).
    const fromTuesday = nextAtTimeOccurrence(cadence, '2026-07-31T18:00:00Z', new Date('2026-08-04T09:00:00Z'), -240);
    expect(fromTuesday.toISOString()).toBe('2026-08-06T04:00:00.000Z');
  });
  it('atTime walk gives the same answer on any host clock (it once read Mon/Wed/Fri as Thu in the browser)', () => {
    // The walk used to read host-LOCAL fields of its shifted timeline, so
    // the browser (host clock = user clock) and the UTC-hosted worker could
    // disagree by a day about the same cadence. Same computation, two host
    // clocks, one answer — that's the regression guard.
    const cadence: Cadence = { freq: 'weekly', interval: 1, byWeekday: [1, 3, 5], atTime: '00:00' };
    const compute = () =>
      nextAtTimeOccurrence(cadence, '2026-07-31T18:00:00Z', new Date('2026-08-04T09:00:00Z'), -240).toISOString();
    // tsconfig has no Node types; reach the test runner's env via globalThis.
    const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
    const prevTz = env.TZ;
    try {
      env.TZ = 'UTC'; // the worker's frame
      expect(compute()).toBe('2026-08-06T04:00:00.000Z');
      env.TZ = 'America/Toronto'; // the browser's frame — host clock IS the user clock
      expect(compute()).toBe('2026-08-06T04:00:00.000Z');
    } finally {
      if (prevTz === undefined) delete env.TZ;
      else env.TZ = prevTz;
    }
  });
});

describe('captured-today relevance (§9.1, Now screen)', () => {
  // A UTC user, Wednesday 2026-07-22 18:00. Sleep day = Jul 22 05:00 → Jul 23 05:00.
  const now = new Date('2026-07-22T18:00:00Z');
  const tz = 0;
  const item = (over: Partial<Parameters<typeof happeningToday>[0]>) => ({
    deadline: null,
    eventAt: null,
    eventEnd: null,
    cadence: null,
    createdAt: '2026-07-22T17:00:00Z',
    ...over,
  });

  it('undated captures stay out of the map', () => {
    expect(happeningToday(item({}), now, tz)).toBe(false);
  });
  it("deadline tonight qualifies; overdue still carries today's pressure", () => {
    expect(happeningToday(item({ deadline: '2026-07-22T22:00:00Z' }), now, tz)).toBe(true);
    expect(happeningToday(item({ deadline: '2026-07-20T12:00:00Z' }), now, tz)).toBe(true);
  });
  it('a future deadline waits for its day', () => {
    expect(happeningToday(item({ deadline: '2026-07-23T09:00:00Z' }), now, tz)).toBe(false);
  });
  it('the sleep-cycle boundary: due 2am "tomorrow" is still tonight', () => {
    expect(happeningToday(item({ deadline: '2026-07-23T02:00:00Z' }), now, tz)).toBe(true);
  });
  it('events qualify only when their span touches today', () => {
    expect(happeningToday(item({ eventAt: '2026-07-22T19:00:00Z' }), now, tz)).toBe(true);
    expect(happeningToday(item({ eventAt: '2026-07-23T19:00:00Z' }), now, tz)).toBe(false);
    expect(
      happeningToday(item({ eventAt: '2026-07-20T12:00:00Z', eventEnd: '2026-07-25T12:00:00Z' }), now, tz),
    ).toBe(true);
    expect(happeningToday(item({ eventAt: '2026-07-21T12:00:00Z' }), now, tz)).toBe(false);
  });
  it('a daily rhythm is live today; weekly-on-Sunday waits for Sunday', () => {
    expect(happeningToday(item({ cadence: { freq: 'daily', interval: 1 } }), now, tz)).toBe(true);
    expect(
      happeningToday(item({ cadence: { freq: 'weekly', interval: 1, byWeekday: [0] } }), now, tz),
    ).toBe(false);
  });
  it('an atTime rhythm whose next ping lands today qualifies', () => {
    expect(
      happeningToday(item({ cadence: { freq: 'daily', interval: 1, atTime: '21:00' } }), now, tz),
    ).toBe(true);
  });
  it('a 12am rhythm is today on the days it NAMES: Mon/Wed/Fri never claims a Tuesday', () => {
    // "litter boxes Mon/Wed/Fri at 12am": Wednesday qualifies — its midnight
    // comes at the end of Wednesday's evening. Tuesday does not, even though
    // calendar Wednesday 00:00 falls inside Tuesday's sleep day.
    const litter = { freq: 'weekly' as const, interval: 1, byWeekday: [1, 3, 5], atTime: '00:00' };
    expect(happeningToday(item({ cadence: litter }), now, tz)).toBe(true); // Wednesday
    const tuesday = new Date('2026-07-21T18:00:00Z');
    expect(happeningToday(item({ cadence: litter, createdAt: '2026-07-20T17:00:00Z' }), tuesday, tz)).toBe(false);
  });
});

describe('passed events read as done (Now screen)', () => {
  const now = new Date('2026-07-22T18:00:00Z').getTime();
  it('a one-shot event is spent an hour after it ends', () => {
    expect(
      eventPassed({ eventAt: '2026-07-22T12:00:00Z', eventEnd: '2026-07-22T13:00:00Z', cadence: null }, now),
    ).toBe(true);
    // still inside the grace hour — lunch may be running long
    expect(
      eventPassed({ eventAt: '2026-07-22T16:00:00Z', eventEnd: '2026-07-22T17:30:00Z', cadence: null }, now),
    ).toBe(false);
    // no end time: the start anchors the grace
    expect(eventPassed({ eventAt: '2026-07-22T16:00:00Z', eventEnd: null, cadence: null }, now)).toBe(true);
    expect(eventPassed({ eventAt: '2026-07-22T19:00:00Z', eventEnd: null, cadence: null }, now)).toBe(false);
  });
  it('recurring events re-arm per occurrence; they never go spent', () => {
    expect(
      eventPassed(
        { eventAt: '2026-07-01T12:00:00Z', eventEnd: null, cadence: { freq: 'weekly', interval: 1 } },
        now,
      ),
    ).toBe(false);
  });
  it("occurrencePassedForNow: a recurring occurrence spent TODAY settles like a one-shot", () => {
    // Bi-weekly Wednesday 2pm; today (Jul 22) is on-grid. now = 6pm UTC.
    const appt = {
      cadence: { freq: 'weekly', interval: 2, byWeekday: [3] } as Cadence,
      eventAt: '2026-07-22T14:00:00.000Z',
      eventEnd: null,
      datePrecision: 'time' as const,
    };
    const base = { status: 'active', doneToday: false };
    // 6pm: the 2pm occurrence + grace has gone — resolved for now.
    expect(isResolvedForNow({ ...base, ...appt }, now, 0)).toBe(true);
    // 2:30pm: inside the grace hour — still live.
    expect(isResolvedForNow({ ...base, ...appt }, new Date('2026-07-22T14:30:00Z').getTime(), 0)).toBe(false);
    // Morning of: not yet.
    expect(isResolvedForNow({ ...base, ...appt }, new Date('2026-07-22T10:00:00Z').getTime(), 0)).toBe(false);
    // Off-grid day (tomorrow): nothing of today's to spend.
    expect(isResolvedForNow({ ...base, ...appt }, new Date('2026-07-23T18:00:00Z').getTime(), 0)).toBe(false);
    // Day-precision recurrences stay live all their day.
    expect(
      isResolvedForNow({ ...base, ...appt, datePrecision: 'day' as const }, now, 0),
    ).toBe(false);
  });

  it('rollEventAnchor: a spent occurrence rolls to the next slot on the same grid', () => {
    // Bi-weekly Wednesday 2pm, anchor Jul 8; from Jul 21 the next slot is
    // Jul 22 — same weekday, same time. This is what stops a bi-weekly
    // appointment reading "overdue" off its own first date.
    const rolled = rollEventAnchor(
      {
        cadence: { freq: 'weekly', interval: 2, byWeekday: [3] },
        eventAt: '2026-07-08T14:00:00.000Z',
        eventEnd: null,
      },
      new Date('2026-07-21T05:00:00Z'),
    );
    expect(rolled.eventAt).toBe('2026-07-22T14:00:00.000Z');
    expect(rolled.eventEnd).toBeNull();
  });
  it('rollEventAnchor: a multi-day span keeps its shape', () => {
    const rolled = rollEventAnchor(
      {
        cadence: { freq: 'monthly', interval: 1, byMonthDay: 8 },
        eventAt: '2026-07-08T09:00:00.000Z',
        eventEnd: '2026-07-10T17:00:00.000Z',
      },
      new Date('2026-07-21T05:00:00Z'),
    );
    expect(rolled.eventAt).toBe('2026-08-08T09:00:00.000Z');
    expect(rolled.eventEnd).toBe('2026-08-10T17:00:00.000Z');
  });
  it('isResolvedForNow: checked off OR closed OR already happened', () => {
    const base = { status: 'active', cadence: null, doneToday: false, eventAt: null, eventEnd: null };
    expect(isResolvedForNow(base, now)).toBe(false);
    expect(isResolvedForNow({ ...base, status: 'completed' }, now)).toBe(true);
    expect(isResolvedForNow({ ...base, eventAt: '2026-07-22T12:00:00Z' }, now)).toBe(true);
    // Every lifecycle exit quiets the item on the map, same as a completion.
    expect(isResolvedForNow({ ...base, status: 'dismissed' }, now)).toBe(true);
    expect(isResolvedForNow({ ...base, status: 'passed' }, now)).toBe(true);
    expect(isResolvedForNow({ ...base, status: 'missed' }, now)).toBe(true);
  });
});

describe('deterministic dates (§12)', () => {
  const ref = new Date('2026-07-20T15:00:00Z'); // a Monday
  it('resolves relative phrases forward', () => {
    const r = resolveDatePhrase('next Tuesday', ref, 0);
    expect(r).not.toBeNull();
    expect(r!.iso.startsWith('2026-07-28')).toBe(true);
  });
  it('respects the client timezone offset', () => {
    // 23:30 UTC on the 20th is 01:30 on the 21st at UTC+2 — different local
    // days, so the same instant resolves differently per timezone. (At UTC+2
    // it's also pre-cutoff: 01:30's "tomorrow at 9am" is the coming morning.)
    const lateNight = new Date('2026-07-20T23:30:00Z');
    const utc = resolveDatePhrase('tomorrow at 9am', lateNight, 0)!;
    const plus2 = resolveDatePhrase('tomorrow at 9am', lateNight, 120)!;
    expect(utc.iso).toBe('2026-07-21T09:00:00.000Z'); // 23:30 local → next day 9am
    expect(plus2.iso).toBe('2026-07-21T07:00:00.000Z'); // 01:30 local → 9am that same morning
  });
  it('captures explicit times', () => {
    const r = resolveDatePhrase('tomorrow at 3pm', ref, 0)!;
    expect(r.hasTime).toBe(true);
    expect(new Date(r.iso).getUTCHours()).toBe(15);
  });
  it('hardness defaults hard, softened by low-pressure phrasing', () => {
    expect(inferHardness('taxes due the 15th')).toBe('hard');
    expect(inferHardness('finish reading by month-end, ideally')).toBe('soft');
    expect(inferHardness('sometime next week, no rush')).toBe('soft');
  });
  it('optionality from phrasing', () => {
    expect(inferOptionality('maybe repot the plants')).toBe('nice');
    expect(inferOptionality('submit the required form')).toBe('must');
  });
  it('dayKey formats local date', () => {
    expect(dayKey(new Date(2026, 6, 20))).toBe('2026-07-20');
  });
  it('resolves bare day ordinals via deterministic month expansion', () => {
    // ref is July 19 — "the 20th" means July 20.
    const r = resolveDatePhrase('the 20th', new Date('2026-07-19T15:00:00Z'), 0);
    expect(r?.iso.startsWith('2026-07-20')).toBe(true);
    // An ordinal before today's day-of-month rolls to next month.
    const r2 = resolveDatePhrase('the 5th', new Date('2026-07-19T15:00:00Z'), 0);
    expect(r2?.iso.startsWith('2026-08-05')).toBe(true);
  });
  it('resolves ordinal ranges with start and end ("the 20th to the 25th")', () => {
    const r = resolveDatePhrase('the 20th to the 25th', new Date('2026-07-19T15:00:00Z'), 0);
    expect(r?.iso.startsWith('2026-07-20')).toBe(true);
    expect(r?.endIso?.startsWith('2026-07-25')).toBe(true);
  });
  it('resolves explicit ranges with end dates', () => {
    const r = resolveDatePhrase('July 20 to July 25', new Date('2026-07-19T15:00:00Z'), 0);
    expect(r?.endIso?.startsWith('2026-07-25')).toBe(true);
  });
  it('night-owl rule: before 5am, "tomorrow" means the coming morning', () => {
    // 12:31am on July 20 (UTC): "tomorrow" is July 20's morning, not July 21.
    const r = resolveDatePhrase('tomorrow', new Date('2026-07-20T00:31:00Z'), 0)!;
    expect(r.iso).toBe('2026-07-20T12:00:00.000Z');
    // Same wall-clock moment at UTC+2 (00:31 local on the 20th).
    const r2 = resolveDatePhrase('tomorrow', new Date('2026-07-19T22:31:00Z'), 120)!;
    expect(r2.iso).toBe('2026-07-20T10:00:00.000Z'); // July 20 noon local
    // After the cutoff, "tomorrow" is the next calendar day again.
    const r3 = resolveDatePhrase('tomorrow', new Date('2026-07-20T06:00:00Z'), 0)!;
    expect(r3.iso).toBe('2026-07-21T12:00:00.000Z');
  });
  it('night-owl rule keeps explicit times: "tomorrow at 9am" at 12:31am = 9am today', () => {
    const r = resolveDatePhrase('tomorrow at 9am', new Date('2026-07-20T00:31:00Z'), 0)!;
    expect(r.iso).toBe('2026-07-20T09:00:00.000Z');
    expect(r.hasTime).toBe(true);
  });
  it('date-only phrases anchor to noon local, not capture time', () => {
    const r = resolveDatePhrase('next Tuesday', new Date('2026-07-20T15:47:00Z'), 0)!;
    expect(r.iso).toBe('2026-07-28T12:00:00.000Z');
    const r2 = resolveDatePhrase('next Tuesday', new Date('2026-07-20T15:47:00Z'), -300)!;
    expect(r2.iso).toBe('2026-07-28T17:00:00.000Z'); // noon at UTC-5
  });
  it('refineWithSourceTime recovers a clock time the phrase extraction dropped', () => {
    // Captured 12:34 local (UTC-4): phrase came back as "today" (noon anchor),
    // but the raw text says "before 3:00 p.m." — recover 15:00 local.
    const ref = new Date('2026-07-20T16:34:00Z');
    const dateOnly = resolveDatePhrase('today', ref, -240)!;
    expect(dateOnly.hasTime).toBe(false);
    const refined = refineWithSourceTime(dateOnly, 'put laundry away before 3:00 p.m.', ref, -240)!;
    expect(refined.hasTime).toBe(true);
    expect(refined.iso).toBe('2026-07-20T19:00:00.000Z'); // 3pm at UTC-4
  });
  it('refineWithSourceTime leaves timed results and cross-day source times alone', () => {
    const ref = new Date('2026-07-20T16:34:00Z');
    const timed = resolveDatePhrase('3pm', ref, -240)!;
    expect(refineWithSourceTime(timed, 'whatever 9am', ref, -240)!.iso).toBe(timed.iso);
    // Phrase resolved to NEXT Friday; source's "3pm" is today — different local
    // day, so no hijack.
    const friday = resolveDatePhrase('Friday', ref, -240)!;
    const out = refineWithSourceTime(friday, 'do it by 3pm on some other note', ref, -240)!;
    expect(out.iso).toBe(friday.iso);
  });
  it('expandBareOrdinals leaves month-bearing and relative phrases alone', () => {
    const ref = new Date('2026-07-19T15:00:00Z');
    expect(expandBareOrdinals('July 20th', ref)).toBe('July 20th');
    expect(expandBareOrdinals('tomorrow', ref)).toBe('tomorrow');
    expect(expandBareOrdinals('next Tuesday', ref)).toBe('next Tuesday');
  });
});

describe('heuristic fallback parser', () => {
  const ref = new Date('2026-07-20T15:00:00Z');
  it('classifies a ping', () => {
    const r = heuristicParse('remind me to take the bins out tomorrow', ref, 0);
    expect(r.items[0].type).toBe('DO');
    expect(r.items[0].pingNatured).toBe(true);
    expect(r.items[0].deadlinePhrase).toBe('tomorrow');
  });
  it('classifies a fact', () => {
    const r = heuristicParse('Sarah is allergic to nuts', ref, 0);
    expect(r.items[0].type).toBe('KNOW');
  });
  it('classifies an event', () => {
    const r = heuristicParse("doctor's appointment Tuesday 3pm", ref, 0);
    expect(r.items[0].type).toBe('HAPPEN');
    expect(r.items[0].eventAtPhrase).toBeTruthy();
  });
  it('detects cadence', () => {
    expect(parseCadencePhrase('read my anxiety book 30 min a day')).toEqual({ freq: 'daily', interval: 1 });
    expect(parseCadencePhrase('water the plants every monday')).toEqual({ freq: 'weekly', interval: 1, byWeekday: [1] });
  });
  it('splits on newlines only and is always low-confidence', () => {
    const r = heuristicParse('call the dentist\nSarah is allergic to nuts', ref, 0);
    expect(r.items.length).toBe(2);
    expect(r.confidence).toBe('low');
  });
  it('anchors a recurring DO to its stated clock time', () => {
    const r = heuristicParse('take out garbage every thursday at 8:00 pm', ref, -240);
    expect(r.items[0].type).toBe('DO');
    expect(r.items[0].cadence).toEqual({ freq: 'weekly', interval: 1, byWeekday: [4], atTime: '20:00' });
    // The time lives in the cadence, not a one-shot deadline; the title keeps
    // neither the date phrase nor a dangling "every".
    expect(r.items[0].deadlinePhrase).toBeNull();
    expect(r.items[0].title).toBe('Take out garbage');
  });
  it('a recurring DO without a stated time gets no atTime', () => {
    const r = heuristicParse('water the plants every monday', ref, 0);
    expect(r.items[0].cadence).toEqual({ freq: 'weekly', interval: 1, byWeekday: [1] });
  });
});

describe('sleepDayDiff — the one day-counting system (5am boundary)', () => {
  const tz = -240; // UTC-4

  it('counts whole sleep days, not rolling 24h windows', () => {
    // 9am local Jul 23 → noon local Jul 27: 4.1×24h away, but 4 days — the
    // rolling ceil/round variants printed 5 while the calendar diff said 4.
    expect(sleepDayDiff(Date.parse('2026-07-27T16:00:00Z'), Date.parse('2026-07-23T13:00:00Z'), tz)).toBe(4);
  });

  it('a 1am deadline belongs to the evening before it (the dishes case)', () => {
    // Tuesday 10pm local; "do the dishes at 1am" is still Tuesday's day.
    expect(sleepDayDiff(Date.parse('2026-07-22T05:00:00Z'), Date.parse('2026-07-22T02:00:00Z'), tz)).toBe(0);
  });

  it('the boundary sits exactly at 5am local', () => {
    const now = Date.parse('2026-07-22T02:00:00Z'); // Tuesday 10pm local
    expect(sleepDayDiff(Date.parse('2026-07-22T08:59:00Z'), now, tz)).toBe(0); // 4:59am Wednesday
    expect(sleepDayDiff(Date.parse('2026-07-22T09:00:00Z'), now, tz)).toBe(1); // 5:00am Wednesday
  });

  it('negative for past sleep days', () => {
    expect(sleepDayDiff(Date.parse('2026-07-20T16:00:00Z'), Date.parse('2026-07-23T13:00:00Z'), tz)).toBe(-3);
  });
});

describe('sleepDayKey — the map day the 5am cron builds', () => {
  const tz = -240; // UTC-4

  it('rolls at 5am local, not midnight', () => {
    // 4:59am Wednesday local is still Tuesday's map…
    expect(sleepDayKey(Date.parse('2026-07-22T08:59:00Z'), tz)).toBe('2026-07-21');
    // …and 5:00am is the new day the cron builds.
    expect(sleepDayKey(Date.parse('2026-07-22T09:00:00Z'), tz)).toBe('2026-07-22');
  });

  it('handles offsets that push the date across UTC midnight', () => {
    // 9am Wednesday local in UTC+12 — Tuesday evening in UTC.
    expect(sleepDayKey(Date.parse('2026-07-21T21:00:00Z'), 720)).toBe('2026-07-22');
  });
});

describe('date precision — a day is not a moment', () => {
  const tz = 0;
  // "Do the cat litters, today" — a date-only capture, stored at local noon
  // because noon is the anchor that lands on the right calendar day in every
  // timezone. Nothing about that anchor is a time the user gave.
  const allDay = {
    type: 'DO',
    status: 'active',
    deadline: '2026-07-26T12:00:00.000Z',
    datePrecision: 'day' as const,
    cadence: null,
    doneToday: false,
    createdAt: '2026-07-25T09:00:00.000Z',
    eventAt: null,
  };
  const noon = Date.parse('2026-07-26T12:00:00Z');

  it('an all-day deadline is not overdue at 12:01pm on its own day', () => {
    // The regression: bubbleStatus compared the noon anchor to the clock, so
    // every date-only chore turned red one minute after midday — from the
    // storage convention, not from anything the user did or failed to do.
    expect(deadlinePassed(allDay, noon + 60_000, tz)).toBe(false);
    expect(deadlinePassed(allDay, noon + 11 * 3_600_000, tz)).toBe(false); // 11pm
  });

  it('an all-day deadline goes overdue when its sleep day ends, not at midnight', () => {
    // 4:59am the next morning is still the same sleep day.
    expect(deadlinePassed(allDay, Date.parse('2026-07-27T04:59:00Z'), tz)).toBe(false);
    expect(deadlinePassed(allDay, Date.parse('2026-07-27T05:00:00Z'), tz)).toBe(true);
  });

  it('a timed deadline is overdue the instant it passes', () => {
    const timed = { ...allDay, datePrecision: 'time' as const, deadline: '2026-07-26T19:00:00.000Z' };
    expect(deadlinePassed(timed, Date.parse('2026-07-26T18:59:00Z'), tz)).toBe(false);
    expect(deadlinePassed(timed, Date.parse('2026-07-26T19:01:00Z'), tz)).toBe(true);
  });

  it('momentPassed: only a timed thing can go by while the day is still on', () => {
    expect(momentPassed(allDay, noon + 6 * 3_600_000, tz)).toBe(false);
    const timed = { ...allDay, datePrecision: 'time' as const, deadline: '2026-07-26T19:00:00.000Z' };
    expect(momentPassed(timed, Date.parse('2026-07-26T18:00:00Z'), tz)).toBe(false);
    expect(momentPassed(timed, Date.parse('2026-07-26T20:00:00Z'), tz)).toBe(true);
  });

  it("momentPassed: a rhythm's turn today counts once its hour goes by, unless ticked", () => {
    // "Speak French with Kayla", daily at 7pm.
    const rhythm = {
      type: 'DO',
      status: 'active',
      deadline: null,
      datePrecision: 'time' as const,
      cadence: { freq: 'daily' as const, interval: 1, atTime: '19:00' },
      doneToday: false,
      createdAt: '2026-07-01T09:00:00.000Z',
      eventAt: null,
    };
    expect(momentPassed(rhythm, Date.parse('2026-07-26T18:00:00Z'), tz)).toBe(false);
    expect(momentPassed(rhythm, Date.parse('2026-07-26T21:00:00Z'), tz)).toBe(true);
    // Ticked off releases it — the same predicate the checkbox reads.
    expect(momentPassed({ ...rhythm, doneToday: true }, Date.parse('2026-07-26T21:00:00Z'), tz)).toBe(false);
  });

  it('an all-day event is live all its own day, spent only once the day is', () => {
    // The same bug in the other direction: a one-hour grace past the noon
    // anchor retired "Gabe comes over Thursday" at 1pm on Thursday.
    const ev = { eventAt: '2026-07-26T12:00:00.000Z', eventEnd: null, cadence: null, datePrecision: 'day' as const };
    expect(eventPassed(ev, noon + 3 * 3_600_000, tz)).toBe(false);
    expect(eventPassed(ev, Date.parse('2026-07-27T04:59:00Z'), tz)).toBe(false);
    expect(eventPassed(ev, Date.parse('2026-07-27T05:00:00Z'), tz)).toBe(true);
  });
});

describe('nextLatenessBoundary — schedule to the flip, never poll for it', () => {
  const tz = 0;
  const doItem = (over: object) => ({
    type: 'DO',
    status: 'active',
    deadline: null as string | null,
    datePrecision: 'time' as const,
    cadence: null,
    doneToday: false,
    createdAt: '2026-07-01T09:00:00.000Z',
    eventAt: null as string | null,
    eventEnd: null as string | null,
    ...over,
  });
  const at = (iso: string) => Date.parse(iso);

  it('with nothing timed, the next boundary is the 5am rollover', () => {
    const now = at('2026-07-26T13:39:00Z');
    const allDay = doItem({ deadline: '2026-07-26T12:00:00.000Z', datePrecision: 'day' });
    // One wake-up for the whole afternoon and evening, not four hundred.
    expect(nextLatenessBoundary([allDay], now, tz)).toBe(at('2026-07-27T05:00:00Z'));
  });

  it('a timed deadline later today is the next boundary', () => {
    const now = at('2026-07-26T13:39:00Z');
    const timed = doItem({ deadline: '2026-07-26T19:00:00.000Z' });
    expect(nextLatenessBoundary([timed], now, tz)).toBe(at('2026-07-26T19:00:00Z'));
  });

  it("a rhythm's turn today counts, and only the soonest instant wins", () => {
    const now = at('2026-07-26T09:00:00Z');
    const french = doItem({ cadence: { freq: 'daily', interval: 1, atTime: '19:00' } });
    const checkIn = doItem({ cadence: { freq: 'daily', interval: 1, atTime: '11:00' } });
    expect(nextLatenessBoundary([french, checkIn], now, tz)).toBe(at('2026-07-26T11:00:00Z'));
  });

  it('instants already passed are not boundaries — they have flipped', () => {
    const now = at('2026-07-26T20:00:00Z');
    const french = doItem({ cadence: { freq: 'daily', interval: 1, atTime: '19:00' } });
    // 7pm is behind us and the chip is already late; nothing more happens
    // until the day turns over.
    expect(nextLatenessBoundary([french], now, tz)).toBe(at('2026-07-27T05:00:00Z'));
  });

  it('resolved items schedule nothing', () => {
    const now = at('2026-07-26T09:00:00Z');
    const done = doItem({ deadline: '2026-07-26T19:00:00.000Z', status: 'completed' });
    const ticked = doItem({ cadence: { freq: 'daily', interval: 1, atTime: '19:00' }, doneToday: true });
    expect(nextLatenessBoundary([done, ticked], now, tz)).toBe(at('2026-07-27T05:00:00Z'));
  });

  it('a timed event schedules its grace expiry, when it goes spent', () => {
    const now = at('2026-07-26T09:00:00Z');
    const lunch = {
      type: 'HAPPEN',
      status: 'active',
      deadline: null,
      datePrecision: 'time' as const,
      cadence: null,
      doneToday: false,
      createdAt: '2026-07-01T09:00:00.000Z',
      eventAt: '2026-07-26T12:00:00.000Z',
      eventEnd: null,
    };
    expect(nextLatenessBoundary([lunch], now, tz)).toBe(at('2026-07-26T13:00:00Z')); // +1h grace
  });

  it('always returns a future instant, so scheduling can never spin', () => {
    const now = at('2026-07-26T04:59:59Z');
    const items = [
      doItem({ deadline: '2026-07-20T19:00:00.000Z' }), // long overdue
      doItem({ cadence: { freq: 'daily', interval: 1, atTime: '19:00' } }),
    ];
    expect(nextLatenessBoundary(items, now, tz)).toBeGreaterThan(now);
  });
});

describe('a named part of the day is a coarse time, not an absent one', () => {
  // Sunday 2pm local, UTC. The capture hour matters here: it is what a phrase
  // chrono misreads would otherwise leak into the deadline.
  const ref = new Date('2026-07-26T14:00:00Z');
  const hourOf = (iso: string) => new Date(iso).getUTCHours();

  it('keeps the hour the part of day implies, rather than squashing to the anchor', () => {
    const evening = resolveDatePhrase('tomorrow evening', ref, 0)!;
    expect(evening.hasTime).toBe(true);
    expect(hourOf(evening.iso)).toBe(20);

    const afternoon = resolveDatePhrase('this afternoon', ref, 0)!;
    expect(afternoon.hasTime).toBe(true);
    expect(hourOf(afternoon.iso)).toBe(15);
  });

  it('handles morning, whose meridiem is 0 and would fail a truthiness test', () => {
    const morning = resolveDatePhrase('tomorrow morning', ref, 0)!;
    expect(morning.hasTime).toBe(true);
    expect(hourOf(morning.iso)).toBe(6);
  });

  it('works with a weekday and with tonight', () => {
    const thu = resolveDatePhrase('Thursday evening', ref, 0)!;
    expect(thu.hasTime).toBe(true);
    expect(hourOf(thu.iso)).toBe(20);

    const tonight = resolveDatePhrase('tonight', ref, 0)!;
    expect(tonight.hasTime).toBe(true);
    expect(hourOf(tonight.iso)).toBe(22);
  });

  it('a bare day still names no time and still anchors at noon', () => {
    const tomorrow = resolveDatePhrase('tomorrow', ref, 0)!;
    expect(tomorrow.hasTime).toBe(false);
    expect(hourOf(tomorrow.iso)).toBe(12);
  });

  it('never mints a time out of the hour the user happened to be typing', () => {
    // chrono matches "end of the day" only as "the day", resolves it to the
    // capture hour, and marks meridiem implied because 2pm is a PM hour. That
    // implied meridiem is not evidence of anything the user said.
    const eod = resolveDatePhrase('end of the day', ref, 0)!;
    expect(eod.hasTime).toBe(false);
    expect(hourOf(eod.iso)).toBe(12);

    // Likewise a part-of-day word chrono does not know: no invented hour.
    const lunch = resolveDatePhrase('tomorrow lunchtime', ref, 0)!;
    expect(lunch.hasTime).toBe(false);
    expect(hourOf(lunch.iso)).toBe(12);
  });

  it('a stated clock time still wins over the part of day', () => {
    const r = resolveDatePhrase('tomorrow evening at 6:30pm', ref, 0)!;
    expect(r.hasTime).toBe(true);
    expect(hourOf(r.iso)).toBe(18);
    expect(new Date(r.iso).getUTCMinutes()).toBe(30);
  });

  it('carries the part of day across a range, both ends', () => {
    const r = resolveDatePhrase('Friday afternoon to Sunday evening', ref, 0)!;
    expect(r.hasTime).toBe(true);
    expect(hourOf(r.iso)).toBe(15);
    expect(hourOf(r.endIso!)).toBe(20);
  });

  it('the recovery net does not adopt a part of day loose in the sentence', () => {
    // "morning" here is a greeting. chrono resolves it forward to 6am
    // tomorrow, which lands on the very day the deadline is on, so the
    // same-day guard cannot catch it — only refusing coarse times can.
    const bare = resolveDatePhrase('tomorrow', ref, 0);
    const refined = refineWithSourceTime(bare, 'good morning, remind me tomorrow', ref, 0)!;
    expect(refined.hasTime).toBe(false);
    expect(hourOf(refined.iso)).toBe(12);
  });

  it('the recovery net still adopts an exact time the extraction dropped', () => {
    const bare = resolveDatePhrase('today', ref, 0);
    const refined = refineWithSourceTime(bare, 'put the laundry away before 3:00 p.m.', ref, 0)!;
    expect(refined.hasTime).toBe(true);
    expect(hourOf(refined.iso)).toBe(15);
  });

  it('an exact time in the text upgrades a coarse one from the phrase', () => {
    const coarse = resolveDatePhrase('this evening', ref, 0)!;
    expect(coarse.coarse).toBe(true);
    const refined = refineWithSourceTime(coarse, 'call mum this evening at 6:30pm', ref, 0)!;
    expect(refined.hasTime).toBe(true);
    expect(refined.coarse).toBeUndefined();
    expect(hourOf(refined.iso)).toBe(18);
    expect(new Date(refined.iso).getUTCMinutes()).toBe(30);
  });
});

describe('snoozeActive — the one predicate every snooze reader shares', () => {
  const tz = -240; // UTC-4

  it('null is never snoozed', () => {
    expect(snoozeActive(null, Date.parse('2026-07-20T12:00:00Z'), tz)).toBe(false);
  });

  it('hidden through the day before the wake day, awake on the wake day itself', () => {
    // Snoozed "until Aug 19" (noon-anchored). Aug 18 local: still hidden.
    const until = '2026-08-19T16:00:00.000Z'; // noon local Aug 19
    expect(snoozeActive(until, Date.parse('2026-08-18T16:00:00Z'), tz)).toBe(true);
    // Aug 19, 6am local — the wake day has arrived; the instant's clock time
    // (noon) must not matter.
    expect(snoozeActive(until, Date.parse('2026-08-19T10:00:00Z'), tz)).toBe(false);
  });

  it('the wake day starts at the 5am sleep boundary, not midnight', () => {
    const until = '2026-08-19T16:00:00.000Z'; // noon local Aug 19
    // Aug 19, 2am local is still Aug 18's sleep day — hidden.
    expect(snoozeActive(until, Date.parse('2026-08-19T06:00:00Z'), tz)).toBe(true);
    // Aug 19, 5am local — the day rolls, the item wakes with the morning map.
    expect(snoozeActive(until, Date.parse('2026-08-19T09:00:00Z'), tz)).toBe(false);
  });

  it('a past wake day is not snoozed (the sweep clears it; visibility never waits)', () => {
    expect(snoozeActive('2026-07-01T16:00:00Z', Date.parse('2026-07-20T12:00:00Z'), tz)).toBe(false);
  });
});
