import { describe, expect, it } from 'vitest';
import { deriveFlavour } from './flavour';
import { effectivePriority, decayedBoost, PRIORITY_BASE, RECAPTURE_BOOST, priorityLabel } from './priority';
import { isNeglected, nextOccurrence, occurrencesBetween, cadencePeriodMs, describeCadence } from './cadence';
import { expandBareOrdinals, resolveDatePhrase, inferHardness, inferOptionality, dayKey } from './dates';
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
  it('occurrencesBetween respects the window', () => {
    const daily: Cadence = { freq: 'daily', interval: 1 };
    const occ = occurrencesBetween(daily, '2026-07-01T08:00:00Z', new Date('2026-07-20T00:00:00Z'), new Date('2026-07-23T00:00:00Z'));
    expect(occ.length).toBe(3);
  });
  it('describes cadences', () => {
    expect(describeCadence({ freq: 'daily', interval: 1 })).toBe('daily');
    expect(describeCadence({ freq: 'weekly', interval: 1, byWeekday: [1] })).toContain('Mon');
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
});
