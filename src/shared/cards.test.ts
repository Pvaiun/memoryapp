import { describe, expect, it } from 'vitest';
import type { ItemView } from './types';
import {
  anchorThemeName,
  deriveConstruction,
  deriveDeadlineNotch,
  deriveSpanRail,
  farTokens,
  parseSentence,
  resolveSentence,
  stripSentence,
  withMemberChips,
} from './cards';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-07-21T12:00:00Z').getTime();

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
    createdAt: new Date(NOW - 7 * DAY_MS).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    lastTouchedAt: new Date(NOW).toISOString(),
    lastCompletedAt: null,
    completionCount: 0,
    streak: 0,
    lastSurfacedAt: null,
    parseConfidence: 1,
    themes: [],
    flavour: 'Task',
    effectivePriority: 0.5,
    neglected: false,
    doneToday: false,
    ...over,
  };
}

describe('withMemberChips — the chip guarantee', () => {
  it('appends a chip for a member DO the prose only bolded', () => {
    const recycling = item({ id: 'r1', title: 'Take out recycling' });
    const segs = withMemberChips(parseSentence('**Recycling** goes out tonight at 9:30.'), [recycling]);
    expect(segs[segs.length - 1]).toEqual({ kind: 'chip', text: 'Take out recycling', itemId: 'r1' });
  });
  it('leaves a fully-chipped card untouched', () => {
    const doc = item({ id: 'd1', title: 'Call the doctor' });
    const segs = parseSentence('[Call the doctor](d1) — hard deadline.');
    expect(withMemberChips(segs, [doc])).toBe(segs);
  });
  it('skips HAPPENs and KNOWs — only DOs are completable', () => {
    const visit = item({ id: 'v1', type: 'HAPPEN', title: 'Sarah visiting' });
    const segs = parseSentence('**Sarah** is here through Friday.');
    expect(withMemberChips(segs, [visit])).toBe(segs);
  });
  it('keeps completed DOs so a checked chip stays on the card', () => {
    const done = item({ id: 'c1', title: 'Take out garbage', status: 'completed' });
    const segs = withMemberChips(parseSentence('Bins night.'), [done]);
    expect(segs.some((s) => s.kind === 'chip' && s.itemId === 'c1')).toBe(true);
  });
});

describe('sentence markup — the card grammar', () => {
  it('parses prose, bold tokens, and chips in order', () => {
    const segs = parseSentence('**Sarah** arrives — the [litter boxes](id1) by noon.');
    expect(segs).toEqual([
      { kind: 'bold', text: 'Sarah' },
      { kind: 'text', text: ' arrives — the ' },
      { kind: 'chip', text: 'litter boxes', itemId: 'id1' },
      { kind: 'text', text: ' by noon.' },
    ]);
  });

  it('plain prose is one text run (legacy reason fallback)', () => {
    expect(parseSentence('Dentist Tue 3pm.')).toEqual([{ kind: 'text', text: 'Dentist Tue 3pm.' }]);
  });

  it('strips markup to plain prose', () => {
    expect(stripSentence('**Sarah** arrives — the [litter boxes](id1) by noon.')).toBe(
      'Sarah arrives — the litter boxes by noon.',
    );
  });

  it('far form keeps only the bold and chip tokens', () => {
    expect(farTokens(parseSentence('**Sarah & Deidra** arrive **today** — the [litter boxes](x) by noon.'))).toEqual([
      'Sarah & Deidra',
      'today',
      'litter boxes',
    ]);
  });
});

describe('resolveSentence — worker-side hygiene', () => {
  const aliases = new Map([
    ['i1', 'real-1'],
    ['i2', 'real-2'],
  ]);

  it('resolves chip aliases to member ids', () => {
    expect(resolveSentence('Do the [boxes](i1) now.', aliases, new Set(['real-1']))).toBe(
      'Do the [boxes](real-1) now.',
    );
  });

  it('degrades unknown aliases and non-members to bold, never breaks prose', () => {
    expect(resolveSentence('Do the [boxes](i9) and [beds](i2).', aliases, new Set(['real-1']))).toBe(
      'Do the **boxes** and **beds**.',
    );
  });

  it('accepts already-resolved member ids; chips unlimited by default, capped on request', () => {
    const all = new Set(['a', 'b', 'c', 'd']);
    expect(resolveSentence('[1](a) [2](b) [3](c) [4](d)', new Map(), all)).toBe('[1](a) [2](b) [3](c) [4](d)');
  });

  it('an explicit maxChips still degrades the overflow to bold', () => {
    const members = new Set(['a', 'b', 'c', 'd']);
    expect(resolveSentence('[1](a) [2](b) [3](c) [4](d)', new Map(), members, 3)).toBe('[1](a) [2](b) [3](c) **4**');
  });

  it('leaves bold tokens alone', () => {
    expect(resolveSentence('**today** matters.', aliases, new Set())).toBe('**today** matters.');
  });
});

describe('deriveConstruction — mechanical, from cluster shape', () => {
  it('4+ same-type siblings are a batch', () => {
    expect(deriveConstruction([item({}), item({}), item({}), item({})], null)).toBe('batch');
  });

  it('a mixed four is woven, not a batch', () => {
    expect(deriveConstruction([item({}), item({ type: 'KNOW' }), item({ type: 'HAPPEN' }), item({})], null)).toBe(
      'woven',
    );
  });

  it('one big undated thing is a nudge', () => {
    expect(deriveConstruction([item({ effort: 'large' })], null)).toBe('nudge');
    expect(deriveConstruction([item({})], 'List your assets.')).toBe('nudge');
  });

  it('a dated single item is never a nudge', () => {
    expect(deriveConstruction([item({ effort: 'large', deadline: new Date(NOW + DAY_MS).toISOString() })], 'step')).toBe(
      'woven',
    );
  });
});

describe('bricks', () => {
  it('span rail covers the union of multi-day event spans with today marked', () => {
    const rail = deriveSpanRail(
      [
        item({
          type: 'HAPPEN',
          eventAt: new Date(NOW - DAY_MS).toISOString(),
          eventEnd: new Date(NOW + 3 * DAY_MS).toISOString(),
        }),
      ],
      NOW,
    );
    expect(rail).not.toBeNull();
    expect(rail!.todayFrac).toBeCloseTo(0.25, 5);
  });

  it('an afternoon appointment gets no rail', () => {
    const rail = deriveSpanRail(
      [item({ type: 'HAPPEN', eventAt: new Date(NOW).toISOString(), eventEnd: new Date(NOW + 2 * 3600e3).toISOString() })],
      NOW,
    );
    expect(rail).toBeNull();
  });

  it('deadline notch counts down the nearest HARD date only', () => {
    const notch = deriveDeadlineNotch(
      [
        item({ deadline: new Date(NOW + 5 * DAY_MS).toISOString(), deadlineHardness: 'hard' }),
        item({ deadline: new Date(NOW + 2 * DAY_MS).toISOString(), deadlineHardness: 'soft' }),
      ],
      NOW,
    );
    expect(notch).toEqual({ days: 5, label: '5 days' });
  });

  it('no hard deadline → no notch; completed items are invisible to bricks', () => {
    expect(deriveDeadlineNotch([item({ deadline: new Date(NOW).toISOString(), deadlineHardness: 'soft' })], NOW)).toBeNull();
    expect(
      deriveDeadlineNotch(
        [item({ deadline: new Date(NOW).toISOString(), deadlineHardness: 'hard', status: 'completed' })],
        NOW,
      ),
    ).toBeNull();
  });

  it('anchor theme is the majority theme, ties toward member order', () => {
    const home = [{ id: 't1', name: 'Home' }];
    const move = [{ id: 't2', name: 'Move' }];
    expect(anchorThemeName([item({ themes: move }), item({ themes: home }), item({ themes: home })])).toBe('Home');
    expect(anchorThemeName([item({ themes: move }), item({ themes: home })])).toBe('Move');
    expect(anchorThemeName([item({})])).toBeNull();
  });
});
