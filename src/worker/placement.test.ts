import { describe, expect, it } from 'vitest';
import type { ItemView } from '../shared/types';
import { isTodayRelevant, maxTier, placeItem, placeItems, tierProminences } from './placement';

// Placement (staged Brain, layer 1): the deterministic skeleton. These tests
// pin the lead-time table — the contract that ended "quick task surfaced
// three days early" — and the invariant that placement is a strict superset
// of the old reliable floor (isTodayRelevant), so the cardinal guarantee
// (never drop a same-day item) survives the pipeline change by construction.

const DAY_MS = 86_400_000;
// Wednesday noon UTC, tz 0 — sleep day runs 2026-07-22T05:00Z → 07-23T05:00Z.
const NOW = new Date('2026-07-22T12:00:00Z');

let seq = 0;
function item(over: Partial<ItemView>): ItemView {
  const id = over.id ?? `it${seq++}`;
  return {
    id,
    type: 'DO',
    title: id,
    rawTexts: [],
    affects: [],
    status: 'active',
    deadline: null,
    deadlineHardness: null,
    datePrecision: 'time',
    cadence: null,
    optionality: 'must',
    effort: 'quick',
    pingNatured: false,
    eventAt: null,
    eventEnd: null,
    alertLeadMinutes: null,
    showOnCalendar: true,
    snoozedUntil: null,
    priorityBase: 0.5,
    priorityBoost: 0,
    boostUpdatedAt: null,
    userPriority: null,
    flavourOverride: null,
    createdAt: new Date(NOW.getTime() - 7 * DAY_MS).toISOString(),
    updatedAt: NOW.toISOString(),
    lastTouchedAt: NOW.toISOString(),
    lastCompletedAt: null,
    completionCount: 0,
    streak: 0,
    lastSurfacedAt: null,
    surfacedCount: 0,
    parseConfidence: 1,
    themes: [],
    flavour: 'Task',
    effectivePriority: 0.5,
    neglected: false,
    doneToday: false,
    ...over,
  };
}

describe('placeItem — dated DOs and the lead-time table', () => {
  it('quick DO due in two days stays out of the skeleton (the scratching-post case)', () => {
    const p = placeItem(item({ effort: 'quick', deadline: '2026-07-24T18:00:00Z', deadlineHardness: 'hard' }), NOW, 0);
    expect(p).toBeNull();
  });

  it('quick DO due tomorrow, even hard, waits for its day', () => {
    const p = placeItem(item({ effort: 'quick', deadline: '2026-07-23T18:00:00Z', deadlineHardness: 'hard' }), NOW, 0);
    expect(p).toBeNull();
  });

  it('due today is mandatory at mid for a must-do', () => {
    const p = placeItem(item({ deadline: '2026-07-22T18:00:00Z', deadlineHardness: 'hard' }), NOW, 0);
    expect(p).toEqual({ floor: 'mid', rule: 'due-today' });
  });

  it('a 1am deadline tonight belongs to today (sleep-cycle day, 5am boundary)', () => {
    const p = placeItem(item({ deadline: '2026-07-23T01:00:00Z', deadlineHardness: 'hard' }), NOW, 0);
    expect(p).toEqual({ floor: 'mid', rule: 'due-today' });
  });

  it('due today, optional with a soft deadline, still mandatory — just quiet', () => {
    const p = placeItem(
      item({ deadline: '2026-07-22T18:00:00Z', deadlineHardness: 'soft', optionality: 'nice' }),
      NOW,
      0,
    );
    expect(p).toEqual({ floor: 'quiet', rule: 'due-today' });
  });

  it('due today, optional but HARD deadline, holds mid (insistence = must-do OR hard)', () => {
    const p = placeItem(
      item({ deadline: '2026-07-22T18:00:00Z', deadlineHardness: 'hard', optionality: 'nice' }),
      NOW,
      0,
    );
    expect(p).toEqual({ floor: 'mid', rule: 'due-today' });
  });

  it('overdue is mandatory, mid for insistent items, and names the days', () => {
    const p = placeItem(item({ deadline: '2026-07-19T18:00:00Z', deadlineHardness: 'hard' }), NOW, 0);
    expect(p).toEqual({ floor: 'mid', rule: 'overdue-3d' });
  });

  it('overdue optional+soft stays mandatory at quiet', () => {
    const p = placeItem(
      item({ deadline: '2026-07-20T18:00:00Z', deadlineHardness: 'soft', optionality: 'nice' }),
      NOW,
      0,
    );
    expect(p).toEqual({ floor: 'quiet', rule: 'overdue-2d' });
  });

  it('medium DO enters one day out, as a dot', () => {
    const p = placeItem(item({ effort: 'medium', deadline: '2026-07-23T18:00:00Z', deadlineHardness: 'hard' }), NOW, 0);
    expect(p).toEqual({ floor: 'dot', rule: 'due-tomorrow' });
  });

  it('medium DO two days out is not yet required', () => {
    const p = placeItem(item({ effort: 'medium', deadline: '2026-07-24T18:00:00Z', deadlineHardness: 'hard' }), NOW, 0);
    expect(p).toBeNull();
  });

  it('a soft deadline shaves a day of lead: medium+soft waits for its day', () => {
    const p = placeItem(item({ effort: 'medium', deadline: '2026-07-23T18:00:00Z', deadlineHardness: 'soft' }), NOW, 0);
    expect(p).toBeNull();
  });

  it('big-effort DO gets six days of runway at quiet', () => {
    const p = placeItem(item({ effort: 'large', deadline: '2026-07-28T18:00:00Z', deadlineHardness: 'hard' }), NOW, 0);
    expect(p).toEqual({ floor: 'quiet', rule: 'runway-6d-left' });
  });

  it('big-effort DO seven days out is not yet required', () => {
    const p = placeItem(item({ effort: 'large', deadline: '2026-07-29T18:00:00Z', deadlineHardness: 'hard' }), NOW, 0);
    expect(p).toBeNull();
  });

  it('big-effort runway steps up to mid in the final stretch', () => {
    const p = placeItem(item({ effort: 'large', deadline: '2026-07-24T18:00:00Z', deadlineHardness: 'hard' }), NOW, 0);
    expect(p).toEqual({ floor: 'mid', rule: 'runway-2d-left' });
  });

  it('big-effort + soft: one day less lead, one tier quieter', () => {
    // d=5 is within the softened lead (6-1); quiet drops to dot.
    const p = placeItem(item({ effort: 'large', deadline: '2026-07-27T18:00:00Z', deadlineHardness: 'soft' }), NOW, 0);
    expect(p).toEqual({ floor: 'dot', rule: 'runway-5d-left' });
    // d=6 is outside the softened lead.
    const q = placeItem(item({ effort: 'large', deadline: '2026-07-28T18:00:00Z', deadlineHardness: 'soft' }), NOW, 0);
    expect(q).toBeNull();
  });

  it('big-effort + optional in the final stretch: mid drops to quiet', () => {
    const p = placeItem(
      item({ effort: 'large', deadline: '2026-07-24T18:00:00Z', deadlineHardness: 'hard', optionality: 'nice' }),
      NOW,
      0,
    );
    expect(p).toEqual({ floor: 'quiet', rule: 'runway-2d-left' });
  });

  it('respects the client timezone: a 23:00-local deadline is still today', () => {
    // tz -240 (UTC-4): 2026-07-23T03:00Z = 23:00 local on Jul 22 → same sleep day.
    const p = placeItem(item({ deadline: '2026-07-23T03:00:00Z', deadlineHardness: 'hard' }), NOW, -240);
    expect(p).toEqual({ floor: 'mid', rule: 'due-today' });
  });

  it('before the 5am cutoff, yesterday-evening deadlines are still "today", not overdue', () => {
    const lateNight = new Date('2026-07-23T04:30:00Z'); // still sleep-day Jul 22
    const p = placeItem(item({ deadline: '2026-07-22T20:00:00Z', deadlineHardness: 'hard' }), lateNight, 0);
    expect(p).toEqual({ floor: 'mid', rule: 'due-today' });
  });
});

describe('placeItem — events', () => {
  it('an event today is mandatory at mid', () => {
    const p = placeItem(item({ type: 'HAPPEN', eventAt: '2026-07-22T19:00:00Z' }), NOW, 0);
    expect(p).toEqual({ floor: 'mid', rule: 'event-today' });
  });

  it('an optional event today sits at quiet', () => {
    const p = placeItem(item({ type: 'HAPPEN', eventAt: '2026-07-22T19:00:00Z', optionality: 'nice' }), NOW, 0);
    expect(p).toEqual({ floor: 'quiet', rule: 'event-today' });
  });

  it('an event tomorrow gets a quiet day-before glance', () => {
    const p = placeItem(item({ type: 'HAPPEN', eventAt: '2026-07-23T18:00:00Z' }), NOW, 0);
    expect(p).toEqual({ floor: 'quiet', rule: 'event-tomorrow' });
  });

  it('a single-moment event two days out, once shown, is curation territory, not skeleton', () => {
    const p = placeItem(
      item({ type: 'HAPPEN', eventAt: '2026-07-24T18:00:00Z', lastSurfacedAt: '2026-07-20T12:00:00Z' }),
      NOW,
      0,
    );
    expect(p).toBeNull();
  });

  it('a never-shown upcoming event gets one first sight at dot (the Manulife case)', () => {
    const p = placeItem(item({ type: 'HAPPEN', eventAt: '2026-07-25T14:00:00Z' }), NOW, 0);
    expect(p).toEqual({ floor: 'dot', rule: 'first-sight' });
  });

  it('first sight retires once the event has been surfaced — it fires by construction only once', () => {
    const p = placeItem(
      item({ type: 'HAPPEN', eventAt: '2026-07-25T14:00:00Z', lastSurfacedAt: '2026-07-21T12:00:00Z' }),
      NOW,
      0,
    );
    expect(p).toBeNull();
  });

  it('first sight reaches a week out and no further — beyond that, curation territory', () => {
    const inWindow = placeItem(item({ type: 'HAPPEN', eventAt: '2026-07-29T18:00:00Z' }), NOW, 0);
    expect(inWindow).toEqual({ floor: 'dot', rule: 'first-sight' });
    const beyond = placeItem(item({ type: 'HAPPEN', eventAt: '2026-07-30T18:00:00Z' }), NOW, 0);
    expect(beyond).toBeNull();
  });

  it('first sight is events-only: a never-shown dated DO stays under the lead-time table', () => {
    const p = placeItem(item({ effort: 'quick', deadline: '2026-07-25T18:00:00Z', deadlineHardness: 'hard' }), NOW, 0);
    expect(p).toBeNull();
  });

  it('a recurring event never gets a first sight — its rhythm owns its appearances', () => {
    const weekly = { freq: 'weekly' as const, interval: 1, byWeekday: [6], atTime: '10:00' };
    const p = placeItem(
      item({ type: 'HAPPEN', eventAt: '2026-07-25T10:00:00Z', cadence: weekly, createdAt: '2026-07-20T09:00:00Z' }),
      NOW,
      0,
    );
    expect(p).toBeNull();
  });

  it('a multi-day trip enters three days early (packing runway)', () => {
    const p = placeItem(
      item({ type: 'HAPPEN', eventAt: '2026-07-25T12:00:00Z', eventEnd: '2026-07-27T12:00:00Z' }),
      NOW,
      0,
    );
    expect(p).toEqual({ floor: 'quiet', rule: 'trip-in-3d' });
  });

  it('a multi-day trip four days out is past packing runway — only first sight if never shown', () => {
    const never = placeItem(
      item({ type: 'HAPPEN', eventAt: '2026-07-26T12:00:00Z', eventEnd: '2026-07-28T12:00:00Z' }),
      NOW,
      0,
    );
    expect(never).toEqual({ floor: 'dot', rule: 'first-sight' });
    const shown = placeItem(
      item({
        type: 'HAPPEN',
        eventAt: '2026-07-26T12:00:00Z',
        eventEnd: '2026-07-28T12:00:00Z',
        lastSurfacedAt: '2026-07-20T12:00:00Z',
      }),
      NOW,
      0,
    );
    expect(shown).toBeNull();
  });

  it('an event spanning today (started yesterday) is event-today', () => {
    const p = placeItem(
      item({ type: 'HAPPEN', eventAt: '2026-07-21T12:00:00Z', eventEnd: '2026-07-23T12:00:00Z' }),
      NOW,
      0,
    );
    expect(p).toEqual({ floor: 'mid', rule: 'event-today' });
  });

  it('a passed one-shot event is not mandatory (the sweep closes it)', () => {
    const p = placeItem(item({ type: 'HAPPEN', eventAt: '2026-07-21T18:00:00Z' }), NOW, 0);
    expect(p).toBeNull();
  });
});

describe('placeItem — recurring rhythms', () => {
  const daily = { freq: 'daily' as const, interval: 1, atTime: '20:00' };

  it('a daily rhythm not yet done today is mandatory at mid', () => {
    const p = placeItem(item({ cadence: daily, createdAt: '2026-07-15T20:00:00Z' }), NOW, 0);
    expect(p).toEqual({ floor: 'mid', rule: 'rhythm-today' });
  });

  it('a daily rhythm already completed today releases until tomorrow', () => {
    const p = placeItem(
      item({ cadence: daily, createdAt: '2026-07-15T20:00:00Z', lastCompletedAt: '2026-07-22T06:00:00Z' }),
      NOW,
      0,
    );
    expect(p).toBeNull();
  });

  it('a slipped weekly rhythm is a quiet nudge naming the missed days', () => {
    // Saturdays; last turn (Jul 18) unmet; today is Wednesday → 4 days unmet.
    // Never completed since capture three weeks ago, so the rhythm is well
    // past its grace and the nudge is earned.
    const weekly = { freq: 'weekly' as const, interval: 1, byWeekday: [6] };
    const p = placeItem(item({ cadence: weekly, createdAt: '2026-07-01T21:30:00Z' }), NOW, 0);
    expect(p).toEqual({ floor: 'quiet', rule: 'rhythm-unmet-4d' });
  });

  it('a turn that went by inside the grace places nothing — the rhythm is time-gated', () => {
    // The Sunday check-in case. "Weekly on Sun", kept last Sunday (Jul 12),
    // missed this one (Jul 19); today is Wednesday. Nothing is asked of today
    // — the rhythm comes round on Sunday — and the 1.5x-period grace has not
    // run out, so the map stays quiet instead of carrying "2 days past its
    // Sunday slot" every morning until the next turn.
    const weeklySun = { freq: 'weekly' as const, interval: 1, byWeekday: [0], atTime: '11:00' };
    const p = placeItem(
      item({ cadence: weeklySun, createdAt: '2026-06-01T11:00:00Z', lastCompletedAt: '2026-07-12T15:00:00Z' }),
      NOW,
      0,
    );
    expect(p).toBeNull();
  });

  it('the same missed turn becomes a nudge once the grace runs out', () => {
    // Same rhythm, same missed Sunday — but the last kept turn is now three
    // weeks back, so neglect has fired and the nudge is earned. The gate moves
    // WHEN a slipped rhythm speaks, never whether it can.
    const weeklySun = { freq: 'weekly' as const, interval: 1, byWeekday: [0], atTime: '11:00' };
    const p = placeItem(
      item({ cadence: weeklySun, createdAt: '2026-06-01T11:00:00Z', lastCompletedAt: '2026-07-01T15:00:00Z' }),
      NOW,
      0,
    );
    expect(p).toEqual({ floor: 'quiet', rule: 'rhythm-unmet-3d' });
  });

  it('a kept weekly rhythm whose next turn is days away stays out', () => {
    const weekly = { freq: 'weekly' as const, interval: 1, byWeekday: [6] };
    const p = placeItem(
      item({ cadence: weekly, createdAt: '2026-07-01T21:30:00Z', lastCompletedAt: '2026-07-18T22:00:00Z' }),
      NOW,
      0,
    );
    expect(p).toBeNull();
  });

  it('a released rhythm whose anchor still spans today stays mandatory (reliable-floor parity)', () => {
    // eventAt spans today but the daily turn is already done: isTodayRelevant
    // is still true via its eventAt branch, so placement must agree — the
    // superset invariant is a construction guarantee, not a coincidence.
    const p = placeItem(
      item({
        cadence: daily,
        eventAt: '2026-07-22T20:00:00Z',
        createdAt: '2026-07-15T20:00:00Z',
        lastCompletedAt: '2026-07-22T06:00:00Z',
      }),
      NOW,
      0,
    );
    expect(p).toEqual({ floor: 'mid', rule: 'event-today' });
  });

  it("a cadence item's future eventAt is an anchor, not a one-shot moment — standing decides", () => {
    // Anchored to a past Wednesday 10am, every 2 weeks: the standing (today)
    // must fire, via the cadence path, not the stale eventAt instant.
    const biweekly = { freq: 'weekly' as const, interval: 2, byWeekday: [3], atTime: '10:00' };
    const p = placeItem(
      item({ type: 'HAPPEN', eventAt: '2026-07-08T10:00:00Z', cadence: biweekly, createdAt: '2026-07-08T09:00:00Z' }),
      NOW,
      0,
    );
    expect(p).toEqual({ floor: 'mid', rule: 'rhythm-today' });
  });
});

describe('placeItem — the strongest rule wins; non-starters', () => {
  it('deadline today outranks event tomorrow on the same item', () => {
    const p = placeItem(
      item({ deadline: '2026-07-22T18:00:00Z', deadlineHardness: 'hard', eventAt: '2026-07-23T18:00:00Z' }),
      NOW,
      0,
    );
    expect(p).toEqual({ floor: 'mid', rule: 'due-today' });
  });

  it('undated KNOWs and undated DOs are never mandatory', () => {
    expect(placeItem(item({ type: 'KNOW' }), NOW, 0)).toBeNull();
    expect(placeItem(item({ type: 'DO' }), NOW, 0)).toBeNull();
  });

  it('inactive items never place', () => {
    const p = placeItem(item({ status: 'completed', deadline: '2026-07-22T18:00:00Z' }), NOW, 0);
    expect(p).toBeNull();
  });
});

describe('placeItems — the skeleton/pile split and the reliable-floor invariant', () => {
  it('splits mandatory from eligible and excludes inactive items from both', () => {
    const dueToday = item({ id: 'a', deadline: '2026-07-22T18:00:00Z', deadlineHardness: 'hard' });
    const someday = item({ id: 'b', optionality: 'nice' });
    const done = item({ id: 'c', status: 'completed' });
    const { mandatory, eligible } = placeItems([dueToday, someday, done], NOW, 0);
    expect(mandatory.map((m) => m.item.id)).toEqual(['a']);
    expect(eligible.map((i) => i.id)).toEqual(['b']);
  });

  it('an upcoming rhythm is withheld — in neither list (the get-a-jump-on-recycling case)', () => {
    // Weekly Saturdays, last turn met: next turn is days away. The curator
    // must never see it — a chip on a future turn can't bank the completion.
    const weekly = { freq: 'weekly' as const, interval: 1, byWeekday: [6] };
    const kept = item({
      id: 'r',
      cadence: weekly,
      createdAt: '2026-07-01T21:30:00Z',
      lastCompletedAt: '2026-07-18T22:00:00Z',
    });
    const { mandatory, eligible } = placeItems([kept], NOW, 0);
    expect(mandatory).toHaveLength(0);
    expect(eligible).toHaveLength(0);
  });

  it("a rhythm completed today is released AND withheld — done means gone until its next turn", () => {
    const daily = { freq: 'daily' as const, interval: 1, atTime: '20:00' };
    const done = item({
      id: 'd',
      cadence: daily,
      createdAt: '2026-07-15T20:00:00Z',
      lastCompletedAt: '2026-07-22T06:00:00Z',
    });
    const { mandatory, eligible } = placeItems([done], NOW, 0);
    expect(mandatory).toHaveLength(0);
    expect(eligible).toHaveLength(0);
  });

  it('rhythms whose turn is today or unmet still land in mandatory, never withheld', () => {
    const daily = { freq: 'daily' as const, interval: 1, atTime: '20:00' };
    const weekly = { freq: 'weekly' as const, interval: 1, byWeekday: [6] };
    const dueToday = item({ id: 't', cadence: daily, createdAt: '2026-07-15T20:00:00Z' });
    const slipped = item({ id: 's', cadence: weekly, createdAt: '2026-07-01T21:30:00Z' });
    const { mandatory, eligible } = placeItems([dueToday, slipped], NOW, 0);
    expect(mandatory.map((m) => m.item.id).sort()).toEqual(['s', 't']);
    expect(eligible).toHaveLength(0);
  });

  it('everything isTodayRelevant is mandatory — placement strictly contains the old floor', () => {
    const grabBag = [
      item({ deadline: '2026-07-22T18:00:00Z', deadlineHardness: 'hard' }),
      item({ deadline: '2026-07-19T18:00:00Z', deadlineHardness: 'soft', optionality: 'nice' }),
      item({ type: 'HAPPEN', eventAt: '2026-07-22T23:00:00Z' }),
      item({ type: 'HAPPEN', eventAt: '2026-07-21T12:00:00Z', eventEnd: '2026-07-23T12:00:00Z' }),
      item({ cadence: { freq: 'daily', interval: 1, atTime: '20:00' }, createdAt: '2026-07-15T20:00:00Z' }),
      item({
        cadence: { freq: 'daily', interval: 1, atTime: '20:00' },
        eventAt: '2026-07-22T20:00:00Z',
        createdAt: '2026-07-15T20:00:00Z',
        lastCompletedAt: '2026-07-22T06:00:00Z',
      }),
      item({ type: 'KNOW' }),
      item({ effort: 'large', deadline: '2026-07-28T18:00:00Z', deadlineHardness: 'hard' }),
      item({ type: 'HAPPEN', eventAt: '2026-07-30T18:00:00Z' }),
      item({ optionality: 'nice' }),
    ];
    const { mandatory } = placeItems(grabBag, NOW, 0);
    const mandatoryIds = new Set(mandatory.map((m) => m.item.id));
    for (const i of grabBag) {
      if (isTodayRelevant(i, NOW, 0)) {
        expect(mandatoryIds.has(i.id), `${i.id} is today-relevant but not mandatory`).toBe(true);
      }
    }
  });
});

describe('tier helpers', () => {
  it('maxTier picks the louder tier', () => {
    expect(maxTier('quiet', 'mid')).toBe('mid');
    expect(maxTier('loud', 'dot')).toBe('loud');
    expect(maxTier('dot', 'dot')).toBe('dot');
  });

  it('tierProminences still spreads members within fixed bands (moved, not changed)', () => {
    expect(tierProminences(['loud'])).toEqual([0.95]);
    expect(tierProminences(['mid', 'mid'])).toEqual([0.68, 0.5]);
  });
});
