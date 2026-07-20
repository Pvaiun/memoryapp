import { describe, expect, it } from 'vitest';
import {
  band,
  buildTrack,
  cameraAt,
  cameraRange,
  cubicBezier,
  depthCues,
  engagedIndex,
  fanRows,
  gaugeColumns,
  latMag,
  passState,
  pCam,
  scaleFor,
  scrollFor,
  tierFades,
} from './engine';

// The spec's sample day (§ intro), sorted by prominence.
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

  it('leaves large gaps untouched (the 0.95 → 0.66 cliff renders as data)', () => {
    const track = buildTrack(SAMPLE);
    expect(track[0].zp).toBeCloseTo(0.05 * 1100); // 55
    expect(track[1].zp).toBeCloseTo(0.34 * 1100); // 374 — gap 319, untouched
  });

  it('inflates sub-threshold gaps to the 56-unit floor, monotonically', () => {
    const track = buildTrack(SAMPLE);
    for (let i = 1; i < track.length; i++) {
      expect(track[i].zp - track[i - 1].zp).toBeGreaterThanOrEqual(56 - 1e-9);
      // never pulled forward of true depth
      expect(track[i].zp).toBeGreaterThanOrEqual((1 - track[i].p) * 1100 - 1e-9);
    }
    // 0.58 → 0.55 is a 33-unit true gap: must inflate to exactly 56
    expect(track[3].zp - track[2].zp).toBeCloseTo(56);
  });

  it('is deterministic: same input, same output', () => {
    expect(buildTrack(SAMPLE)).toEqual(buildTrack([...SAMPLE].reverse()));
  });

  it('weave alternates sides and offsets deterministically', () => {
    const track = buildTrack(SAMPLE);
    expect(track[0].side).toBe(-1); // card 0 sits left of center
    expect(track[1].side).toBe(1);
    expect(track[0].vy).toBe(-14); // i=0: −(14 + 0×4)
    expect(track[1].vy).toBe(18); // i=1: +(14 + 1×4)
    expect(track[5].vy).toBe(22); // i=5: +(14 + 2×4)
  });
});

describe('camera mapping', () => {
  it('parks 140 before card 0 and stops 80 past the last plane', () => {
    const track = buildTrack(SAMPLE);
    const { cStart, cEnd } = cameraRange(track);
    expect(cStart).toBeCloseTo(track[0].zp - 140);
    expect(cEnd).toBeCloseTo(track[track.length - 1].zp + 80);
  });

  it('round-trips scroll ↔ camera', () => {
    const { cStart } = cameraRange(buildTrack(SAMPLE));
    expect(cameraAt(cStart, scrollFor(cStart, 500))).toBeCloseTo(500);
  });

  it('gauge puck plots true p of the camera', () => {
    expect(pCam(0)).toBe(1);
    expect(pCam(1100)).toBe(0);
    expect(pCam(418)).toBeCloseTo(0.62);
    expect(pCam(-140)).toBe(1); // clamped above the top cap
  });
});

describe('depth cues (§1 table)', () => {
  it('holds the near plateau', () => {
    expect(depthCues(0)).toEqual({ opacity: 1, saturation: 1, contrast: 1 });
    expect(depthCues(140)).toEqual({ opacity: 1, saturation: 1, contrast: 1 });
  });
  it('reaches 0.30 / 0.55 / 0.80 at d = 700', () => {
    const c = depthCues(700);
    expect(c.opacity).toBeCloseTo(0.3);
    expect(c.saturation).toBeCloseTo(0.55);
    expect(c.contrast).toBeCloseTo(0.8);
  });
  it('floors opacity at 0.14 from d = 1000, held', () => {
    expect(depthCues(1000).opacity).toBeCloseTo(0.14);
    expect(depthCues(2000).opacity).toBeCloseTo(0.14);
    expect(depthCues(2000).saturation).toBeCloseTo(0.55);
  });
  it('reduced motion steepens the ramp but keeps the same endpoints', () => {
    expect(depthCues(420, true).opacity).toBeCloseTo(0.3);
    expect(depthCues(140, true).opacity).toBe(1);
    expect(depthCues(1000, true).opacity).toBeCloseTo(0.14);
  });
});

describe('scale and tiers', () => {
  it('s = 1 at focus, F/(F+d) elsewhere, capped 1.35 during the pass', () => {
    expect(scaleFor(0)).toBe(1);
    expect(scaleFor(260)).toBeCloseTo(0.5);
    expect(scaleFor(-100)).toBe(1.35); // 260/160 = 1.625 → capped
  });
  it('tier fades crossfade over 0.04-wide bands', () => {
    expect(tierFades(0.74).desc).toBe(1);
    expect(tierFades(0.7).desc).toBe(0);
    expect(tierFades(0.72).desc).toBeCloseTo(0.5);
    expect(tierFades(0.47).chip).toBe(1);
    expect(tierFades(0.43).chip).toBe(0);
  });
});

describe('the pass (§6)', () => {
  it('is identity at d ≥ 40', () => {
    expect(passState(40, -1)).toEqual({ tx: 0, rot: 0, alpha: 1 });
    expect(passState(500, -1)).toEqual({ tx: 0, rot: 0, alpha: 1 });
  });
  it('exits toward the weave side, full at d = −160', () => {
    const p = passState(-160, 1);
    expect(p.tx).toBeCloseTo(240);
    expect(p.rot).toBeCloseTo(5);
    expect(p.alpha).toBeCloseTo(0);
  });
  it('holds opacity until the final 60 units', () => {
    expect(passState(-100, -1).alpha).toBe(1);
    expect(passState(-130, -1).alpha).toBeCloseTo(0.5);
  });
  it('is visually clean at focus — the quadratic ramp keeps d=0 negligible', () => {
    expect(Math.abs(passState(0, 1).tx)).toBeLessThan(12);
    expect(Math.abs(passState(0, 1).rot)).toBeLessThan(0.5);
  });
  it('replays in reverse: pure function of d', () => {
    expect(passState(-80, 1)).toEqual(passState(-80, 1));
  });
});

describe('engagement and weave', () => {
  it('engaged card minimizes |d|', () => {
    const track = buildTrack(SAMPLE);
    expect(engagedIndex(track, track[0].zp)).toBe(0);
    expect(engagedIndex(track, track[4].zp + 10)).toBe(4);
  });
  it('lateral magnitude ramps 44 → 80 across the depth band', () => {
    expect(latMag(0)).toBe(44);
    expect(latMag(-50)).toBe(44); // never narrows behind focus
    expect(latMag(900)).toBe(80);
    expect(latMag(2000)).toBe(80);
  });
});

describe('gauge helpers', () => {
  it('shifts colliding dots into a second column, alternating', () => {
    expect(gaugeColumns([10, 13, 15, 40])).toEqual([0, 1, 0, 0]);
    expect(gaugeColumns([10, 20, 30])).toEqual([0, 0, 0]);
  });
  it('fans ledger rows to a minimum gap without reordering', () => {
    expect(fanRows([10, 12, 60])).toEqual([10, 32, 60]);
    expect(fanRows([10, 100])).toEqual([10, 100]);
  });
  it('band is a clamped linear ramp', () => {
    expect(band(5, 0, 10)).toBe(0.5);
    expect(band(-1, 0, 10)).toBe(0);
    expect(band(11, 0, 10)).toBe(1);
  });
});

describe('cubicBezier', () => {
  it('matches endpoints and monotone midpoints', () => {
    const ease = cubicBezier(0.2, 0.8, 0.2, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    const mid = ease(0.5);
    expect(mid).toBeGreaterThan(0.5); // strong ease-out
    expect(mid).toBeLessThan(1);
    let prev = 0;
    for (let x = 0; x <= 1.001; x += 0.05) {
      const y = ease(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = y;
    }
  });
});
