import { describe, expect, it } from 'vitest';
import { computeDueAlerts } from './push';
import {
  aliasItems,
  brainItemLine,
  compactEventLines,
  isTodayRelevant,
  PROFILE_EVENT_TYPES,
  selectBrainSystem,
  tierProminences,
} from './brain';
import type { Cadence, ItemView } from '../shared/types';
import { extractJson } from './ai';
import { trigramEmbed } from './embeddings';
import { semanticCut } from './items';
import { cosine } from './db';

const baseItem = {
  id: 'i1',
  type: 'DO',
  status: 'active',
  title: 'Do taxes',
  eventAt: null as string | null,
  deadline: null as string | null,
  deadlineHardness: null as string | null,
  effort: 'medium' as const,
  alertLeadMinutes: null as number | null,
  cadence: null,
  createdAt: '2026-07-01T00:00:00Z',
};

describe('Layer-1 punctual push (§11.4)', () => {
  it('HAPPEN pushes just-before with the default 45min lead', () => {
    const items = [{ ...baseItem, type: 'HAPPEN', eventAt: '2026-07-20T15:00:00Z' }];
    expect(computeDueAlerts(items, new Date('2026-07-20T14:20:00Z'))).toHaveLength(1);
    expect(computeDueAlerts(items, new Date('2026-07-20T13:00:00Z'))).toHaveLength(0);
    expect(computeDueAlerts(items, new Date('2026-07-20T15:01:00Z'))).toHaveLength(0);
  });

  it('respects a per-event lead override ("remind me the night before")', () => {
    const items = [{ ...baseItem, type: 'HAPPEN', eventAt: '2026-07-20T15:00:00Z', alertLeadMinutes: 720 }];
    expect(computeDueAlerts(items, new Date('2026-07-20T04:00:00Z'))).toHaveLength(1);
  });

  it('hard-deadline DO uses effort-scaled runway', () => {
    const quick = [{ ...baseItem, deadline: '2026-07-20T18:00:00Z', deadlineHardness: 'hard', effort: 'quick' as const }];
    const large = [{ ...baseItem, deadline: '2026-07-25T18:00:00Z', deadlineHardness: 'hard', effort: 'large' as const }];
    // quick: 2h runway
    expect(computeDueAlerts(quick, new Date('2026-07-20T16:30:00Z'))).toHaveLength(1);
    expect(computeDueAlerts(quick, new Date('2026-07-20T15:00:00Z'))).toHaveLength(0);
    // large: 5-day runway — pings well ahead
    expect(computeDueAlerts(large, new Date('2026-07-21T18:00:00Z'))).toHaveLength(1);
  });

  it('soft deadlines never push', () => {
    const items = [{ ...baseItem, deadline: '2026-07-20T18:00:00Z', deadlineHardness: 'soft' }];
    expect(computeDueAlerts(items, new Date('2026-07-20T17:00:00Z'))).toHaveLength(0);
  });

  it('recurring HAPPEN pushes per occurrence with occurrence-scoped keys', () => {
    const items = [
      {
        ...baseItem,
        type: 'HAPPEN',
        eventAt: '2026-07-06T15:00:00Z',
        cadence: { freq: 'weekly' as const, interval: 1, byWeekday: [1] },
      },
    ];
    const a = computeDueAlerts(items, new Date('2026-07-20T14:30:00Z'));
    expect(a).toHaveLength(1);
    expect(a[0].occurrenceKey).toBe('2026-07-20T15:00:00.000Z');
    const b = computeDueAlerts(items, new Date('2026-07-27T14:30:00Z'));
    expect(b[0].occurrenceKey).toBe('2026-07-27T15:00:00.000Z');
  });

  it('completed/deleted items never push', () => {
    const items = [{ ...baseItem, status: 'completed', deadline: '2026-07-20T18:00:00Z', deadlineHardness: 'hard' }];
    expect(computeDueAlerts(items, new Date('2026-07-20T17:00:00Z'))).toHaveLength(0);
  });

  it('recurring DO pings at its atTime in the USER timezone, not UTC', () => {
    // "every Thursday at 8pm" at UTC-4 → occurrences at Fridays 00:00 UTC.
    const items = [
      {
        ...baseItem,
        cadence: { freq: 'weekly' as const, interval: 1, byWeekday: [4], atTime: '20:00' },
      },
    ];
    // Thu Jul 23 2026 20:02 local = Fri Jul 24 00:02 UTC — inside the 10min window.
    const a = computeDueAlerts(items, new Date('2026-07-24T00:02:00Z'), -240);
    expect(a).toHaveLength(1);
    expect(a[0].occurrenceKey).toBe('2026-07-24T00:00:00.000Z');
    // 20:02 UTC the same Thursday is only 16:02 local — nothing due yet.
    expect(computeDueAlerts(items, new Date('2026-07-23T20:02:00Z'), -240)).toHaveLength(0);
  });
});

describe('isTodayRelevant — the same-day safety net (§9.2 floor)', () => {
  // now = July 20 08:49 local (UTC-4 → 12:49Z)
  const now = new Date('2026-07-20T12:49:00Z');
  const tz = -240;
  const base = { status: 'active', deadline: null as string | null, eventAt: null as string | null, eventEnd: null as string | null };

  it('soft, optional, low-priority deadline later today still counts (the Pragmata case)', () => {
    expect(isTodayRelevant({ ...base, deadline: '2026-07-20T13:00:00.000Z' }, now, tz)).toBe(true);
  });
  it('overdue deadlines count; tomorrow does not', () => {
    expect(isTodayRelevant({ ...base, deadline: '2026-07-18T12:00:00Z' }, now, tz)).toBe(true);
    expect(isTodayRelevant({ ...base, deadline: '2026-07-21T12:00:00Z' }, now, tz)).toBe(false);
  });
  it('events happening today count, including multi-day spans crossing today', () => {
    expect(isTodayRelevant({ ...base, eventAt: '2026-07-20T16:00:00Z' }, now, tz)).toBe(true);
    expect(isTodayRelevant({ ...base, eventAt: '2026-07-18T12:00:00Z', eventEnd: '2026-07-25T12:00:00Z' }, now, tz)).toBe(true);
    expect(isTodayRelevant({ ...base, eventAt: '2026-07-18T12:00:00Z', eventEnd: '2026-07-19T12:00:00Z' }, now, tz)).toBe(false);
  });
  it('completed and undated items never count', () => {
    expect(isTodayRelevant({ ...base, status: 'completed', deadline: '2026-07-20T13:00:00Z' }, now, tz)).toBe(false);
    expect(isTodayRelevant(base, now, tz)).toBe(false);
  });
  it('respects the timezone: 23:30 local today vs already-tomorrow UTC', () => {
    // 03:30Z July 21 is 23:30 July 20 at UTC-4 — still today locally.
    expect(isTodayRelevant({ ...base, deadline: '2026-07-21T03:30:00Z' }, now, tz)).toBe(true);
  });
  it('the dishes-at-1am case: at 10pm, a 1am deadline is still today (sleep-cycle day)', () => {
    // Monday July 20 10pm local (Tue 02:00Z); "do the dishes at 1am" resolves
    // to Tuesday 01:00 local — before the 5am rollover, so today's floor.
    const eveningNow = new Date('2026-07-21T02:00:00Z');
    expect(isTodayRelevant({ ...base, deadline: '2026-07-21T05:00:00Z' }, eveningNow, tz)).toBe(true);
    // 6am local is past the rollover — tomorrow's business.
    expect(isTodayRelevant({ ...base, deadline: '2026-07-21T10:00:00Z' }, eveningNow, tz)).toBe(false);
  });

  // The cadence hole: recurring items have neither deadline nor eventAt, so
  // the floor must reach them through occurrence math (now = Monday Jul 20).
  const daily7pm: Cadence = { freq: 'daily', interval: 1, atTime: '19:00' };
  const weeklyMon: Cadence = { freq: 'weekly', interval: 1, byWeekday: [1], atTime: '21:30' };
  const weeklyTue: Cadence = { freq: 'weekly', interval: 1, byWeekday: [2], atTime: '21:30' };
  const created = '2026-07-06T15:00:00Z';

  it('a daily rhythm with a time occurs today — even before its time', () => {
    expect(isTodayRelevant({ ...base, cadence: daily7pm, createdAt: created }, now, tz)).toBe(true);
  });
  it('completed within the local today releases the floor; yesterday does not', () => {
    expect(
      isTodayRelevant({ ...base, cadence: daily7pm, createdAt: created, lastCompletedAt: '2026-07-20T11:00:00Z' }, now, tz),
    ).toBe(false);
    expect(
      isTodayRelevant({ ...base, cadence: daily7pm, createdAt: created, lastCompletedAt: '2026-07-19T23:00:00Z' }, now, tz),
    ).toBe(true);
  });
  it("weekly on today's weekday counts; another weekday does not", () => {
    expect(isTodayRelevant({ ...base, cadence: weeklyMon, createdAt: created }, now, tz)).toBe(true);
    expect(isTodayRelevant({ ...base, cadence: weeklyTue, createdAt: '2026-07-07T15:00:00Z' }, now, tz)).toBe(false);
  });
  it('a weekly rhythm captured TODAY does not count today off its weekday (the check-in bug)', () => {
    // "weekly on Sun at 11am" created this Monday: the anchor lands today but
    // today is not a Sunday — the floor must not invent an occurrence.
    const weeklySun: Cadence = { freq: 'weekly', interval: 1, byWeekday: [0], atTime: '11:00' };
    expect(isTodayRelevant({ ...base, cadence: weeklySun, createdAt: '2026-07-20T06:00:00Z' }, now, tz)).toBe(false);
  });
  it('the local day, not the UTC day, decides which occurrence is "today"', () => {
    // 03:30Z Tuesday is 23:30 Monday at UTC-4: a Monday 23:45 rhythm is still
    // ahead today; a Tuesday rhythm is still tomorrow.
    const lateNow = new Date('2026-07-21T03:30:00Z');
    const daily2345: Cadence = { freq: 'daily', interval: 1, atTime: '23:45' };
    expect(isTodayRelevant({ ...base, cadence: daily2345, createdAt: created }, lateNow, tz)).toBe(true);
    expect(isTodayRelevant({ ...base, cadence: weeklyTue, createdAt: '2026-07-07T15:00:00Z' }, lateNow, tz)).toBe(false);
  });
});

describe('tierProminences — tier judgment from the Brain, numbers from code', () => {
  it('lone members sit at their band top; peers spread evenly to the band bottom', () => {
    const ps = tierProminences(['loud', 'mid', 'mid', 'quiet', 'dot']);
    [0.95, 0.68, 0.5, 0.4, 0.18].forEach((want, i) => expect(ps[i]).toBeCloseTo(want));
  });
  it('a tier boundary is always a real cliff (≥0.1 in p), unlike the ladder it replaces', () => {
    const tiers = ['loud', 'loud', 'loud', 'mid', 'mid', 'quiet', 'quiet', 'dot'] as const;
    const ps = tierProminences([...tiers]);
    for (let i = 1; i < ps.length; i++) {
      expect(ps[i]).toBeLessThan(ps[i - 1]); // loudest-first order preserved
      if (tiers[i] !== tiers[i - 1]) expect(ps[i - 1] - ps[i]).toBeGreaterThanOrEqual(0.1 - 1e-9);
    }
  });
  it('handles interleaved output order per tier', () => {
    const ps = tierProminences(['mid', 'loud', 'mid']);
    [0.68, 0.95, 0.5].forEach((want, i) => expect(ps[i]).toBeCloseTo(want));
  });
});

describe('selectBrainSystem — the override gate', () => {
  it('unchecked: saved override text is completely inert', () => {
    const sel = selectBrainSystem('minimal', null, false, 'MY CUSTOM PROMPT');
    expect(sel.prompt).toBe('minimal');
    expect(sel.override).toBeNull();
    expect(sel.system).not.toContain('MY CUSTOM PROMPT');
  });
  it('checked but empty or whitespace text: normal flow, never a blank prompt', () => {
    for (const text of [null, '', '   \n  ']) {
      const sel = selectBrainSystem('full', 'extra line', true, text);
      expect(sel.prompt).toBe('full');
      expect(sel.override).toBeNull();
      expect(sel.system.endsWith('extra line')).toBe(true);
    }
  });
  it('checked with text: the override IS the whole prompt; variant and addendum ignored', () => {
    const sel = selectBrainSystem('minimal', 'addendum that must not appear', true, ' MY CUSTOM PROMPT ');
    expect(sel).toEqual({
      system: 'MY CUSTOM PROMPT',
      prompt: 'override',
      addendum: null,
      override: 'MY CUSTOM PROMPT',
    });
  });
  it('normal flow: addendum appends verbatim after a blank line; absent when empty', () => {
    const plain = selectBrainSystem('minimal', null, false, null);
    const withAdd = selectBrainSystem('minimal', 'Never comment on the user.', false, null);
    expect(withAdd.system).toBe(`${plain.system}\n\nNever comment on the user.`);
    expect(withAdd.addendum).toBe('Never comment on the user.');
    expect(selectBrainSystem('minimal', '   ', false, null).system).toBe(plain.system);
  });
  it('the two variants produce different prompts and label themselves truthfully', () => {
    const min = selectBrainSystem('minimal', null, false, null);
    const full = selectBrainSystem('full', null, false, null);
    expect(min.prompt).toBe('minimal');
    expect(full.prompt).toBe('full');
    expect(min.system).not.toBe(full.system);
    expect(full.system.length).toBeGreaterThan(min.system.length);
  });
});

describe('brainItemLine — compact Brain input (absence = default)', () => {
  const now = new Date('2026-07-20T12:00:00Z');
  const baseView = {
    id: 'x',
    type: 'DO',
    title: 'Call grandma',
    rawTexts: [{ ts: '', text: '' }],
    status: 'active',
    deadline: null,
    deadlineHardness: null,
    cadence: null,
    optionality: 'must',
    effort: 'medium',
    pingNatured: false,
    eventAt: null,
    eventEnd: null,
    alertLeadMinutes: null,
    priorityBase: 0.5,
    priorityBoost: 0,
    boostUpdatedAt: null,
    userPriority: null,
    flavourOverride: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '',
    lastTouchedAt: '',
    lastCompletedAt: null,
    completionCount: 0,
    streak: 0,
    lastSurfacedAt: null,
    parseConfidence: 1,
    themes: [],
    flavour: 'Task',
    effectivePriority: 0.5,
    neglected: false,
  } as unknown as ItemView;

  it('a bare item writes only type, title, age, prio, and new — no null boilerplate', () => {
    // Age counts sleep-cycle days: created Jul 1 00:00Z is before the 5am
    // cutoff, so it belongs to Jun 30 — 20 sleep days before Jul 20.
    const line = brainItemLine(baseView, now);
    expect(line).toBe('DO "Call grandma" age=20d prio=0.5 new');
  });

  it('items captured today omit age', () => {
    const line = brainItemLine({ ...baseView, createdAt: '2026-07-20T09:00:00Z' } as ItemView, now);
    expect(line).not.toContain('age=');
  });

  it('the Pragmata case carries its deviations compactly', () => {
    const line = brainItemLine(
      {
        ...baseView,
        title: 'Wake up at 9:00 a.m. and play Pragmata',
        deadline: '2026-07-20T13:00:00.000Z',
        deadlineHardness: 'soft',
        optionality: 'nice',
        effort: 'quick',
        effectivePriority: 0.25,
        themes: [{ id: 't', name: 'Gaming' }],
      } as unknown as ItemView,
      now,
    );
    expect(line).toContain('due=today(soft)');
    expect(line).toContain('[Gaming]');
    expect(line).toContain('optional');
    expect(line).toContain('quick');
    expect(line).toContain('prio=0.25');
  });

  it('a recurring rhythm occurring today carries happens=today, same token as dated items', () => {
    // now is Monday Jul 20; UTC-4. The Brain never had a today marker for
    // recurring items and kept failing the "daily + it's Tuesday" inference.
    const daily = { freq: 'daily', interval: 1, atTime: '19:00' } as Cadence;
    const line = brainItemLine({ ...baseView, cadence: daily } as ItemView, now, -240);
    expect(line).toContain('happens=today(7pm)');
    expect(line).toContain('every="daily at 7pm"');
  });
  it('no happens=today off the rhythm day or once completed today', () => {
    const weeklySun = { freq: 'weekly', interval: 1, byWeekday: [0], atTime: '11:00' } as Cadence;
    expect(brainItemLine({ ...baseView, cadence: weeklySun } as ItemView, now, -240)).not.toContain('happens=');
    const daily = { freq: 'daily', interval: 1, atTime: '19:00' } as Cadence;
    expect(
      brainItemLine({ ...baseView, cadence: daily, lastCompletedAt: '2026-07-20T11:00:00Z' } as ItemView, now, -240),
    ).not.toContain('happens=');
  });

  it('due=+Nd counts sleep-cycle days, matching the UI countdown badges', () => {
    // 9am local July 23 (UTC-4); hard deadline 10pm local July 27. That is
    // 4.5×24h away — the old rolling round said +5d while the Descent notch
    // said 4 days. Sleep-day counting: 4, everywhere.
    const line = brainItemLine(
      { ...baseView, deadline: '2026-07-28T02:00:00Z', deadlineHardness: 'hard' } as ItemView,
      new Date('2026-07-23T13:00:00Z'),
      -240,
    );
    expect(line).toContain('due=+4d(hard)');
  });
  it('a 1am deadline is due=today through the evening before it', () => {
    // 10pm local July 23; due 1am local July 24 — same sleep day.
    const line = brainItemLine(
      { ...baseView, deadline: '2026-07-24T05:00:00Z', deadlineHardness: 'hard' } as ItemView,
      new Date('2026-07-24T02:00:00Z'),
      -240,
    );
    expect(line).toContain('due=today(hard)');
  });

  it('event ranges and recaptures render', () => {
    const line = brainItemLine(
      {
        ...baseView,
        type: 'HAPPEN',
        eventAt: '2026-07-20T16:00:00Z',
        eventEnd: '2026-07-25T16:00:00Z',
        rawTexts: [{ ts: '', text: 'a' }, { ts: '', text: 'b' }],
        lastSurfacedAt: '2026-07-20T05:00:00Z',
      } as unknown as ItemView,
      now,
    );
    expect(line).toContain('happens=today..+5d');
    expect(line).toContain('recaptured=1');
    expect(line).toContain('seen=today');
  });

  it('affect history renders as felt= with counts spanning recaptures', () => {
    const line = brainItemLine(
      {
        ...baseView,
        affects: [
          { tag: 'forgotten', ts: '2026-07-10T00:00:00Z' },
          { tag: 'for-someone', ts: '2026-07-10T00:00:00Z' },
          { tag: 'forgotten', ts: '2026-07-19T00:00:00Z' },
        ],
      } as unknown as ItemView,
      now,
    );
    expect(line).toContain('felt=forgotten(x2),for-someone');
    expect(brainItemLine(baseView, now)).not.toContain('felt=');
  });

  it('recapture recency renders from the boost anchor; absent anchor stays bare', () => {
    const recaptured = {
      ...baseView,
      rawTexts: [{ ts: '', text: 'a' }, { ts: '', text: 'b' }],
    } as unknown as ItemView;
    expect(brainItemLine({ ...recaptured, boostUpdatedAt: '2026-07-19T05:00:00Z' } as ItemView, now)).toContain(
      'recaptured=1(1d-ago)',
    );
    expect(brainItemLine({ ...recaptured, boostUpdatedAt: '2026-07-20T09:00:00Z' } as ItemView, now)).toContain(
      'recaptured=1(today)',
    );
    expect(brainItemLine(recaptured, now)).toMatch(/recaptured=1$/);
  });

  it('aliasItems maps short ids back to real ids', () => {
    const { lines, idByAlias } = aliasItems([baseView, { ...baseView, id: 'y' } as ItemView], now);
    expect(lines[0].startsWith('i1 ')).toBe(true);
    expect(lines[1].startsWith('i2 ')).toBe(true);
    expect(idByAlias.get('i2')).toBe('y');
  });
});

describe('compactEventLines — churn compression for the profile builder', () => {
  const ev = (ts: string, actor: string, type: string, item_id: string | null, payload: object = {}) => ({
    ts,
    actor,
    type,
    item_id,
    payload: JSON.stringify(payload),
  });
  const titles = new Map([
    ['a', 'Play Pragmata (DO)'],
    ['b', 'Make my will (DO)'],
  ]);

  it('collapses a created→edited→rejected cycle into one draft_discarded line', () => {
    const lines = compactEventLines(
      [
        ev('2026-07-20T03:10:00Z', 'ai', 'created', 'a', { title: 'Play Pragmata' }),
        ev('2026-07-20T03:12:00Z', 'user', 'edited', 'a', { before: {}, after: { deadline: 'x' } }),
        ev('2026-07-20T03:14:00Z', 'user', 'edited', 'a', { before: {}, after: { priority: 1 } }),
        ev('2026-07-20T03:20:00Z', 'user', 'rejected', 'a', { title: 'Play Pragmata' }),
      ],
      titles,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('draft_discarded');
    expect(lines[0]).toContain('Play Pragmata');
  });

  it('collapses same-item edit bursts with a count, keeps kept items visible', () => {
    const lines = compactEventLines(
      [
        ev('2026-07-20T09:00:00Z', 'ai', 'created', 'b', { title: 'Make my will' }),
        ev('2026-07-20T09:02:00Z', 'user', 'edited', 'b', { after: { deadline: 'x' } }),
        ev('2026-07-20T09:05:00Z', 'user', 'edited', 'b', { after: { priority: 1 } }),
        ev('2026-07-20T09:09:00Z', 'user', 'edited', 'b', { after: { title: 'y' } }),
      ],
      titles,
    );
    expect(lines).toHaveLength(2); // created + one collapsed edit line
    expect(lines[1]).toContain('(x3)');
  });

  it('collapses identical rapid re-captures', () => {
    const lines = compactEventLines(
      [
        ev('2026-07-20T03:00:00Z', 'user', 'captured', null, { text: 'make my will' }),
        ev('2026-07-20T03:01:00Z', 'user', 'captured', null, { text: 'Make my will ' }),
      ],
      titles,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('(x2)');
  });

  it('the profile builder sees in-world events only — no app-admin mechanics', () => {
    for (const t of ['captured', 'recaptured', 'completed', 'push_sent']) {
      expect(PROFILE_EVENT_TYPES).toContain(t);
    }
    // The librarian's restructures and the user's filing/editing gestures must
    // never reach the profile — describing them as habits fed capture a
    // self-reinforcing "consolidate everything" signal.
    for (const t of ['edited', 're_themed', 'theme_merged', 'theme_renamed', 'map_rebuilt']) {
      expect(PROFILE_EVENT_TYPES).not.toContain(t);
    }
  });

  it('slow-burn rejections are NOT draft churn', () => {
    const lines = compactEventLines(
      [
        ev('2026-07-18T09:00:00Z', 'ai', 'created', 'b', { title: 'Make my will' }),
        ev('2026-07-20T09:00:00Z', 'user', 'rejected', 'b', { title: 'Make my will' }),
      ],
      titles,
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('rejected');
  });
});

describe('extractJson robustness', () => {
  it('parses bare JSON', () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  it('parses fenced JSON', () => {
    expect(extractJson<{ a: number }>('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('parses JSON embedded in prose with nested braces and strings', () => {
    const text = 'Sure! {"items":[{"title":"say \\"hi\\" {ok}","n":2}],"confidence":"high"} hope that helps';
    expect(extractJson<{ items: unknown[] }>(text).items).toHaveLength(1);
  });
});

describe('fallback trigram embeddings', () => {
  it('scores paraphrases above unrelated text', () => {
    const a = trigramEmbed('Sarah is allergic to nuts');
    const b = trigramEmbed('remember Sarah has a nut allergy');
    const c = trigramEmbed('water the plants every monday');
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
    expect(cosine(a, b)).toBeGreaterThan(0.3);
  });
});

describe('search semantic cutoff (§6)', () => {
  const BGE_DIMS = 768;

  it('rejects the bge unrelated-text band instead of returning the whole corpus', () => {
    // bge gives ~0.6-0.75 cosine to unrelated English; none of these should pass.
    const sims = [0.62, 0.66, 0.7, 0.64, 0.68];
    const cut = semanticCut(sims, BGE_DIMS);
    expect(sims.filter((s) => s >= cut)).toHaveLength(0);
  });

  it('keeps a real bge match and its near-ties, drops the unrelated crowd', () => {
    const sims = [0.86, 0.82, 0.7, 0.66, 0.62];
    const cut = semanticCut(sims, BGE_DIMS);
    expect(sims.filter((s) => s >= cut)).toEqual([0.86, 0.82]);
  });

  it('when everything genuinely matches, everything survives', () => {
    const sims = [0.88, 0.85, 0.84, 0.83];
    const cut = semanticCut(sims, BGE_DIMS);
    expect(sims.filter((s) => s >= cut)).toHaveLength(4);
  });

  it('with the trigram fallback, a paraphrase clears the cut and unrelated items do not', () => {
    const q = trigramEmbed("Sarah's food thing");
    const corpus = [
      trigramEmbed('remember Sarah has a nut allergy'),
      trigramEmbed('water the plants every monday'),
      trigramEmbed('dentist appointment in august'),
    ];
    const sims = corpus.map((e) => cosine(q, e));
    const cut = semanticCut(sims, q.length);
    expect(sims[0]).toBeGreaterThanOrEqual(cut);
    expect(sims[1]).toBeLessThan(cut);
    expect(sims[2]).toBeLessThan(cut);
  });

  it('a gibberish query matches nothing under either backend', () => {
    expect(semanticCut([0.05, 0.1, 0.02], trigramEmbed('xqzzt vprw').length)).toBeGreaterThan(0.1);
    expect(semanticCut([0.4, 0.5], BGE_DIMS)).toBeGreaterThan(0.5);
  });
});
