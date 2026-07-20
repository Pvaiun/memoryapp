import { describe, expect, it } from 'vitest';
import { computeDueAlerts } from './push';
import { extractJson } from './ai';
import { trigramEmbed } from './embeddings';
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
