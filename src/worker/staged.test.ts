import { describe, expect, it } from 'vitest';
import { deriveBubbleKind, MAX_CURATION_ADDS, selectBrainSystem, validateCurationPlan } from './brain';
import type { BrainTier } from './placement';

// Staged pipeline, layer 2: validateCurationPlan turns the curator's raw JSON
// into guarantees. The prompt merely *requests* these; every one is enforced
// here — adds only from the eligible pile, the cap, members only from
// mandatory ∪ declared adds, floors never undercut, one firstStep, full
// mandatory coverage, no vanishing adds, loudest-first order.

const floors = new Map<string, { floor: BrainTier; rule: string }>([
  ['i1', { floor: 'mid', rule: 'due-today' }],
  ['i2', { floor: 'quiet', rule: 'rhythm-today' }],
]);
const eligible = new Set(['i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'i9', 'i10', 'i11', 'i12', 'i13']);

const bubble = (over: Record<string, unknown>) => ({
  members: [],
  bond: 'solo',
  tier: 'quiet',
  rationale: 'r',
  firstStep: null,
  ...over,
});

describe('validateCurationPlan — adds', () => {
  it('drops mandatory ids, unknown ids, and duplicates from adds', () => {
    const plan = validateCurationPlan(
      {
        adds: [
          { id: 'i1', rationale: 'already required', tags: [], tier: 'mid' },
          { id: 'ix', rationale: 'no such item', tags: [], tier: 'mid' },
          { id: 'i3', rationale: 'starved', tags: ['starved'], tier: 'dot' },
          { id: 'i3', rationale: 'again', tags: [], tier: 'mid' },
        ],
        bubbles: [bubble({ members: ['i1', 'i2', 'i3'], bond: 'package' })],
      },
      floors,
      eligible,
    );
    expect(plan.adds.map((a) => a.id)).toEqual(['i3']);
    expect(plan.adds[0].tags).toEqual(['starved']);
  });

  it('caps adds at MAX_CURATION_ADDS (the runaway backstop)', () => {
    const plan = validateCurationPlan(
      {
        adds: ['i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'i9', 'i10', 'i11', 'i12', 'i13'].map((id) => ({
          id,
          rationale: 'r',
          tags: [],
          tier: 'dot',
        })),
        bubbles: [bubble({ members: ['i1', 'i2'], bond: 'package' })],
      },
      floors,
      eligible,
    );
    expect(plan.adds).toHaveLength(MAX_CURATION_ADDS);
  });

  it('coerces an invalid add tier to quiet', () => {
    const plan = validateCurationPlan(
      { adds: [{ id: 'i3', rationale: 'r', tags: [], tier: 'huge' }], bubbles: [] },
      floors,
      eligible,
    );
    expect(plan.adds[0].tier).toBe('quiet');
  });
});

describe('validateCurationPlan — bubbles', () => {
  it('drops undeclared eligible members (inclusion requires a declared add)', () => {
    const plan = validateCurationPlan(
      { adds: [], bubbles: [bubble({ members: ['i1', 'i5'] }), bubble({ members: ['i2'] })] },
      floors,
      eligible,
    );
    expect(plan.bubbles.map((b) => b.members)).toEqual([['i1'], ['i2']]);
  });

  it('drops a bubble whose members all filter away', () => {
    const plan = validateCurationPlan(
      { adds: [], bubbles: [bubble({ members: ['i9'] }), bubble({ members: ['i1', 'i2'] })] },
      floors,
      eligible,
    );
    expect(plan.bubbles).toHaveLength(1);
    expect(plan.bubbles[0].members).toEqual(['i1', 'i2']);
  });

  it("raises a bubble's tier to its loudest member's floor — floors are floors", () => {
    const plan = validateCurationPlan(
      { adds: [], bubbles: [bubble({ members: ['i1', 'i2'], tier: 'dot' })] },
      floors,
      eligible,
    );
    expect(plan.bubbles[0].tier).toBe('mid');
  });

  it('coerces an unknown bond by member count: package for many, solo for one', () => {
    const plan = validateCurationPlan(
      {
        adds: [],
        bubbles: [bubble({ members: ['i1', 'i2'], bond: 'vibes' }), bubble({ members: ['i1'], bond: 'vibes' })],
      },
      floors,
      eligible,
    );
    expect(plan.bubbles.map((b) => b.bond)).toEqual(['package', 'solo']);
  });

  it('caps firstStep flags at two per map, in plan order, and discards invalid values', () => {
    const plan = validateCurationPlan(
      {
        adds: [],
        bubbles: [
          bubble({ members: ['i1', 'i2'], firstStep: 'write-it-for-me' }),
          bubble({ members: ['i2'], firstStep: 'breakdown' }),
          bubble({ members: ['i2'], firstStep: 'name-a-when' }),
          bubble({ members: ['i2'], firstStep: 'tiny-first-move' }),
        ],
      },
      floors,
      eligible,
    );
    expect(plan.bubbles.map((b) => b.firstStep)).toEqual([null, 'breakdown', 'name-a-when', null]);
  });
});

describe('validateCurationPlan — coverage nets', () => {
  it('an ignored mandatory item gets a solo bubble at its floor, its rule as rationale', () => {
    const plan = validateCurationPlan({ adds: [], bubbles: [bubble({ members: ['i1'] })] }, floors, eligible);
    const solo = plan.bubbles.find((b) => b.members.includes('i2'));
    expect(solo).toMatchObject({ members: ['i2'], bond: 'solo', tier: 'quiet', rationale: 'rhythm-today' });
  });

  it('a declared add the plan never placed gets its own bubble — adds never vanish', () => {
    const plan = validateCurationPlan(
      {
        adds: [{ id: 'i3', rationale: 'starved ten days', tags: ['starved'], tier: 'dot' }],
        bubbles: [bubble({ members: ['i1', 'i2'], bond: 'package' })],
      },
      floors,
      eligible,
    );
    const solo = plan.bubbles.find((b) => b.members.includes('i3'));
    expect(solo).toMatchObject({ members: ['i3'], bond: 'solo', tier: 'dot', rationale: 'starved ten days' });
  });

  it('a null/garbage plan still yields full mandatory coverage', () => {
    const plan = validateCurationPlan(null, floors, eligible);
    expect(plan.adds).toEqual([]);
    expect(plan.bubbles.map((b) => b.members).flat().sort()).toEqual(['i1', 'i2']);
  });
});

describe('validateCurationPlan — ordering', () => {
  it('sorts loudest first, stable within a tier (plan order is the ranking)', () => {
    const plan = validateCurationPlan(
      {
        adds: [
          { id: 'i3', rationale: 'a', tags: [], tier: 'mid' },
          { id: 'i4', rationale: 'b', tags: [], tier: 'mid' },
        ],
        bubbles: [
          bubble({ members: ['i2'], tier: 'quiet', rationale: 'first-quiet' }),
          bubble({ members: ['i1'], tier: 'loud', rationale: 'the-loud-one' }),
          bubble({ members: ['i3'], tier: 'mid', rationale: 'mid-A' }),
          bubble({ members: ['i4'], tier: 'mid', rationale: 'mid-B' }),
        ],
      },
      floors,
      eligible,
    );
    expect(plan.bubbles.map((b) => b.rationale)).toEqual(['the-loud-one', 'mid-A', 'mid-B', 'first-quiet']);
  });
});

describe("selectBrainSystem('staged') — the hinge rebuildMap dispatches the pipeline on", () => {
  it("passes 'staged' through as the prompt choice when no override is in force", () => {
    const r = selectBrainSystem('staged', null, false, null);
    expect(r.prompt).toBe('staged');
    expect(r.override).toBeNull();
  });

  it('carries the addendum along so the staged path can hand it to the curator', () => {
    const r = selectBrainSystem('staged', '  extra guidance  ', false, null);
    expect(r.prompt).toBe('staged');
    expect(r.addendum).toBe('extra guidance');
  });

  it('an enabled, non-empty override outranks the staged pipeline entirely', () => {
    const r = selectBrainSystem('staged', 'addendum too', true, 'THE WHOLE PROMPT');
    expect(r.prompt).toBe('override');
    expect(r.system).toBe('THE WHOLE PROMPT');
    expect(r.addendum).toBeNull();
  });

  it('checked-but-empty override falls back to the staged choice', () => {
    const r = selectBrainSystem('staged', null, true, '   ');
    expect(r.prompt).toBe('staged');
  });
});

describe('deriveBubbleKind — the rehearsal register is derived, never declared', () => {
  it('all-KNOW membership renders as rotation', () => {
    expect(deriveBubbleKind(['KNOW', 'KNOW'])).toBe('rotation');
  });
  it('any actionable member makes it a situation card', () => {
    expect(deriveBubbleKind(['KNOW', 'DO'])).toBe('situation');
    expect(deriveBubbleKind(['HAPPEN'])).toBe('situation');
  });
  it('empty membership defaults to situation', () => {
    expect(deriveBubbleKind([])).toBe('situation');
  });
});
