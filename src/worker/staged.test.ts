import { describe, expect, it } from 'vitest';
import { deriveBubbleKind, selectBrainSystem, validateCurationPlan } from './brain';
import type { BrainTier } from './placement';

// Staged pipeline, layer 2: validateCurationPlan turns the curator's raw JSON
// into the guarantees the spec owns — known aliases only, floors never
// undercut, at most two invitations, every mandatory item covered, loudest
// first — and nothing more. Membership IS the add declaration (the old
// separate adds ledger silently amputated a correct package when the model
// forgot to double-book a member), and the occurrence/sitting fields are
// elicitation only: no code judges them.

const floors = new Map<string, { floor: BrainTier; rule: string }>([
  ['i1', { floor: 'mid', rule: 'due-today' }],
  ['i2', { floor: 'quiet', rule: 'rhythm-today' }],
]);
const eligible = new Set(['i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'i9']);

const bubble = (over: Record<string, unknown>) => ({
  members: [],
  bond: 'solo',
  tier: 'quiet',
  rationale: 'r',
  firstStep: null,
  ...over,
});

describe('validateCurationPlan — membership is the declaration', () => {
  it('any known item may join a bubble; unknown aliases and duplicates drop', () => {
    const plan = validateCurationPlan(
      { bubbles: [bubble({ members: ['i1', 'i5', 'ix', 'i5'], bond: 'package' }), bubble({ members: ['i2'] })] },
      floors,
      eligible,
    );
    expect(plan.bubbles.map((b) => b.members)).toEqual([['i1', 'i5'], ['i2']]);
  });

  it('a correct multi-member package needs no side ledger to survive intact', () => {
    // The regression this schema exists to prevent: lesson+class composed
    // right, one member lost to a forgotten adds declaration.
    const plan = validateCurationPlan(
      { bubbles: [bubble({ members: ['i1', 'i2'] }), bubble({ members: ['i7', 'i8'], bond: 'package', sitting: 'one phone sitting' })] },
      floors,
      eligible,
    );
    const pkg = plan.bubbles.find((b) => b.bond === 'package' && b.sitting);
    expect(pkg?.members).toEqual(['i7', 'i8']);
  });

  it('drops a bubble whose members all filter away', () => {
    const plan = validateCurationPlan(
      { bubbles: [bubble({ members: ['ix', 'iy'] }), bubble({ members: ['i1', 'i2'] })] },
      floors,
      eligible,
    );
    expect(plan.bubbles).toHaveLength(1);
  });
});

describe('validateCurationPlan — elicited bond claims', () => {
  it('an episode keeps its occurrence; a package keeps its sitting', () => {
    const plan = validateCurationPlan(
      {
        bubbles: [
          bubble({ members: ['i1'], bond: 'episode', occurrence: 'the cottage trip' }),
          bubble({ members: ['i2'], bond: 'package', sitting: 'the Chinatown trip' }),
        ],
      },
      floors,
      eligible,
    );
    expect(plan.bubbles[0]).toMatchObject({ bond: 'episode', occurrence: 'the cottage trip', sitting: null });
    expect(plan.bubbles[1]).toMatchObject({ bond: 'package', sitting: 'the Chinatown trip', occurrence: null });
  });

  it('a claim on the wrong bond is a confused claim, not data — nulled', () => {
    const plan = validateCurationPlan(
      {
        bubbles: [
          bubble({ members: ['i1'], bond: 'package', occurrence: 'not how packages work' }),
          bubble({ members: ['i2'], bond: 'solo', occurrence: 'solos claim nothing', sitting: 'nor this' }),
        ],
      },
      floors,
      eligible,
    );
    expect(plan.bubbles[0]).toMatchObject({ occurrence: null, sitting: null });
    expect(plan.bubbles[1]).toMatchObject({ occurrence: null, sitting: null });
  });

  it('tags are annotation: validated as strings, capped, never a gate', () => {
    const plan = validateCurationPlan(
      { bubbles: [bubble({ members: ['i3'], tags: ['starved', 42, 'stalled', 'x', 'y', 'z'] })] },
      floors,
      eligible,
    );
    const tagged = plan.bubbles.find((b) => b.members[0] === 'i3');
    expect(tagged?.tags).toEqual(['starved', '42', 'stalled', 'x']);
  });
});

describe('validateCurationPlan — the guarantees', () => {
  it("raises a bubble's tier to its loudest member's floor — floors are floors", () => {
    const plan = validateCurationPlan(
      { bubbles: [bubble({ members: ['i1', 'i2'], tier: 'dot' })] },
      floors,
      eligible,
    );
    expect(plan.bubbles[0].tier).toBe('mid');
  });

  it('coerces an unknown bond by member count: package for many, solo for one', () => {
    const plan = validateCurationPlan(
      { bubbles: [bubble({ members: ['i1', 'i2'], bond: 'vibes' }), bubble({ members: ['i1'], bond: 'vibes' })] },
      floors,
      eligible,
    );
    expect(plan.bubbles.map((b) => b.bond)).toEqual(['package', 'solo']);
  });

  it('caps firstStep flags at two per map, in plan order, and discards invalid values', () => {
    const plan = validateCurationPlan(
      {
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

  it('an ignored mandatory item gets a solo bubble at its floor, its rule as rationale', () => {
    const plan = validateCurationPlan({ bubbles: [bubble({ members: ['i1'] })] }, floors, eligible);
    const solo = plan.bubbles.find((b) => b.members.includes('i2'));
    expect(solo).toMatchObject({ members: ['i2'], bond: 'solo', tier: 'quiet', rationale: 'rhythm-today' });
  });

  it('a null/garbage plan still yields full mandatory coverage', () => {
    const plan = validateCurationPlan(null, floors, eligible);
    expect(plan.bubbles.map((b) => b.members).flat().sort()).toEqual(['i1', 'i2']);
  });

  it('sorts loudest first, stable within a tier (plan order is the ranking)', () => {
    const plan = validateCurationPlan(
      {
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
