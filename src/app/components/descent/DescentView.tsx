import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import type { Bubble, ItemView } from '../../../shared/types';
import { CAPTURED_BUBBLE_ID } from '../../../shared/types';
import {
  anchorThemeName,
  deriveConstruction,
  deriveDeadlineNotch,
  deriveSpanRail,
  farTokens,
  parseSentence,
  withMemberChips,
} from '../../../shared/cards';
import type { CardConstruction, CardSegment, DeadlineNotchBrick, SpanRailBrick } from '../../../shared/cards';
import { eventPassed, isDoneForNow, nextAtTimeOccurrence } from '../../../shared/cadence';
import { themeColor, tzOffsetMinutes } from '../../api';
import { bubbleCounts, bubbleStatus } from '../bubbleStatus';
import type { BubbleStatus } from '../bubbleStatus';
import {
  band,
  buildTrack,
  cameraAt,
  cameraRange,
  clamp,
  corridorY,
  CULL_BEHIND,
  depthCues,
  easeDolly,
  easeSnap,
  engagedIndex,
  GAUGE_INSET,
  passState,
  puckP,
  puckYAt,
  scaleFor,
  scrollFor,
  settleTarget,
  spreadPositions,
  TOP_BEFORE,
} from './engine';
import type { TrackCard } from './engine';

// Descent "Instrument", v3 — the vertical corridor with a true-scale gauge.
// React renders the scene structure once per data change; a rAF loop writes
// transforms/opacity/filter straight to the DOM as a pure function of
// scrollTop, so scrolling never touches React. Scrolling is a native scroll
// container; settling is our own directional snap: once you've moved past a
// small hysteresis, rest always resolves FORWARD in the direction you
// scrolled, never back.
//
// Spatially: cards are horizontally centered. Depth recedes upward — deep
// cards hang small near a vanishing line in the upper third, descend and
// grow as the camera approaches, reach focus in the lower-middle, then
// sweep down off the bottom edge as they pass. The card is one thing at
// every depth — same anatomy, fading as a whole.
//
// The gauge lives on the LEFT edge (with the ledger). Its scale is fixed
// and true — linear in prominence — while the puck rides it via the
// physical map (engine.puckP): cliffs make it fly, crammed shelves make
// it crawl. The ledger opens over it with room for full names.

const CARD_W = 288; // focus-tier card width — fully on-screen at 390, clear of the gauge lane
const GAUGE_PAD = 14; // px above/below the scale ends
const GAUGE_HIT = 24;
const PASS_DROP_FRAC = 0.62; // extra downward travel during the pass, × vh
const SETTLE_HYST = 30; // camera units of drift that still return backward

const STORAGE_KEY = 'memory.descent.prev';
// Settle-sink glide at fallSpeed 1.0; the setting scales it (dur = BASE /
// speed), clamped so extremes stay legible and never instant.
const BASE_FALL_MS = 900;
const FALL_MS_MIN = 150;
const FALL_MS_MAX = 4000;
// Focus owns the viewport (§6): anything deeper than half a spacing step has
// already collapsed to its far form — rim color plus cropped bold tokens.
// FAR_END stays under the spacing floor (engine MIN_SPACING) so a card at
// the very next rest position is fully far — no double-exposure at rest.
const FAR_START = 55; // d where the full body starts giving way
const FAR_END = 130; // d where only the far strip remains
// … and the horizon swallows the rest: only a few peeking edges stay legible.
const HORIZON_START = 650;
const HORIZON_END = 1500;

interface CardEls {
  root: HTMLButtonElement;
  near: HTMLElement; // full body + ledge — fades and desaturates with depth
  rim: HTMLElement; // theme accent spine — full saturation, opacity floor
  far: HTMLElement; // cropped bold-token strip — the card's deep form
}

interface CardInfo {
  bubble: Bubble;
  status: BubbleStatus;
  doneCount: number;
  total: number;
  settled: boolean;
  settledWord: 'done' | 'passed';
  members: ItemView[];
  construction: CardConstruction;
  segments: CardSegment[];
  far: string;
  accent: string;
  rail: SpanRailBrick | null;
  notch: DeadlineNotchBrick | null;
}

interface Ripple {
  key: number;
  y: number;
  color: string;
}

let rippleSeq = 1;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

export default function DescentView({
  bubbles,
  items,
  day,
  builtAt,
  capturedSpawnNonce,
  attentionId,
  fallSpeed = 1,
  onOpen,
  onToggleComplete,
  onAddFirstStep,
}: {
  bubbles: Bubble[];
  items: Record<string, ItemView>;
  day: string;
  builtAt: string | null;
  // bumps when a capture lands in the Captured Today bubble — the corridor
  // dollies up to it so the new chip is seen arriving
  capturedSpawnNonce?: number;
  // the bubble whose sheet is open — the user's attention, for the settle
  // follow even when the camera's engaged card has drifted elsewhere
  attentionId?: string | null;
  // settle-sink speed multiplier (Settings): 1 = design default, higher is
  // snappier, lower is a slow glide
  fallSpeed?: number;
  onOpen: (bubble: Bubble) => void;
  onToggleComplete: (item: ItemView) => void;
  onAddFirstStep?: (bubbleId: string, title: string) => void;
}) {
  const reduced = usePrefersReducedMotion();
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const puckRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const leaderRef = useRef<SVGLineElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [ripples, setRipples] = useState<Ripple[]>([]);

  // ----- derived scene ---------------------------------------------------
  const infos = useMemo(() => {
    const nowMs = Date.now();
    const m = new Map<string, CardInfo>();
    for (const b of bubbles) {
      const status = bubbleStatus(b, items);
      const { doneCount, total, allDone } = bubbleCounts(b, items, nowMs);
      const members = b.itemIds.map((id) => items[id]).filter(Boolean);
      const construction = deriveConstruction(members, b.firstStep);
      // Older maps have no sentence; the plain reason parses to one text run.
      const parsed = parseSentence(b.sentence || b.reason);
      // Chip guarantee: member DOs the prose forgot to chip append as bare
      // chips (rotation stays chip-free). The far form crops the prose alone —
      // appended chips would duplicate its tokens.
      const segments = b.kind === 'rotation' ? parsed : withMemberChips(parsed, members);
      const tokens = farTokens(parsed);
      const themeName = anchorThemeName(members);
      m.set(b.id, {
        bubble: b,
        status,
        doneCount,
        total,
        settled: allDone,
        // A bubble that settled purely by the clock reads "passed", one the
        // user actually worked reads "done".
        settledWord:
          allDone && members.length > 0 && members.every((x) => !isDoneForNow(x) && eventPassed(x, nowMs))
            ? 'passed'
            : 'done',
        members,
        construction,
        segments,
        far: (tokens.length ? tokens : [b.name]).join(' · '),
        accent: themeName ? themeColor(themeName) : 'hsl(222 15% 52%)',
        rail: deriveSpanRail(members, nowMs),
        notch: deriveDeadlineNotch(members, nowMs),
      });
    }
    return m;
  }, [bubbles, items]);
  // Resolution is depth (user decision): a settled bubble gives up its Brain
  // prominence and rests at p 0 — the bottom of the gauge, the deep end of
  // the corridor — instead of holding its slot in the day all afternoon.
  const track = useMemo(
    () => buildTrack(bubbles.map((b) => (infos.get(b.id)?.settled ? { id: b.id, prominence: 0 } : b))),
    [bubbles, infos],
  );
  const range = useMemo(() => cameraRange(track), [track]);
  const byTrack = useMemo(
    () => track.map((t) => ({ t, info: infos.get(t.id)! })).filter((x) => x.info),
    [track, infos],
  );

  const urgentCount = useMemo(
    () => byTrack.filter((x) => x.info.status.tone === 'red' && !x.info.settled).length,
    [byTrack],
  );

  const vw = size.w;
  const vh = size.h;
  // corridor center: shifted right of true center to clear the left gauge
  const cx = (vw + 28) / 2;

  // gauge scale: fixed, linear in true prominence
  const yForP = useCallback((p: number) => GAUGE_PAD + (1 - p) * (vh - 2 * GAUGE_PAD), [vh]);
  const pForY = useCallback(
    (y: number) => clamp(1 - (y - GAUGE_PAD) / (vh - 2 * GAUGE_PAD), 0, 1),
    [vh],
  );

  // ----- imperative registries -------------------------------------------
  const cardElsRef = useRef(new Map<string, CardEls>());
  const dotElsRef = useRef(new Map<string, HTMLElement>());
  // settle-sink animations: id → glide start; the target is always the
  // card's CURRENT track plane, so mid-flight reflows stay drift-corrected
  const zpAnimsRef = useRef(new Map<string, { from: number; t0: number; dur: number }>());
  const dotSlidePendingRef = useRef(false);
  // the bubble the user just acted on (checked a chip), with a timestamp —
  // the settle-follow anchor that survives the async completion round-trip
  const actedRef = useRef<{ id: string; at: number } | null>(null);
  const engagedIdRef = useRef<string | null>(null);
  const lastActivityRef = useRef(0);
  const gaugeActiveUntilRef = useRef(0);
  const gaugeActiveOnRef = useRef(false);
  const loopRef = useRef(0);
  const lastCRef = useRef(NaN);
  const dollyRef = useRef<number | null>(null);
  const userScrolledRef = useRef(false);
  // directional-settle state
  const lastStRef = useRef(0);
  const dirRef = useRef<1 | -1>(1);
  const stillFramesRef = useRef(0);
  const touchActiveRef = useRef(false);
  const lastWheelRef = useRef(0);

  const trackRef = useRef(track);
  trackRef.current = track;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const attentionIdRef = useRef(attentionId ?? null);
  attentionIdRef.current = attentionId ?? null;
  // Live fall duration (ms), read at the moment a bubble settles.
  const fallMsRef = useRef(BASE_FALL_MS);
  fallMsRef.current = clamp(Math.round(BASE_FALL_MS / (fallSpeed || 1)), FALL_MS_MIN, FALL_MS_MAX);
  const infosRef = useRef(infos);
  infosRef.current = infos;
  // rest positions for directional settle, in camera units, ascending:
  // the overview, then every focal plane (the last plane is the bottom stop)
  const restsRef = useRef<number[]>([]);
  restsRef.current = useMemo(
    () => (track.length ? [range.cStart, ...track.map((t) => t.zp)] : []),
    [track, range],
  );

  const attachCard = useCallback((id: string) => {
    return (el: HTMLButtonElement | null) => {
      if (!el) {
        cardElsRef.current.delete(id);
        return;
      }
      cardElsRef.current.set(id, {
        root: el,
        near: el.querySelector<HTMLElement>('.dsc-near')!,
        rim: el.querySelector<HTMLElement>('.dsc-rim')!,
        far: el.querySelector<HTMLElement>('.dsc-far')!,
      });
    };
  }, []);

  const attachDot = useCallback((id: string) => {
    return (el: HTMLDivElement | null) => {
      if (el) dotElsRef.current.set(id, el);
      else dotElsRef.current.delete(id);
    };
  }, []);

  // ----- dolly (programmatic camera moves) --------------------------------
  const cancelDolly = useCallback(() => {
    if (dollyRef.current !== null) {
      cancelAnimationFrame(dollyRef.current);
      dollyRef.current = null;
    }
  }, []);

  const markActivity = useCallback(() => {
    lastActivityRef.current = performance.now();
    startLoopRef.current();
  }, []);

  const dollyTo = useCallback(
    (targetScroll: number, duration: number, ease: (x: number) => number) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      cancelDolly();
      const target = clamp(targetScroll, 0, rangeRef.current.maxScroll);
      markActivity();
      if (reducedRef.current || duration <= 0) {
        scroller.scrollTop = target;
        return;
      }
      const from = scroller.scrollTop;
      const t0 = performance.now();
      const step = (now: number) => {
        const x = clamp((now - t0) / duration, 0, 1);
        scroller.scrollTop = from + (target - from) * ease(x);
        gaugeActiveUntilRef.current = now + 800;
        markActivity();
        if (x < 1) {
          dollyRef.current = requestAnimationFrame(step);
        } else {
          dollyRef.current = null;
          scroller.scrollTop = target;
        }
      };
      dollyRef.current = requestAnimationFrame(step);
    },
    [cancelDolly, markActivity],
  );

  const scrollForPlane = useCallback((zp: number) => scrollFor(rangeRef.current.cStart, zp), []);

  // ----- the frame loop ---------------------------------------------------
  const renderFrame = useCallback(
    (now: number): boolean => {
      const scroller = scrollerRef.current;
      const tr = trackRef.current;
      const { w, h } = sizeRef.current;
      if (!scroller || !tr.length || !h) return false;
      const rg = rangeRef.current;
      const isReduced = reducedRef.current;
      const st = scroller.scrollTop;
      const c = cameraAt(rg.cStart, st);
      const cardCx = (w + 28) / 2;
      const engaged = engagedIndex(tr, c);
      const engagedCard = tr[engaged];
      engagedIdRef.current = engagedCard ? engagedCard.id : null;

      let unsettled = Math.abs(c - lastCRef.current) > 0.01;
      lastCRef.current = c;

      // ----- directional settle: rest always resolves forward -----
      const delta = st - lastStRef.current;
      lastStRef.current = st;
      if (Math.abs(delta) > 0.5) dirRef.current = delta > 0 ? 1 : -1;
      const interacting = touchActiveRef.current || dollyRef.current !== null;
      if (interacting || Math.abs(delta) > 0.25) stillFramesRef.current = 0;
      else stillFramesRef.current++;
      if (
        stillFramesRef.current >= 4 &&
        userScrolledRef.current &&
        now - lastWheelRef.current > 150 &&
        !interacting
      ) {
        const target = settleTarget(restsRef.current, c, dirRef.current, SETTLE_HYST);
        const targetScroll = scrollFor(rg.cStart, target);
        if (Math.abs(targetScroll - st) > 1.5) dollyToRef.current(targetScroll, 180, easeSnap);
      }

      // a card mid-sink renders at its animated plane, easing into t.zp
      const zpOf = (t: TrackCard): number => {
        const anim = zpAnimsRef.current.get(t.id);
        if (!anim) return t.zp;
        const x = clamp((now - anim.t0) / anim.dur, 0, 1);
        if (x >= 1) {
          zpAnimsRef.current.delete(t.id);
          return t.zp;
        }
        unsettled = true;
        return t.zp + (anim.from - t.zp) * (1 - easeDolly(x));
      };

      for (const t of tr) {
        const els = cardElsRef.current.get(t.id);
        if (!els) continue;
        const info = infosRef.current.get(t.id);
        const d = zpOf(t) - c;

        if (d <= CULL_BEHIND) {
          if (els.root.style.visibility !== 'hidden') {
            els.root.style.visibility = 'hidden';
            els.root.style.pointerEvents = 'none';
          }
          continue;
        }
        if (els.root.style.visibility === 'hidden') els.root.style.visibility = '';

        const s = scaleFor(d);
        const cues = depthCues(d, isReduced);
        const pass = passState(d);
        const y = corridorY(s, h) + pass.drop * PASS_DROP_FRAC * h;

        const settledMul = info?.settled ? 0.7 : 1;
        const sat = (info?.settled ? 0.8 : 1) * cues.saturation;
        // The dolly is the disclosure (§6): ahead of focus the full body
        // cross-fades into the far strip — rim + cropped bold tokens. The
        // pass (d < 0) keeps the full form, exiting large under its ✓.
        const farT = band(d, FAR_START, FAR_END);

        els.root.style.transform = `translate(-50%, -50%) translate3d(0, ${y.toFixed(2)}px, 0) scale(${s.toFixed(4)})`;
        els.root.style.opacity = pass.alpha.toFixed(3);
        els.root.style.pointerEvents = pass.alpha > 0.05 ? '' : 'none';
        els.near.style.opacity = (cues.opacity * settledMul * (1 - farT)).toFixed(3);
        els.near.style.filter = `saturate(${sat.toFixed(3)}) contrast(${cues.contrast.toFixed(3)})`;
        // chips only act at focus; a deep card's tap is "bring me there"
        els.near.style.pointerEvents = farT > 0.3 ? 'none' : '';
        const horizon = 1 - band(d, HORIZON_START, HORIZON_END);
        els.far.style.opacity = (farT * Math.max(cues.opacity, 0.55) * horizon).toFixed(3);
        // Theme pigment is exempt from depth cues (§5): full saturation with
        // an opacity floor — but the rim belongs to the near form; at depth
        // the far strip's own accent edge takes over as the rim color.
        els.rim.style.opacity = (Math.max(cues.opacity, 0.85) * (1 - farT)).toFixed(3);
      }

      // ----- gauge: true scale, physical cursor -----
      // The puck rides the RESOLVED dot layout, so it lands exactly on a
      // card's dot even when equal prominences fanned the cluster apart;
      // the readout still reports interpolated true p.
      const p = puckP(tr, c);
      const puckY = puckYAt(tr, c, dotYsRef.current, GAUGE_PAD);
      if (puckRef.current) puckRef.current.style.transform = `translateY(${puckY.toFixed(1)}px)`;
      if (readoutRef.current) {
        readoutRef.current.style.transform = `translateY(${(puckY - 7).toFixed(1)}px)`;
        const label = p >= 0.995 ? 'p 1.0' : `p .${String(Math.round(p * 100)).padStart(2, '0')}`;
        if (readoutRef.current.textContent !== label) readoutRef.current.textContent = label;
      }
      for (const t of tr) {
        const dot = dotElsRef.current.get(t.id);
        if (!dot) continue;
        dot.classList.toggle('passed', c > t.zp + 20);
      }

      // gauge active state: enters on scroll/touch, exits 800ms after input
      const gaugeActive = now < gaugeActiveUntilRef.current;
      if (gaugeActive !== gaugeActiveOnRef.current) {
        gaugeActiveOnRef.current = gaugeActive;
        viewportRef.current?.classList.toggle('gauge-active', gaugeActive);
      }
      if (gaugeActive) unsettled = true;

      // leader line: puck → engaged card's left edge
      if (leaderRef.current && engagedCard) {
        const d = zpOf(engagedCard) - c;
        if (d <= CULL_BEHIND) {
          leaderRef.current.setAttribute('x1', String(GAUGE_INSET));
          leaderRef.current.setAttribute('x2', String(GAUGE_INSET));
        } else {
          const s = scaleFor(d);
          const y = corridorY(s, h) + passState(d).drop * PASS_DROP_FRAC * h;
          leaderRef.current.setAttribute('x1', String(GAUGE_INSET));
          leaderRef.current.setAttribute('y1', puckY.toFixed(1));
          leaderRef.current.setAttribute('x2', (cardCx - (CARD_W * s) / 2).toFixed(1));
          leaderRef.current.setAttribute('y2', y.toFixed(1));
        }
      }

      // the ends: header shows in the pulled-back overview; footer at the floor
      if (headerRef.current) {
        headerRef.current.style.opacity = band(tr[0].zp - c, 60, 180).toFixed(3);
      }
      if (footerRef.current) {
        const zpLast = tr[tr.length - 1].zp;
        footerRef.current.style.opacity = band(c, zpLast - 160, zpLast - 30).toFixed(3);
      }

      return unsettled;
    },
    [],
  );

  const renderFrameRef = useRef(renderFrame);
  renderFrameRef.current = renderFrame;
  const dollyToRef = useRef(dollyTo);
  dollyToRef.current = dollyTo;

  const startLoopRef = useRef<() => void>(() => {});
  useEffect(() => {
    const tick = (now: number) => {
      const unsettled = renderFrameRef.current(now);
      if (unsettled) lastActivityRef.current = now;
      if (now - lastActivityRef.current < 1400 || dollyRef.current !== null) {
        loopRef.current = requestAnimationFrame(tick);
      } else {
        loopRef.current = 0;
      }
    };
    startLoopRef.current = () => {
      if (!loopRef.current) loopRef.current = requestAnimationFrame(tick);
    };
    return () => {
      if (loopRef.current) cancelAnimationFrame(loopRef.current);
      loopRef.current = 0;
    };
  }, []);

  const nearestPlane = useCallback((c: number): TrackCard | null => {
    const tr = trackRef.current;
    if (!tr.length) return null;
    return tr.reduce((best, t) => (Math.abs(t.zp - c) < Math.abs(best.zp - c) ? t : best), tr[0]);
  }, []);

  // ----- interactions -----------------------------------------------------
  const handleCardTap = useCallback(
    (bubble: Bubble, zp: number) => {
      const scroller = scrollerRef.current;
      const c = scroller ? cameraAt(rangeRef.current.cStart, scroller.scrollTop) : zp;
      // open only a card that is engaged AND at focus — otherwise the tap
      // brings it to focus first (you never open something you haven't read)
      if (engagedIdRef.current === bubble.id && Math.abs(zp - c) < 80) {
        onOpen(bubble);
      } else {
        dollyTo(scrollForPlane(zp), 180, easeSnap);
      }
    },
    [dollyTo, onOpen, scrollForPlane],
  );

  // inverse of the puck map: gauge position (true p) → camera units
  const camForP = useCallback((p: number): number => {
    const tr = trackRef.current;
    if (!tr.length) return 0;
    const first = tr[0];
    if (p >= first.p) {
      const t = (1 - p) / (1 - first.p || 1);
      return first.zp - TOP_BEFORE + t * TOP_BEFORE;
    }
    for (let i = 0; i < tr.length - 1; i++) {
      const a = tr[i];
      const b = tr[i + 1];
      if (p >= b.p) {
        const t = (a.p - p) / (a.p - b.p || 1);
        return a.zp + t * (b.zp - a.zp);
      }
    }
    return tr[tr.length - 1].zp;
  }, []);

  // Gauge pointer machine: drag → scrub; tap → dolly; long-press → ledger.
  const gaugeStateRef = useRef<{
    id: number;
    y0: number;
    moved: boolean;
    scrubbing: boolean;
    timer: number;
  } | null>(null);

  const gaugePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const scroller = scrollerRef.current;
      if (!scroller || !vh) return;
      cancelDolly();
      markActivity();
      gaugeActiveUntilRef.current = performance.now() + 800;
      const rect = viewportRef.current!.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const c = cameraAt(rangeRef.current.cStart, scroller.scrollTop);
      const puckY = puckYAt(trackRef.current, c, dotYsRef.current, GAUGE_PAD);
      const scrubbing = Math.abs(y - puckY) < 16;
      const timer = window.setTimeout(() => {
        // long-press: toggle the ledger, cancel any pending tap/scrub
        const st = gaugeStateRef.current;
        if (st && !st.moved) {
          gaugeStateRef.current = null;
          setLedgerOpen((o) => !o);
        }
      }, 450);
      gaugeStateRef.current = { id: e.pointerId, y0: y, moved: false, scrubbing, timer };
      (e.target as Element).setPointerCapture(e.pointerId);
    },
    [cancelDolly, markActivity, vh],
  );

  const gaugePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const st = gaugeStateRef.current;
      const scroller = scrollerRef.current;
      if (!st || !scroller || e.pointerId !== st.id) return;
      const rect = viewportRef.current!.getBoundingClientRect();
      const y = e.clientY - rect.top;
      if (Math.abs(y - st.y0) > 8 && !st.moved) {
        st.moved = true;
        clearTimeout(st.timer);
        st.scrubbing = true; // a drag that started off-puck scrubs too
      }
      if (st.scrubbing && st.moved) {
        // direct, position-coupled — no easing
        const c = camForP(pForY(y));
        scroller.scrollTop = clamp(scrollFor(rangeRef.current.cStart, c), 0, rangeRef.current.maxScroll);
        gaugeActiveUntilRef.current = performance.now() + 800;
        markActivity();
      }
    },
    [camForP, markActivity, pForY],
  );

  const gaugePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const st = gaugeStateRef.current;
      const scroller = scrollerRef.current;
      gaugeStateRef.current = null;
      if (!st || !scroller || e.pointerId !== st.id) return;
      clearTimeout(st.timer);
      gaugeActiveUntilRef.current = performance.now() + 800;
      markActivity();
      const rect = viewportRef.current!.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const c = cameraAt(rangeRef.current.cStart, scroller.scrollTop);
      if (!st.moved) {
        // tap: dolly to the card whose RESOLVED dot is nearest the tap —
        // in a fanned tie cluster each dot is individually reachable
        setLedgerOpen(false);
        const tr = trackRef.current;
        const ys = dotYsRef.current;
        let target = tr[0];
        let bestDist = Infinity;
        tr.forEach((t, idx) => {
          const dist = Math.abs((ys[idx] ?? yForP(t.p)) - y);
          if (dist < bestDist) {
            bestDist = dist;
            target = t;
          }
        });
        const camDist = Math.abs(target.zp - c);
        dollyTo(scrollForPlane(target.zp), camDist > 500 ? 560 : 420, easeDolly);
      } else if (st.scrubbing) {
        // scrub released: come to rest on a card, never between
        const target = nearestPlane(c);
        if (target) dollyTo(scrollForPlane(target.zp), 180, easeSnap);
      }
    },
    [dollyTo, markActivity, nearestPlane, scrollForPlane, yForP],
  );

  // ----- scroll / touch wiring -------------------------------------------
  // Keyed on vh: the scroller only exists once the viewport is measured.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onScroll = () => {
      userScrolledRef.current = true;
      gaugeActiveUntilRef.current = performance.now() + 800;
      markActivity();
    };
    const onTouchStart = () => {
      touchActiveRef.current = true;
      cancelDolly();
    };
    const onTouchEnd = () => {
      touchActiveRef.current = false;
      markActivity();
    };
    const onWheel = () => {
      lastWheelRef.current = performance.now();
      cancelDolly();
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchend', onTouchEnd, { passive: true });
    scroller.addEventListener('touchcancel', onTouchEnd, { passive: true });
    scroller.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchend', onTouchEnd);
      scroller.removeEventListener('touchcancel', onTouchEnd);
      scroller.removeEventListener('wheel', onWheel);
    };
  }, [cancelDolly, markActivity, vh]);

  // ----- size observation -------------------------------------------------
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize((s) => (Math.round(r.width) !== s.w || Math.round(r.height) !== s.h ? { w: Math.round(r.width), h: Math.round(r.height) } : s));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    markActivity();
  });

  // ----- settle sink: resolution becomes travel ---------------------------
  // When a bubble settles (or un-settles), its plane leaps to/from p 0. The
  // card glides there through the corridor instead of teleporting, its gauge
  // dot slides down the scale, and if it settled while ENGAGED — you checked
  // its last chip right where you read it — the camera rides down with it,
  // in the same easing, all the way to the floor.
  const prevZpsRef = useRef(new Map<string, number>());
  const prevSettledRef = useRef(new Map<string, boolean>());
  useEffect(() => {
    const nowT = performance.now();
    for (const { t, info } of byTrack) {
      const wasSettled = prevSettledRef.current.get(t.id);
      const fromZp = prevZpsRef.current.get(t.id);
      if (
        wasSettled === undefined ||
        wasSettled === info.settled ||
        fromZp === undefined ||
        Math.abs(fromZp - t.zp) < 1 ||
        reducedRef.current
      )
        continue;
      const dur = fallMsRef.current;
      zpAnimsRef.current.set(t.id, { from: fromZp, t0: nowT, dur });
      dotSlidePendingRef.current = true;
      // Follow when the settling bubble holds the user's attention. Three
      // signals, most reliable first:
      //  - just-acted (§): the bubble whose chip the user tapped, snapshotted
      //    at tap time — survives the async completion round-trip, during
      //    which the live engaged ref can go stale as the rAF loop idles;
      //  - attention: the bubble whose sheet is open (a prop, always fresh);
      //  - engaged: the card under the camera right now.
      const acted = actedRef.current;
      const actedMatch = !!acted && acted.id === t.id && nowT - acted.at < 4000;
      if (
        info.settled &&
        (actedMatch || attentionIdRef.current === t.id || engagedIdRef.current === t.id)
      ) {
        if (actedMatch) actedRef.current = null;
        dollyToRef.current(scrollFor(rangeRef.current.cStart, t.zp), dur, easeDolly);
      }
      markActivity();
    }
    prevZpsRef.current = new Map(byTrack.map(({ t }) => [t.id, t.zp]));
    prevSettledRef.current = new Map(byTrack.map(({ t, info }) => [t.id, info.settled]));
  }, [byTrack, markActivity]);

  // ----- track changes: keep the engaged card under the camera ------------
  const trackKeyRef = useRef('');
  useEffect(() => {
    const key = track.map((t) => `${t.id}:${t.zp.toFixed(1)}`).join('|');
    if (trackKeyRef.current && trackKeyRef.current !== key) {
      const engaged = engagedIdRef.current;
      const t = track.find((x) => x.id === engaged);
      const scroller = scrollerRef.current;
      // A sinking engaged card owns the camera (glide or follow-dolly) —
      // the keep-under-camera teleport would snap the story to its end.
      if (t && scroller && userScrolledRef.current && !zpAnimsRef.current.has(t.id) && dollyRef.current === null)
        scroller.scrollTop = scrollForPlane(t.zp);
    }
    trackKeyRef.current = key;
    markActivity();
  }, [track, scrollForPlane, markActivity]);

  // ----- captured-today spawn: a fresh capture surfaces its bubble --------
  const spawnNonceRef = useRef(capturedSpawnNonce ?? 0);
  useEffect(() => {
    const nonce = capturedSpawnNonce ?? 0;
    if (nonce === spawnNonceRef.current) return;
    spawnNonceRef.current = nonce;
    const t = trackRef.current.find((x) => x.id === CAPTURED_BUBBLE_ID);
    if (t && sizeRef.current.h) dollyToRef.current(scrollForPlane(t.zp), 420, easeDolly);
  }, [capturedSpawnNonce, scrollForPlane]);

  // ----- living HUD: data-delta ripples -----------------------------------
  const prevToneRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (!vh) return;
    const next = new Map<string, string>();
    const newRipples: Ripple[] = [];
    for (const { t, info } of byTrack) {
      // doneCount in the signature: checking a chip pulses the bubble's dot
      const sig = `${info.status.tone}|${info.settled}|${info.doneCount}`;
      next.set(t.id, sig);
      const prev = prevToneRef.current.get(t.id);
      if (prev !== undefined && prev !== sig && !reducedRef.current) {
        newRipples.push({
          key: rippleSeq++,
          y: dotYsRef.current[t.i] ?? yForP(t.p),
          color: info.settled ? 'var(--good)' : info.accent,
        });
      }
    }
    prevToneRef.current = next;
    if (newRipples.length) setRipples((r) => [...r, ...newRipples]);
  }, [byTrack, vh, yForP]);

  // ----- morning rebuild story --------------------------------------------
  // Yesterday's record is snapshotted at first render — the persist effect
  // below overwrites the storage key before the init effect gets to run.
  const [storedPrev] = useState<{ identity: string; byName: Record<string, number> } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    } catch {
      return null;
    }
  });
  const initRef = useRef(false);
  useEffect(() => {
    if (!vh || !track.length || initRef.current) return;
    initRef.current = true;
    const identity = `${day}|${builtAt ?? ''}`;
    const stored = storedPrev;
    const isNewBuild = stored !== null && stored.identity !== identity;
    const scroller = scrollerRef.current;
    if (isNewBuild && !reducedRef.current) {
      // dots walk from yesterday's p to today's, staggered by rank …
      for (const { t, info } of byTrack) {
        const dot = dotElsRef.current.get(t.id);
        const prevP = stored!.byName[info.bubble.name];
        if (!dot) continue;
        if (prevP !== undefined && Math.abs(prevP - t.p) > 0.002) {
          // slide from yesterday's true-p position to today's resolved dot
          const dy = yForP(prevP) - (dotYsRef.current[t.i] ?? yForP(t.p));
          dot.animate(
            [{ transform: `translateY(${dy.toFixed(1)}px)` }, { transform: 'translateY(0)' }],
            { duration: 600, delay: t.i * 40, easing: 'ease-in-out', fill: 'backwards' },
          );
        } else if (prevP === undefined) {
          dot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 600 + t.i * 40, fill: 'backwards' });
        }
      }
      // … then the camera dollies from the overview to the first focal plane
      window.setTimeout(() => dollyTo(scrollForPlane(track[0].zp), 500, easeDolly), 700 + track.length * 40);
    } else {
      // default rest: focused on the first card (the overview stays one
      // flick up); reduced-motion rebuilds land here under a short fade
      if (isNewBuild) viewportRef.current?.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 200 });
      if (scroller) scroller.scrollTop = scrollForPlane(track[0].zp);
    }
    markActivity();
  }, [vh, track, byTrack, day, builtAt, storedPrev, dollyTo, scrollForPlane, markActivity, yForP]);

  // persist today's p by bubble name for tomorrow's story
  useEffect(() => {
    if (!track.length) return;
    const byName: Record<string, number> = {};
    for (const { t, info } of byTrack) byName[info.bubble.name] = t.p;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ identity: `${day}|${builtAt ?? ''}`, byName }));
    } catch {
      /* storage full/blocked — the rebuild story just won't animate */
    }
  }, [byTrack, track, day, builtAt]);

  // ----- in-place actions (§7: chips act where they are read) -------------
  const onChipTap = useCallback(
    (e: ReactMouseEvent, item: ItemView, bubbleId: string) => {
      // the chip captures its own tap; only body taps fall through to the sheet
      e.stopPropagation();
      // Anchor the settle-follow to THIS bubble now, at tap time: completion
      // is async, and by the time the map comes back and the bubble sinks the
      // live engaged ref may have gone stale. A tap on a chip means the card
      // was at focus — the camera should ride it down if it settles.
      if (!isDoneForNow(item)) actedRef.current = { id: bubbleId, at: performance.now() };
      onToggleComplete(item);
    },
    [onToggleComplete],
  );

  // First-step ledge (§3): the Brain's break-it-down invitation. Tapping opens
  // the composer; the typed step becomes a real item on the card (the server
  // clears firstStep and appends the step as a chip), so no local state to keep.
  const [breakdownFor, setBreakdownFor] = useState<string | null>(null);
  const [stepText, setStepText] = useState('');
  const openBreakdown = useCallback((e: ReactMouseEvent, bubbleId: string) => {
    e.stopPropagation();
    setStepText('');
    setBreakdownFor(bubbleId);
  }, []);
  const submitStep = useCallback(() => {
    const title = stepText.trim();
    if (!title || !breakdownFor) return;
    // Optimistic close: the refreshed map swaps the invitation for the chip;
    // on failure the invitation is still there to try again.
    onAddFirstStep?.(breakdownFor, title);
    setBreakdownFor(null);
    setStepText('');
  }, [stepText, breakdownFor, onAddFirstStep]);

  // ----- ledger -----------------------------------------------------------
  const pickFromLedger = useCallback(
    (zp: number) => {
      // collapse and dolly run concurrently
      setLedgerOpen(false);
      dollyTo(scrollForPlane(zp), 420, easeDolly);
    },
    [dollyTo, scrollForPlane],
  );

  useEffect(() => {
    markActivity();
  }, [ledgerOpen, markActivity]);

  // ----- static gauge geometry (React-rendered) ---------------------------
  const ticks = useMemo(() => {
    const out: { p: number; major: boolean }[] = [];
    for (let i = 0; i <= 20; i++) out.push({ p: i / 20, major: i % 5 === 0 });
    return out;
  }, []);

  // Dots at true p, then equal/near-equal prominences fan out symmetrically
  // AROUND their true position (single column, cluster centered on the
  // value it represents, clamped at the scale ends).
  const dotLayout = useMemo(() => {
    if (!vh) return [];
    const ys = spreadPositions(
      track.map((t) => yForP(t.p)),
      8,
      GAUGE_PAD,
      vh - GAUGE_PAD,
    );
    return track.map((t, idx) => ({ t, y: ys[idx] }));
  }, [track, vh, yForP]);

  // resolved dot ys for the frame loop (puck riding, leader geometry)
  const dotYsRef = useRef<number[]>([]);
  dotYsRef.current = useMemo(() => dotLayout.map((d) => d.y), [dotLayout]);

  // Settle sink, on the instrument: the sinking bubble's dot slides down the
  // scale to p 0 (and neighbors the spread re-fans shuffle along) — the same
  // WAAPI walk as the morning rebuild story.
  const prevDotYsRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (dotSlidePendingRef.current) {
      dotSlidePendingRef.current = false;
      for (const { t, y } of dotLayout) {
        const prev = prevDotYsRef.current.get(t.id);
        const el = dotElsRef.current.get(t.id);
        if (el && prev !== undefined && Math.abs(prev - y) > 2) {
          el.animate([{ transform: `translateY(${(prev - y).toFixed(1)}px)` }, { transform: 'translateY(0)' }], {
            duration: fallMsRef.current,
            easing: 'ease-in-out',
          });
        }
      }
    }
    prevDotYsRef.current = new Map(dotLayout.map(({ t, y }) => [t.id, y]));
  }, [dotLayout]);

  // Ledger rows: same centered spread with a readable gap; a row displaced
  // from its dot keeps a hairline tie back to it.
  const ledgerRows = useMemo(() => {
    if (!vh || !ledgerOpen) return [];
    const ys = spreadPositions(
      track.map((t) => yForP(t.p)),
      30,
      GAUGE_PAD + 8,
      vh - GAUGE_PAD - 8,
    );
    return track.map((t, idx) => ({
      t,
      info: infos.get(t.id)!,
      y: ys[idx],
      dotY: dotLayout[idx]?.y ?? ys[idx],
    }));
  }, [track, infos, vh, ledgerOpen, yForP, dotLayout]);

  const dateLine = useMemo(() => {
    const d = new Date();
    const date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const parts = [`${bubbles.length} bubble${bubbles.length === 1 ? '' : 's'}`];
    if (urgentCount > 0) parts.push(`${urgentCount} urgent`);
    return `${date} · ${parts.join(' · ')}`;
  }, [bubbles.length, urgentCount]);

  if (!bubbles.length) return null;

  // The sentence is the card (§1): prose with live tokens. Bold tokens are
  // the recognizable nouns; chips act in place; rotation carries no checkbox
  // pressure, so its chips read as bold. A chip whose item vanished degrades
  // to bold rather than breaking the utterance.
  const renderSegments = (info: CardInfo) =>
    info.segments.map((seg, i) => {
      if (seg.kind === 'text') return <span key={i}>{seg.text}</span>;
      if (seg.kind === 'bold')
        return (
          <b key={i} className="dsc-tok">
            {seg.text}
          </b>
        );
      const item = items[seg.itemId];
      // Chips complete DOs. The model sometimes wraps chip markup around an
      // event or fact — a checkbox that "completes" a HAPPEN is a lie, so
      // non-DO chips degrade to bold.
      if (!item || item.type !== 'DO' || info.bubble.kind === 'rotation')
        return (
          <b key={i} className="dsc-tok">
            {seg.text}
          </b>
        );
      // Recurring DOs check off per-occurrence (doneToday), not by status.
      const done = isDoneForNow(item);
      return (
        <span
          key={i}
          role="checkbox"
          aria-checked={done}
          className={`dsc-chip-tok${done ? ' done' : ''}`}
          onClick={(e) => onChipTap(e, item, info.bubble.id)}
        >
          <span className="dsc-box" aria-hidden>
            {done ? '✓' : ''}
          </span>
          {seg.text}
        </span>
      );
    });

  // Captured Today reads as a little log, not one utterance: each fresh
  // capture on its own row (§9.1). DOs keep their live checkbox chip;
  // facts/events show as bold tokens. When the capture carries a time — an
  // event, a timed deadline, a set rhythm — it's shown as due, inline in the
  // label. (Undated captures don't reach this bucket; date-only deadlines,
  // stored at noon, carry no time to show.)
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dueLabel = (item: ItemView): string | null => {
    if (item.type === 'HAPPEN' && item.eventAt) return fmtTime(item.eventAt);
    if (item.cadence?.atTime)
      return fmtTime(
        nextAtTimeOccurrence(item.cadence, item.eventAt ?? item.createdAt, new Date(), tzOffsetMinutes()).toISOString(),
      );
    if (item.deadline && !item.deadline.includes('T12:00:00')) return fmtTime(item.deadline);
    return null;
  };
  const renderCaptured = (info: CardInfo) => (
    <span className="dsc-cap-list">
      {info.members.map((item) => {
        const done = isDoneForNow(item);
        const due = dueLabel(item);
        const label = (
          <>
            {item.title}
            {due && <span className="dsc-chip-due"> · {due}</span>}
          </>
        );
        return item.type === 'DO' ? (
          <span
            key={item.id}
            role="checkbox"
            aria-checked={done}
            className={`dsc-chip-tok${done ? ' done' : ''}`}
            onClick={(e) => onChipTap(e, item, info.bubble.id)}
          >
            <span className="dsc-box" aria-hidden>
              {done ? '✓' : ''}
            </span>
            {label}
          </span>
        ) : (
          <b className="dsc-tok" key={item.id}>
            {label}
          </b>
        );
      })}
    </span>
  );

  return (
    <div className="dsc-viewport" ref={viewportRef}>
      {vh > 0 && (
        <>
          <div className="dsc-scroller" ref={scrollerRef}>
            <div className="dsc-spacer" style={{ height: range.maxScroll + vh }}>
              <div className="dsc-stage" style={{ height: vh }}>
                <div className="dsc-header" ref={headerRef}>
                  {dateLine}
                </div>
                {byTrack.map(({ t, info }) => {
                  const b = info.bubble;
                  const rotation = b.kind === 'rotation';
                  const captured = b.id === CAPTURED_BUBBLE_ID;
                  const showLedge = info.construction === 'nudge' && b.firstStep && !info.settled;
                  const showCount = !rotation && !info.settled && !info.notch && info.total >= 2;
                  return (
                    <button
                      key={b.id}
                      ref={attachCard(b.id)}
                      className={`dsc-card${rotation ? ' rotation' : ''}${captured ? ' captured' : ''}${info.settled ? ' settled' : ''}`}
                      style={
                        {
                          left: cx,
                          width: CARD_W,
                          zIndex: track.length - t.i,
                          '--card-accent': info.accent,
                        } as CSSProperties
                      }
                      onClick={() => handleCardTap(b, t.zp)}
                    >
                      <span className="dsc-near">
                        <span className="dsc-body">
                          <span className="dsc-rim" aria-hidden />
                          {info.rail && !info.settled && (
                            <span className="dsc-rail" aria-hidden>
                              <span
                                className="dsc-rail-elapsed"
                                style={{ width: `${(info.rail.todayFrac * 100).toFixed(1)}%` }}
                              />
                              <span
                                className="dsc-rail-today"
                                style={{ left: `${(info.rail.todayFrac * 100).toFixed(1)}%` }}
                              />
                            </span>
                          )}
                          {info.notch && !info.settled && <span className="dsc-notch">{info.notch.label}</span>}
                          {showCount && (
                            <span className="dsc-count">
                              {info.doneCount}/{info.total}
                            </span>
                          )}
                          {captured && !info.settled && <span className="dsc-eyebrow">Captured today</span>}
                          <span className="dsc-sentence">
                            {info.settled ? (
                              <>
                                <b className="dsc-tok">{b.name}</b> — {info.settledWord}.
                              </>
                            ) : captured ? (
                              renderCaptured(info)
                            ) : (
                              renderSegments(info)
                            )}
                          </span>
                          {info.construction === 'batch' && !info.settled && (
                            <span className="dsc-pips" aria-hidden>
                              {info.members.map((m) => (
                                <span
                                  key={m.id}
                                  className={`dsc-pip${isDoneForNow(m) ? ' filled' : ''}`}
                                />
                              ))}
                            </span>
                          )}
                        </span>
                        {showLedge && (
                          <span role="button" className="dsc-ledge" onClick={(e) => openBreakdown(e, b.id)}>
                            <span className="dsc-box" aria-hidden>
                              ＋
                            </span>
                            <span className="dsc-ledge-text">{b.firstStep}</span>
                          </span>
                        )}
                      </span>
                      <span className="dsc-far" aria-hidden>
                        {info.settled ? `✓ ${b.name}` : info.far}
                      </span>
                    </button>
                  );
                })}
                <div className="dsc-footer" ref={footerRef}>
                  end of today
                </div>
              </div>
            </div>
          </div>

          <svg className="dsc-leader" width={vw} height={vh} aria-hidden>
            <line ref={leaderRef} x1={0} y1={0} x2={0} y2={0} />
          </svg>

          {breakdownFor && (
            <>
              <div className="dsc-dim" onClick={() => setBreakdownFor(null)} />
              <div className="dsc-breakdown">
                <div className="dsc-breakdown-invite">{infos.get(breakdownFor)?.bubble.firstStep}</div>
                <div className="dsc-breakdown-row">
                  <input
                    autoFocus
                    value={stepText}
                    placeholder="The first ten minutes…"
                    onChange={(e) => setStepText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitStep();
                      if (e.key === 'Escape') setBreakdownFor(null);
                    }}
                  />
                  <button disabled={!stepText.trim()} onClick={submitStep}>
                    Add
                  </button>
                </div>
              </div>
            </>
          )}

          {ledgerOpen && (
            <>
              <div className="dsc-dim" onClick={() => setLedgerOpen(false)} />
              <div className="dsc-ledger">
                <svg className="dsc-ledger-ties" width="44" height={vh} aria-hidden>
                  {ledgerRows.map(
                    ({ t, info, y, dotY }) =>
                      Math.abs(y - dotY) > 10 && (
                        <line
                          key={t.id}
                          x1={GAUGE_INSET + 5}
                          y1={dotY}
                          x2={42}
                          y2={y}
                          style={{ stroke: info.accent, opacity: 0.45 }}
                        />
                      ),
                  )}
                </svg>
                {ledgerRows.map(({ t, info, y }) => (
                  <button
                    key={t.id}
                    className="dsc-ledger-row"
                    style={{ top: y }}
                    onClick={() => pickFromLedger(t.zp)}
                  >
                    {/* temporality stays a word, never a hue (§5) */}
                    <span
                      className="dsc-ledger-word"
                      style={{ color: info.settled ? 'var(--good)' : 'var(--text-dim)' }}
                    >
                      {info.settled ? '✓ done' : info.status.label}
                    </span>
                    <span className="dsc-ledger-name" style={{ color: info.settled ? undefined : info.accent }}>
                      {info.bubble.name}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div
            className="dsc-gauge"
            style={{ width: GAUGE_HIT }}
            onPointerDown={gaugePointerDown}
            onPointerMove={gaugePointerMove}
            onPointerUp={gaugePointerUp}
            onPointerCancel={gaugePointerUp}
          >
            <div className="dsc-scale" style={{ top: GAUGE_PAD, bottom: GAUGE_PAD }} />
            <div className="dsc-cap" style={{ top: GAUGE_PAD - 1 }} />
            <div className="dsc-cap" style={{ bottom: GAUGE_PAD - 1 }} />
            {ticks.map(({ p, major }) => (
              <div key={p} className={`dsc-tick${major ? ' major' : ''}`} style={{ top: yForP(p) }} />
            ))}
            {[1, 0.75, 0.5, 0.25, 0].map((p) => (
              <div key={p} className="dsc-glabel" style={{ top: yForP(p) - 5 }}>
                {p === 1 ? '1.0' : p === 0 ? '0' : `.${p * 100}`}
              </div>
            ))}
            {dotLayout.map(({ t, y }) => {
              // Dots wear the card's theme hue (§5): the dot on the gauge IS
              // the card's rim — one wayfinding system, no urgency encoding.
              const info = infos.get(t.id)!;
              const dsize = 5;
              return (
                <div
                  key={t.id}
                  ref={attachDot(t.id)}
                  className={`dsc-gdot${info.settled ? ' settled' : ''}`}
                  style={{
                    top: y - dsize / 2,
                    left: GAUGE_INSET - dsize / 2,
                    width: dsize,
                    height: dsize,
                    background: info.settled ? 'transparent' : info.accent,
                    borderColor: info.settled ? 'var(--good)' : info.accent,
                  }}
                />
              );
            })}
            {ripples.map((r) => (
              <div
                key={r.key}
                className="dsc-ripple"
                style={{ top: r.y, left: GAUGE_INSET, color: r.color }}
                onAnimationEnd={() => setRipples((rs) => rs.filter((x) => x.key !== r.key))}
              />
            ))}
            <div className="dsc-readout" ref={readoutRef} />
            <div className="dsc-puck" ref={puckRef} />
          </div>
        </>
      )}
    </div>
  );
}
