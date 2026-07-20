// Descent "Instrument" — pure render math, v2 (vertical corridor).
// Everything here is a deterministic function of (bubbles, scrollTop):
// same data in → same pixels out. The React/DOM layer consumes these
// per frame; nothing in this module touches the DOM.
//
// v2 model (product feedback 2026-07-20): cards are horizontally centered
// in a tilt-shift corridor. Depth recedes upward — deep cards sit small
// near a vanishing line in the upper third, descend and grow as they
// approach, reach focus in the lower-middle, then sweep down off the
// bottom edge as they pass. No lateral weave, no side exits.

export const F = 380; // perspective focal constant — gentler falloff for readability
export const DEPTH_RANGE = 1100; // p 0..1 → z 0..1100
export const MIN_SPACING = 150; // pushdown floor between focal planes —
// similar prominences stretch into an even, readable rhythm; real cliffs
// still render proportionally bigger
export const SCROLL_FACTOR = 1.02; // scrollTop → camera units
export const TOP_BEFORE = 320; // travel above card 0: the pulled-back overview
export const BOTTOM_AFTER = 300; // travel past the last card: the empty "end of today" rest
export const GAUGE_INSET = 12; // scale line sits at W − 12

// Corridor geometry, as fractions of viewport height.
export const VP_FRAC = 0.24; // vanishing line
export const FOCUS_FRAC = 0.62; // focal plane — card center at focus

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// 0 at lo, 1 at hi, linear between.
export const band = (v: number, lo: number, hi: number) => clamp((v - lo) / (hi - lo), 0, 1);

export interface TrackCard {
  id: string;
  i: number; // prominence rank, 0 = loudest
  p: number; // true prominence (kept for the rebuild story / data)
  zp: number; // z′ — pushed-down depth, the only depth used visually
}

// Sort by p desc (ties by id — stable, deterministic), raw depth, then
// monotonic pushdown to the spacing floor.
export function buildTrack(bubbles: { id: string; prominence: number }[]): TrackCard[] {
  const sorted = [...bubbles].sort(
    (a, b) => b.prominence - a.prominence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const out: TrackCard[] = [];
  let prev = 0;
  sorted.forEach((b, i) => {
    const z = (1 - b.prominence) * DEPTH_RANGE;
    const zp = i === 0 ? z : Math.max(z, prev + MIN_SPACING);
    prev = zp;
    out.push({ id: b.id, i, p: b.prominence, zp });
  });
  return out;
}

// Camera ↔ scroll mapping. scrollTop 0 is the pulled-back overview; the
// far end rests past the last focal plane (the day fully descended).
export interface CameraRange {
  cStart: number;
  cEnd: number;
  maxScroll: number;
}

export function cameraRange(track: TrackCard[]): CameraRange {
  const cStart = track.length ? track[0].zp - TOP_BEFORE : 0;
  const cEnd = track.length ? track[track.length - 1].zp + BOTTOM_AFTER : 0;
  return { cStart, cEnd, maxScroll: Math.max(0, (cEnd - cStart) / SCROLL_FACTOR) };
}

export const cameraAt = (cStart: number, scrollTop: number) => cStart + scrollTop * SCROLL_FACTOR;
export const scrollFor = (cStart: number, c: number) => (c - cStart) / SCROLL_FACTOR;

// The gauge plots the display track: 0 at the loudest card, 1 at the
// quietest, so dots match the travel between cards exactly.
export function trackNorm(track: TrackCard[], zp: number): number {
  if (track.length < 2) return 0;
  const lo = track[0].zp;
  const hi = track[track.length - 1].zp;
  return clamp((zp - lo) / (hi - lo), 0, 1);
}

// Perspective scale. Grows past focus (the card sweeping under the
// camera); capped so the exit never explodes.
export const scaleFor = (d: number) => Math.min(F / (F + d), 2.4);

// Corridor projection: screen-y of a card's center for scale s, in px,
// given the viewport height. Pure ground-plane perspective — position and
// scale stay physically coupled.
export function corridorY(s: number, vh: number): number {
  const vp = VP_FRAC * vh;
  return vp + (FOCUS_FRAC * vh - vp) * s;
}

// Depth-cue table (opacity / desaturation / contrast by distance ahead).
// Reduced motion steepens the gradients so cards resolve over shorter travel.
export interface DepthCues {
  opacity: number;
  saturation: number;
  contrast: number;
}

export function depthCues(d: number, reduced = false): DepthCues {
  const rampStart = 100;
  const rampEnd = reduced ? 420 : 650;
  const floorAt = reduced ? 620 : 1000;
  let opacity: number;
  if (d <= rampStart) opacity = 1;
  else if (d <= rampEnd) opacity = 1 - band(d, rampStart, rampEnd) * 0.68; // → 0.32
  else opacity = 0.32 - band(d, rampEnd, floorAt) * 0.17; // → floor 0.15, held
  const t = band(d, rampStart, rampEnd);
  return { opacity, saturation: 1 - t * 0.45, contrast: 1 - t * 0.2 };
}

// The pass: mechanical exit straight down as d runs 0 → −220. Pure
// function of d, so scrolling up replays it exactly in reverse.
// `drop` is 0..1 of the extra downward travel (the view scales it to px);
// opacity holds until the final stretch.
export interface PassState {
  drop: number;
  alpha: number;
}

export function passState(d: number): PassState {
  if (d >= 0) return { drop: 0, alpha: 1 };
  const t = band(-d, 0, 200);
  return {
    drop: Math.pow(t, 1.35),
    alpha: 1 - band(-d, 140, 220),
  };
}

export const CULL_BEHIND = -220; // pass complete → card culled

// Card anatomy never collapses (at-a-glance rule: chip, name, count are
// always present); only the description fades out with distance.
export const descFade = (s: number) => band(s, 0.6, 0.7);

// Ledger fanning: rows closer than the gap push down, monotonic.
export function fanRows(ys: number[], minGap = 26, maxY = Infinity): number[] {
  const out: number[] = [];
  let prev = -Infinity;
  for (const y of ys) {
    const fy = Math.max(y, prev + minGap);
    prev = fy;
    out.push(fy);
  }
  // If the fan ran past the bottom, shift everything up uniformly.
  const over = out.length ? out[out.length - 1] - maxY : 0;
  if (over > 0) for (let i = 0; i < out.length; i++) out[i] -= over;
  return out;
}

// The engaged card minimizes |d|.
export function engagedIndex(track: TrackCard[], c: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (const t of track) {
    const dist = Math.abs(t.zp - c);
    if (dist < bestDist) {
      bestDist = dist;
      best = t.i;
    }
  }
  return best;
}

// cubic-bezier(x1, y1, x2, y2) evaluator for the JS-driven snap/dolly
// animations. Newton + bisection fallback.
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-5) return sampleY(t);
      const dx = sampleDX(t);
      if (Math.abs(dx) < 1e-6) break;
      t -= err / dx;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    while (hi - lo > 1e-5) {
      if (sampleX(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

export const easeSnap = cubicBezier(0.2, 0.8, 0.2, 1); // snap assist / ledger
export const easeDolly = cubicBezier(0.45, 0, 0.15, 1); // gauge-tap dolly
