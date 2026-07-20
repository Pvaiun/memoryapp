import { describe, expect, it } from 'vitest';
import {
  band,
  buildTrack,
  cameraAt,
  cameraRange,
  corridorY,
  cubicBezier,
  CULL_BEHIND,
  depthCues,
  descFade,
  engagedIndex,
  fanRows,
  FOCUS_FRAC,
  MIN_SPACING,
  passState,
  scaleFor,
  scrollFor,
  trackNorm,
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

  it('keeps gaps larger than the floor (the 0.95 → 0.66 cliff renders bigger)', () => {
    const track = buildTrack(SAMPLE);
    expect(track[0].zp).toBeCloseTo(0.05 * 1100); // 55
    expect(track[1].zp).toBeCloseTo(0.34 * 1100); // 374 — gap 319 > 150, untouched
  });

  it('stretches close prominences to the readable spacing floor, monotonically', () => {
    const track = buildTrack(SAMPLE);
    for (let i = 1; i < track.length; i++) {
      expect(track[i].zp - track[i - 1].zp).toBeGreaterThanOrEqual(MIN_SPACING - 1e-9);
      // never pulled forward of true depth
      expect(track[i].zp).toBeGreaterThanOrEqual((1 - track[i].p) * 1100 - 1e-9);
    }
    // 0.58 → 0.55 is a 33-unit true gap: inflates to exactly the floor
    expect(track[3].zp - track[2].zp).toBeCloseTo(MIN_SPACING);
  });

  it('is deterministic: same input, same output', () => {
    expect(buildTrack(SAMPLE)).toEqual(buildTrack([...SAMPLE].reverse()));
  });
});

describe('camera mapping', () => {
  it('travels beyond both ends: overview above card 0, empty rest past the last', () => {
    const track = buildTrack(SAMPLE);
    const { cStart, cEnd } = cameraRange(track);
    expect(cStart).toBeCloseTo(track[0].zp - 320);
    expect(cEnd).toBeCloseTo(track[track.length - 1].zp + 300);
  });

  it('round-trips scroll ↔ camera', () => {
    const { cStart } = cameraRange(buildTrack(SAMPLE));
    expect(cameraAt(cStart, scrollFor(cStart, 500))).toBeCloseTo(500);
  });

  it('trackNorm maps the display track 0 → 1, clamped at the ends', () => {
    const track = buildTrack(SAMPLE);
    expect(trackNorm(track, track[0].zp)).toBe(0);
    expect(trackNorm(track, track[track.length - 1].zp)).toBe(1);
    expect(trackNorm(track, track[0].zp - 500)).toBe(0);
    const mid = trackNorm(track, track[5].zp);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe('corridor projection', () => {
  it('puts the focal plane at FOCUS_FRAC and recedes toward the vanishing line', () => {
    const vh = 800;
    expect(corridorY(1, vh)).toBeCloseTo(FOCUS_FRAC * vh);
    expect(corridorY(0, vh)).toBeCloseTo(VP_FRAC * vh);
    // monotone: bigger scale → lower on screen
    expect(corridorY(0.7, vh)).toBeGreaterThan(corridorY(0.4, vh));
  });

  it('scale is 1 at focus and grows past it, capped', () => {
    expect(scaleFor(0)).toBe(1);
    expect(scaleFor(380)).toBeCloseTo(0.5);
    expect(scaleFor(-300)).toBe(2.4); // capped during the pass
  });
});

describe('depth cues', () => {
  it('holds the near plateau and ramps to the mid floor', () => {
    expect(depthCues(0)).toEqual({ opacity: 1, saturation: 1, contrast: 1 });
    expect(depthCues(100)).toEqual({ opacity: 1, saturation: 1, contrast: 1 });
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
    expect(depthCues(1000, true).opacity).toBeCloseTo(0.15);
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
  it('holds opacity through most of the exit', () => {
    expect(passState(-100).alpha).toBe(1);
    expect(passState(-180).alpha).toBeCloseTo(0.5);
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

describe('anatomy and engagement', () => {
  it('description fades by scale; nothing else ever collapses', () => {
    expect(descFade(0.7)).toBe(1);
    expect(descFade(0.6)).toBe(0);
    expect(descFade(0.65)).toBeCloseTo(0.5);
  });
  it('engaged card minimizes |d|', () => {
    const track = buildTrack(SAMPLE);
    expect(engagedIndex(track, track[0].zp)).toBe(0);
    expect(engagedIndex(track, track[4].zp + 10)).toBe(4);
  });
});

describe('ledger helpers', () => {
  it('fans rows to a minimum gap without reordering', () => {
    expect(fanRows([10, 12, 80], 26)).toEqual([10, 36, 80]);
    expect(fanRows([10, 100], 26)).toEqual([10, 100]);
  });
  it('band is a clamped linear ramp', () => {
    expect(band(5, 0, 10)).toBe(0.5);
    expect(band(-1, 0, 10)).toBe(0);
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
