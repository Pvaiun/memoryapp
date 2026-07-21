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
export const DEPTH_RANGE = 3200; // p 0..1 → z 0..3200 — wide enough that real
// prominence cliffs render several times the spacing floor and are felt as travel;
// the floor doesn't scale with this, so widening it grows cliffs, never shelves
export const MIN_SPACING = 200; // pushdown floor between focal planes —
// similar prominences stretch to a readable step; real cliffs stay big.
// Sized so the reading-scale focus card clears the next approaching strip.
export const SCROLL_FACTOR = 1.02; // scrollTop → camera units
export const TOP_BEFORE = 320; // travel above card 0: the pulled-back overview
export const GAUGE_INSET = 12; // scale line sits 12px in from the gauge edge

// Corridor geometry, as fractions of viewport height.
export const VP_FRAC = 0.12; // vanishing line — high, so the approach uses the
// whole upper corridor instead of pooling mid-screen
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
// track hard-stops on the last focal plane — there is no travel past it.
export interface CameraRange {
  cStart: number;
  cEnd: number;
  maxScroll: number;
}

export function cameraRange(track: TrackCard[]): CameraRange {
  const cStart = track.length ? track[0].zp - TOP_BEFORE : 0;
  const cEnd = track.length ? track[track.length - 1].zp : 0;
  return { cStart, cEnd, maxScroll: Math.max(0, (cEnd - cStart) / SCROLL_FACTOR) };
}

export const cameraAt = (cStart: number, scrollTop: number) => cStart + scrollTop * SCROLL_FACTOR;
export const scrollFor = (cStart: number, c: number) => (c - cStart) / SCROLL_FACTOR;

// The gauge scale is fixed and true (linear in p, 1.0 at the top cap).
// The puck rides it via a piecewise map: on a card's focal plane it sits
// exactly on that card's true-p dot; between planes it sweeps at whatever
// rate the physical gap dictates. A big prominence cliff makes the puck
// fly across real scale distance; a crammed shelf makes it crawl — the
// display spacing floor is felt on the instrument without falsifying it.
export function puckP(track: TrackCard[], c: number): number {
  if (!track.length) return 1;
  const first = track[0];
  if (c <= first.zp) {
    // overview approach: top cap (1.0) → the first card's true p
    const t = band(c, first.zp - TOP_BEFORE, first.zp);
    return 1 - t * (1 - first.p);
  }
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (c <= b.zp) {
      const t = (c - a.zp) / (b.zp - a.zp);
      return a.p + t * (b.p - a.p);
    }
  }
  return track[track.length - 1].p;
}

// Minimal-separation layout for positions on the scale (gauge dots, ledger
// rows). Equal or near-equal values fan out symmetrically AROUND their true
// position — the cluster stays centered on the value it represents — and
// only a cluster that hits a scale end shifts, never the whole list.
// Classic 1-D constraint relaxation: greedily merge overlapping clusters,
// each laid out at `gap` around its (unclamped) centroid, clamped to
// [lo, hi] at the end. Deterministic; order-preserving.
export function spreadPositions(ys: number[], gap: number, lo = -Infinity, hi = Infinity): number[] {
  interface Group {
    sum: number; // of true centers
    n: number;
  }
  const groups: Group[] = [];
  const center = (g: Group) => g.sum / g.n;
  const start = (g: Group) => center(g) - ((g.n - 1) * gap) / 2;
  const end = (g: Group) => center(g) + ((g.n - 1) * gap) / 2;
  for (const y of ys) {
    groups.push({ sum: y, n: 1 });
    // merge while the newest group crowds its predecessor
    while (groups.length > 1) {
      const b = groups[groups.length - 1];
      const a = groups[groups.length - 2];
      if (start(b) - end(a) >= gap) break;
      groups.pop();
      groups.pop();
      groups.push({ sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  const out: number[] = [];
  for (const g of groups) {
    // clamp the whole group inside the scale, preferring the low end
    let s = start(g);
    if (end(g) > hi) s -= end(g) - hi;
    if (s < lo) s = lo;
    for (let i = 0; i < g.n; i++) out.push(s + i * gap);
  }
  return out;
}

// Puck y through the RESOLVED dot layout: on a card's focal plane the puck
// sits exactly on that card's (possibly spread) dot; between planes it
// interpolates at the rate the physical gap dictates; above the first card
// it eases down from the top cap. `ys` must be resolved dot positions in
// track order; `topY` is the scale's p=1.0 cap.
export function puckYAt(track: TrackCard[], c: number, ys: number[], topY: number): number {
  if (!track.length || !ys.length) return topY;
  const first = track[0];
  if (c <= first.zp) {
    const t = band(c, first.zp - TOP_BEFORE, first.zp);
    return topY + t * (ys[0] - topY);
  }
  for (let i = 0; i < track.length - 1; i++) {
    if (c <= track[i + 1].zp) {
      const t = (c - track[i].zp) / (track[i + 1].zp - track[i].zp);
      return ys[i] + t * (ys[i + 1] - ys[i]);
    }
  }
  return ys[ys.length - 1];
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

// Card anatomy never changes with depth: one card, whole thing fades as
// one — no lite vs full version. (Depth is carried by scale, position,
// and the card-level cue table alone.)

// Directional settle: scrolling commits. Once the camera has moved more
// than the hysteresis past a rest in its direction of travel, settling
// resolves FORWARD in that direction — it never snaps back against the
// way you scrolled. A small drift (≤ hysteresis) still returns.
// `rests` must be ascending, in camera units.
export function settleTarget(rests: number[], c: number, dir: 1 | -1, hysteresis = 30): number {
  if (!rests.length) return c;
  if (dir >= 0) {
    for (const r of rests) if (r > c - hysteresis) return r;
    return rests[rests.length - 1];
  }
  for (let i = rests.length - 1; i >= 0; i--) if (rests[i] < c + hysteresis) return rests[i];
  return rests[0];
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
