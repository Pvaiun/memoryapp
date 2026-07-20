// Descent "Instrument" — pure render math (spec §0, §1, §2, §3, §6).
// Everything here is a deterministic function of (bubbles, scrollTop):
// same data in → same pixels out. The React/DOM layer consumes these
// per frame; nothing in this module touches the DOM.

export const F = 260; // perspective focal constant (§0 step 6)
export const DEPTH_RANGE = 1100; // p 0..1 → z 0..1100 (§0 step 2)
export const MIN_SPACING = 56; // pushdown floor between focal planes (§3a)
export const SCROLL_FACTOR = 1.02; // scrollTop → camera units (§0 step 4)
export const PARK_BEFORE = 140; // camera parks this far before card 0 (§6)
export const BOTTOM_AFTER = 80; // hard stop past the last focal plane (§6)
export const GAUGE_INSET = 12; // scale line sits at W − 12 (§4)

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// 0 at lo, 1 at hi, linear between.
export const band = (v: number, lo: number, hi: number) => clamp((v - lo) / (hi - lo), 0, 1);

export interface TrackCard {
  id: string;
  i: number; // prominence rank, 0 = loudest — drives weave (§0a)
  p: number; // true prominence; the gauge plots this, never z′ (§4)
  zp: number; // z′ — pushed-down depth, the only depth used visually (§0 step 3)
  side: -1 | 1; // weave side (§0a)
  vy: number; // deterministic vertical offset, screen px (§0a)
}

// §0 steps 1–3: sort by p desc (ties by id — stable, deterministic),
// raw depth, then monotonic pushdown to the 56-unit floor.
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
    out.push({
      id: b.id,
      i,
      p: b.prominence,
      zp,
      side: i % 2 === 0 ? -1 : 1,
      vy: (i % 2 === 0 ? -1 : 1) * (14 + (i % 3) * 4),
    });
  });
  return out;
}

// Camera ↔ scroll mapping. scrollTop 0 is the parked position (§6);
// the far end hard-stops past the last focal plane.
export interface CameraRange {
  cStart: number;
  cEnd: number;
  maxScroll: number;
}

export function cameraRange(track: TrackCard[]): CameraRange {
  const cStart = track.length ? track[0].zp - PARK_BEFORE : 0;
  const cEnd = track.length ? track[track.length - 1].zp + BOTTOM_AFTER : 0;
  return { cStart, cEnd, maxScroll: Math.max(0, (cEnd - cStart) / SCROLL_FACTOR) };
}

export const cameraAt = (cStart: number, scrollTop: number) => cStart + scrollTop * SCROLL_FACTOR;
export const scrollFor = (cStart: number, c: number) => (c - cStart) / SCROLL_FACTOR;
// The gauge plots camera position in true-p space (§4).
export const pCam = (c: number) => clamp(1 - c / DEPTH_RANGE, 0, 1);

// §0 step 6, with the pass cap from §6.
export const scaleFor = (d: number) => Math.min(F / (F + d), 1.35);

// §1 depth-cue table. Reduced motion steepens the gradients so cards
// resolve over shorter travel (§8).
export interface DepthCues {
  opacity: number;
  saturation: number;
  contrast: number;
}

export function depthCues(d: number, reduced = false): DepthCues {
  const rampEnd = reduced ? 420 : 700;
  const floorAt = reduced ? 620 : 1000;
  let opacity: number;
  if (d <= 140) opacity = 1;
  else if (d <= rampEnd) opacity = 1 - band(d, 140, rampEnd) * 0.7; // → 0.30
  else opacity = 0.3 - band(d, rampEnd, floorAt) * 0.16; // → floor 0.14, held
  const t = band(d, 140, rampEnd);
  return { opacity, saturation: 1 - t * 0.45, contrast: 1 - t * 0.2 };
}

// §0a lateral weave: 44px near, spreading to 80px deep, screen space.
export const latMag = (d: number) => 44 + 36 * clamp(d / 900, 0, 1);

// §6 the pass: mechanical exit as d runs 40 → −160. Pure function of d,
// so scrolling up replays it exactly in reverse. The ramp is quadratic:
// a linear ramp over the spec's window would already displace the card
// ±48px / 1° at focus (d = 0); squaring keeps the engaged card visually
// clean (±9.6px absorbed into the weave) while the exit stays decisive.
export interface PassState {
  tx: number;
  rot: number;
  alpha: number;
}

export function passState(d: number, side: number): PassState {
  if (d >= 40) return { tx: 0, rot: 0, alpha: 1 };
  const t = clamp((40 - d) / 200, 0, 1);
  const e = t * t;
  return {
    tx: side * 240 * e,
    rot: side * 5 * e,
    alpha: d >= -100 ? 1 : band(d, -160, -100), // fade over the final 60 units
  };
}

export const CULL_BEHIND = -160; // pass complete → card culled (§0 step 6)

// §2 tier crossfades, each over a 0.04-wide s band centred on the boundary.
export interface TierFades {
  desc: number; // 1 at Focus, 0 below
  chip: number; // 1 at Focus/Mid (full chip), 0 at Far (dot instead)
}

export const tierFades = (s: number): TierFades => ({
  desc: band(s, 0.7, 0.74),
  chip: band(s, 0.43, 0.47),
});

export const FAR_TIER_S = 0.45; // below this: not tappable (§2)

// §0 step 7: the engaged card minimizes |d|.
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

// Gauge-side dot collision (§3b): dots closer than 6px on the scale shift
// into a second column 5px left, tied to true position by a hairline.
// Input ys must be in track order (p desc → y ascending).
export function gaugeColumns(ys: number[]): number[] {
  const cols: number[] = [];
  for (let i = 0; i < ys.length; i++) {
    const prevClose = i > 0 && ys[i] - ys[i - 1] < 6;
    cols.push(prevClose && cols[i - 1] === 0 ? 1 : 0);
  }
  return cols;
}

// Ledger fanning (§5): rows closer than 22px push down, keeping a hairline
// tie to their true-p y. Same monotonic pushdown shape as §3a.
export function fanRows(ys: number[], minGap = 22, maxY = Infinity): number[] {
  const out: number[] = [];
  let prev = -Infinity;
  for (const y of ys) {
    const fy = Math.max(y, prev + minGap);
    prev = fy;
    out.push(fy);
  }
  // If the fan ran past the bottom, shift everything up uniformly (12 rows
  // × 22px = 264px, far under any real viewport, so this is a safety net).
  const over = out.length ? out[out.length - 1] - maxY : 0;
  if (over > 0) for (let i = 0; i < out.length; i++) out[i] -= over;
  return out;
}

// cubic-bezier(x1, y1, x2, y2) evaluator for the spec's easing curves,
// used by the JS-driven snap/dolly animations. Newton + bisection fallback.
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

export const easeSnap = cubicBezier(0.2, 0.8, 0.2, 1); // snap assist / ledger (§8)
export const easeDolly = cubicBezier(0.45, 0, 0.15, 1); // gauge-tap dolly (§8)
