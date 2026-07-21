import { describe, expect, it } from 'vitest';
import {
  band,
  buildTrack,
  cameraAt,
  cameraRange,
  corridorY,
  cubicBezier,
  CULL_BEHIND,
  DEPTH_RANGE,
  depthCues,
  engagedIndex,
  FOCUS_FRAC,
  MIN_SPACING,
  passState,
  puckP,
  puckYAt,
  scaleFor,
  scrollFor,
  settleTarget,
  spreadPositions,
  TOP_BEFORE,
  VP_FRAC,
} from './engine';

// The visual spec's sample day, sorted by prominence.
const SAMPLE = [
  { id: 'sarah', prominence: 0.95 },
  { id: 'passport', prominence: 0.66 },
  { id: 'plants', prominence: 0.58 },
  { id: 'doctor', prominence: 0.55 },
  { id: 'address', prominence: 0.45 },
  { id: 'gym', prominence: 0.42 },
  { id: 'gift', prominence: 0.38 },
  { id: 'driving', prominence: 0.3 },
  { id: 'will', prominence: 0.28 },
  { id: 'pragmata', prominence: 0.25 },
  { id: 'piranesi', prominence: 0.18 },
  { id: 'rotation', prominence: 0.15 },
];

describe('buildTrack', () => {
  it('sorts by prominence descending with stable id tiebreak', () => {
    const track = buildTrack([
      { id: 'b', prominence: 0.5 },
      { id: 'a', prominence: 0.5 },
      { id: 'c', prominence: 0.9 },
    ]);
    expect(track.map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('renders real cliffs well past the spacing floor — depth is felt', () => {
    const track = buildTrack(SAMPLE);
    const cliff = track[1].zp - track[0].zp; // 0.95 → 0.66
    expect(cliff).toBeCloseTo(0.29 * DEPTH_RANGE); // 464 — untouched
    expect(cliff / MIN_SPACING).toBeGreaterThan(2);
  });

  it('stretches close prominences to the spacing floor, monotonically', () => {
    const track = buildTrack(SAMPLE);
    for (let i = 1; i < track.length; i++) {
      expect(track[i].zp - track[i - 1].zp).toBeGreaterThanOrEqual(MIN_SPACING - 1e-9);
      expect(track[i].zp).toBeGreaterThanOrEqual((1 - track[i].p) * DEPTH_RANGE - 1e-9);
    }
    // 0.58 → 0.55 is a 48-unit true gap: inflates to exactly the floor
    expect(track[3].zp - track[2].zp).toBeCloseTo(MIN_SPACING);
  });

  it('is deterministic: same input, same output', () => {
    expect(buildTrack(SAMPLE)).toEqual(buildTrack([...SAMPLE].reverse()));
  });
});

describe('camera mapping', () => {
  it('travels from the overview down to a hard stop ON the last plane', () => {
    const track = buildTrack(SAMPLE);
    const { cStart, cEnd } = cameraRange(track);
    expect(cStart).toBeCloseTo(track[0].zp - TOP_BEFORE);
    expect(cEnd).toBeCloseTo(track[track.length - 1].zp); // no travel past it
  });

  it('round-trips scroll ↔ camera', () => {
    const { cStart } = cameraRange(buildTrack(SAMPLE));
    expect(cameraAt(cStart, scrollFor(cStart, 500))).toBeCloseTo(500);
  });
});

describe('puckP — physical cursor on a true scale', () => {
  const track = buildTrack(SAMPLE);

  it('sits exactly on each card’s true p at its focal plane', () => {
    for (const t of track) expect(puckP(track, t.zp)).toBeCloseTo(t.p);
  });

  it('starts at the top cap in the overview and eases onto the first card', () => {
    expect(puckP(track, track[0].zp - TOP_BEFORE)).toBe(1);
    expect(puckP(track, track[0].zp - 5000)).toBe(1); // rubber band clamps
    const mid = puckP(track, track[0].zp - TOP_BEFORE / 2);
    expect(mid).toBeGreaterThan(track[0].p);
    expect(mid).toBeLessThan(1);
  });

  it('interpolates between true p values across each physical gap', () => {
    const a = track[2]; // plants .58
    const b = track[3]; // doctor .55 — floored gap
    expect(puckP(track, (a.zp + b.zp) / 2)).toBeCloseTo((a.p + b.p) / 2);
  });

  it('is monotone non-increasing along the whole descent', () => {
    let prev = Infinity;
    const { cStart, cEnd } = cameraRange(track);
    for (let c = cStart; c <= cEnd; c += 10) {
      const p = puckP(track, c);
      expect(p).toBeLessThanOrEqual(prev + 1e-9);
      prev = p;
    }
  });

  it('holds the last card’s p at the bottom stop', () => {
    expect(puckP(track, track[track.length - 1].zp)).toBeCloseTo(0.15);
  });
});

describe('directional settle', () => {
  const rests = [0, 100, 300, 600];

  it('stays put when resting on a plane', () => {
    expect(settleTarget(rests, 300, 1)).toBe(300);
    expect(settleTarget(rests, 300, -1)).toBe(300);
  });

  it('commits forward once past the hysteresis, in either direction', () => {
    expect(settleTarget(rests, 140, 1)).toBe(300); // moved 40 down → next down
    expect(settleTarget(rests, 560, -1)).toBe(300); // moved 40 up → next up
  });

  it('drifts back inside the hysteresis', () => {
    expect(settleTarget(rests, 120, 1)).toBe(100); // only 20 past → return
    expect(settleTarget(rests, 580, -1)).toBe(600);
  });

  it('never overshoots the ends', () => {
    expect(settleTarget(rests, 650, 1)).toBe(600);
    expect(settleTarget(rests, -50, -1)).toBe(0);
  });
});

describe('corridor projection', () => {
  it('puts the focal plane at FOCUS_FRAC and recedes toward the vanishing line', () => {
    const vh = 800;
    expect(corridorY(1, vh)).toBeCloseTo(FOCUS_FRAC * vh);
    expect(corridorY(0, vh)).toBeCloseTo(VP_FRAC * vh);
    expect(corridorY(0.7, vh)).toBeGreaterThan(corridorY(0.4, vh));
  });

  it('scale is 1 at focus and grows past it, capped', () => {
    expect(scaleFor(0)).toBe(1);
    expect(scaleFor(380)).toBeCloseTo(0.5);
    expect(scaleFor(-300)).toBe(2.4);
  });
});

describe('depth cues', () => {
  it('holds the near plateau and ramps to the mid floor', () => {
    expect(depthCues(0)).toEqual({ opacity: 1, saturation: 1, contrast: 1 });
    const mid = depthCues(650);
    expect(mid.opacity).toBeCloseTo(0.32);
    expect(mid.saturation).toBeCloseTo(0.55);
    expect(mid.contrast).toBeCloseTo(0.8);
  });
  it('floors opacity at 0.15 from d = 1000, held', () => {
    expect(depthCues(1000).opacity).toBeCloseTo(0.15);
    expect(depthCues(2000).opacity).toBeCloseTo(0.15);
  });
  it('reduced motion steepens the ramp but keeps the same endpoints', () => {
    expect(depthCues(420, true).opacity).toBeCloseTo(0.32);
    expect(depthCues(100, true).opacity).toBe(1);
  });
});

describe('the pass (vertical exit)', () => {
  it('is identity at and before focus', () => {
    expect(passState(0)).toEqual({ drop: 0, alpha: 1 });
    expect(passState(500)).toEqual({ drop: 0, alpha: 1 });
  });
  it('drops fully and fades out by the cull point', () => {
    const p = passState(CULL_BEHIND);
    expect(p.drop).toBeCloseTo(1);
    expect(p.alpha).toBeCloseTo(0);
  });
  it('drop is monotone — the card only ever moves down', () => {
    let prev = 0;
    for (let d = 0; d >= CULL_BEHIND; d -= 10) {
      const { drop } = passState(d);
      expect(drop).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = drop;
    }
  });
});

describe('spreadPositions — equal values fan around their true position', () => {
  it('leaves well-spaced values untouched', () => {
    expect(spreadPositions([10, 40, 90], 8)).toEqual([10, 40, 90]);
  });

  it('spreads an exact-tie trio symmetrically around the shared value', () => {
    expect(spreadPositions([100, 100, 100], 8)).toEqual([92, 100, 108]);
  });

  it('keeps order and minimum gap for near-ties, centered on the cluster', () => {
    const out = spreadPositions([100, 102, 104], 10);
    expect(out).toEqual([92, 102, 112]); // centered on mean 102
    for (let i = 1; i < out.length; i++) expect(out[i] - out[i - 1]).toBeGreaterThanOrEqual(10);
  });

  it('merges chained clusters instead of cascading them downward', () => {
    const out = spreadPositions([100, 100, 106, 106], 8);
    // one merged cluster centered on 103
    expect(out).toEqual([91, 99, 107, 115]);
  });

  it('shifts only the edge cluster when it hits a bound — not the whole list', () => {
    const out = spreadPositions([20, 196, 196, 196], 8, 10, 200);
    expect(out[0]).toBe(20); // untouched
    expect(out[3]).toBeLessThanOrEqual(200);
    expect(out[1]).toBeCloseTo(out[3] - 16);
  });

  it('is deterministic and order-preserving', () => {
    const ys = [50, 50, 50, 50, 300];
    const a = spreadPositions(ys, 8, 0, 400);
    expect(a).toEqual(spreadPositions(ys, 8, 0, 400));
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThan(a[i - 1]);
  });
});

describe('puckYAt — puck rides the resolved dot layout', () => {
  const track = buildTrack([
    { id: 'a', prominence: 0.9 },
    { id: 'b', prominence: 0.3 },
    { id: 'c', prominence: 0.3 },
    { id: 'd', prominence: 0.3 },
  ]);
  const ys = [50, 392, 400, 408]; // b/c/d fanned around a shared true y

  it('lands exactly on each resolved dot at its focal plane', () => {
    track.forEach((t, idx) => {
      expect(puckYAt(track, t.zp, ys, 10)).toBeCloseTo(ys[idx]);
    });
  });

  it('eases from the top cap onto the first dot through the overview', () => {
    expect(puckYAt(track, track[0].zp - TOP_BEFORE, ys, 10)).toBe(10);
    const mid = puckYAt(track, track[0].zp - TOP_BEFORE / 2, ys, 10);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThan(50);
  });

  it('interpolates between resolved dots across a physical gap', () => {
    const midC = (track[1].zp + track[2].zp) / 2;
    expect(puckYAt(track, midC, ys, 10)).toBeCloseTo((392 + 400) / 2);
  });

  it('holds the last dot at the bottom stop', () => {
    expect(puckYAt(track, track[3].zp + 999, ys, 10)).toBe(408);
  });
});

describe('gauge and ledger helpers', () => {
  it('engaged card minimizes |d|', () => {
    const track = buildTrack(SAMPLE);
    expect(engagedIndex(track, track[0].zp)).toBe(0);
    expect(engagedIndex(track, track[4].zp + 10)).toBe(4);
  });
  it('band is a clamped linear ramp', () => {
    expect(band(5, 0, 10)).toBe(0.5);
    expect(band(11, 0, 10)).toBe(1);
  });
});

describe('cubicBezier', () => {
  it('matches endpoints and is monotone', () => {
    const ease = cubicBezier(0.2, 0.8, 0.2, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    let prev = 0;
    for (let x = 0; x <= 1.001; x += 0.05) {
      const y = ease(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = y;
    }
  });
});
