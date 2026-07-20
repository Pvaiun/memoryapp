import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Bubble, ItemView } from '../../../shared/types';
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
  descFade,
  easeDolly,
  easeSnap,
  engagedIndex,
  fanRows,
  GAUGE_INSET,
  passState,
  scaleFor,
  scrollFor,
  trackNorm,
} from './engine';
import type { TrackCard } from './engine';

// Descent "Instrument", v2 — the vertical corridor. React renders the scene
// structure once per data change; a rAF loop writes transforms/opacity/filter
// straight to the DOM as a pure function of scrollTop, so scrolling never
// touches React. Scroll physics (momentum, fling, settle-onto-a-card) are
// native: a real scroll container with CSS scroll-snap points at each focal
// plane. Nothing here animates without user input or a data delta.
//
// Spatially: cards are horizontally centered. Depth recedes upward — deep
// cards hang small near a vanishing line in the upper third, descend and
// grow as the camera approaches, reach focus in the lower-middle, then
// sweep down off the bottom edge as they pass. The gauge (right edge)
// plots the display track so its dots always match the felt travel; the
// ledger opens as a left-side panel with room for full names.

const CARD_W = 272; // focus-tier card width — fully on-screen at 390
const GAUGE_PAD = 14; // px above/below the scale ends
const GAUGE_HIT = 24;
const PASS_DROP_FRAC = 0.62; // extra downward travel during the pass, × vh

const STORAGE_KEY = 'memory.descent.prev';

interface CardEls {
  root: HTMLButtonElement;
  base: HTMLElement;
  pigment: HTMLElement;
  desc: HTMLElement | null;
}

interface CardInfo {
  bubble: Bubble;
  status: BubbleStatus;
  doneCount: number;
  total: number;
  settled: boolean;
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
  onOpen,
}: {
  bubbles: Bubble[];
  items: Record<string, ItemView>;
  day: string;
  builtAt: string | null;
  onOpen: (bubble: Bubble) => void;
}) {
  const reduced = usePrefersReducedMotion();
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const gaugeRef = useRef<HTMLDivElement>(null);
  const puckRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const leaderRef = useRef<SVGLineElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [ripples, setRipples] = useState<Ripple[]>([]);

  // ----- derived scene ---------------------------------------------------
  const track = useMemo(() => buildTrack(bubbles), [bubbles]);
  const range = useMemo(() => cameraRange(track), [track]);
  const infos = useMemo(() => {
    const m = new Map<string, CardInfo>();
    for (const b of bubbles) {
      const status = bubbleStatus(b, items);
      const { doneCount, total, allDone } = bubbleCounts(b, items);
      m.set(b.id, { bubble: b, status, doneCount, total, settled: allDone });
    }
    return m;
  }, [bubbles, items]);
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
  const cx = (vw - 28) / 2; // corridor center: viewport center minus gauge inset

  const yForNorm = useCallback(
    (norm: number) => GAUGE_PAD + norm * (vh - 2 * GAUGE_PAD),
    [vh],
  );
  const normForY = useCallback(
    (y: number) => clamp((y - GAUGE_PAD) / (vh - 2 * GAUGE_PAD), 0, 1),
    [vh],
  );

  // ----- imperative registries -------------------------------------------
  const cardElsRef = useRef(new Map<string, CardEls>());
  const dotElsRef = useRef(new Map<string, HTMLElement>());
  const engagedIdRef = useRef<string | null>(null);
  const lastActivityRef = useRef(0);
  const gaugeActiveUntilRef = useRef(0);
  const gaugeActiveOnRef = useRef(false);
  const loopRef = useRef(0);
  const lastCRef = useRef(NaN);
  const dollyRef = useRef<number | null>(null);
  const userScrolledRef = useRef(false);

  const trackRef = useRef(track);
  trackRef.current = track;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const infosRef = useRef(infos);
  infosRef.current = infos;

  const attachCard = useCallback((id: string) => {
    return (el: HTMLButtonElement | null) => {
      if (!el) {
        cardElsRef.current.delete(id);
        return;
      }
      cardElsRef.current.set(id, {
        root: el,
        base: el.querySelector<HTMLElement>('.dsc-base')!,
        pigment: el.querySelector<HTMLElement>('.dsc-pigment')!,
        desc: el.querySelector<HTMLElement>('.dsc-desc'),
      });
    };
  }, []);

  const attachDot = useCallback((id: string) => {
    return (el: HTMLDivElement | null) => {
      if (el) dotElsRef.current.set(id, el);
      else dotElsRef.current.delete(id);
    };
  }, []);

  // ----- the frame loop ---------------------------------------------------
  const markActivity = useCallback(() => {
    lastActivityRef.current = performance.now();
    startLoopRef.current();
  }, []);

  const renderFrame = useCallback(
    (now: number): boolean => {
      const scroller = scrollerRef.current;
      const tr = trackRef.current;
      const { w, h } = sizeRef.current;
      if (!scroller || !tr.length || !h) return false;
      const rg = rangeRef.current;
      const isReduced = reducedRef.current;
      const c = cameraAt(rg.cStart, scroller.scrollTop);
      const cardCx = (w - 28) / 2;
      const engaged = engagedIndex(tr, c);
      const engagedCard = tr[engaged];
      engagedIdRef.current = engagedCard ? engagedCard.id : null;

      let unsettled = Math.abs(c - lastCRef.current) > 0.01;
      lastCRef.current = c;

      for (const t of tr) {
        const els = cardElsRef.current.get(t.id);
        if (!els) continue;
        const info = infosRef.current.get(t.id);
        const d = t.zp - c;

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

        els.root.style.transform = `translate(-50%, -50%) translate3d(0, ${y.toFixed(2)}px, 0) scale(${s.toFixed(4)})`;
        els.root.style.opacity = pass.alpha.toFixed(3);
        els.root.style.pointerEvents = pass.alpha > 0.05 ? '' : 'none';
        els.base.style.opacity = (cues.opacity * settledMul).toFixed(3);
        els.base.style.filter = `saturate(${sat.toFixed(3)}) contrast(${cues.contrast.toFixed(3)})`;
        // Status pigment is exempt: full saturation, opacity floor 0.85.
        els.pigment.style.opacity = Math.max(cues.opacity, 0.85).toFixed(3);
        if (els.desc) els.desc.style.opacity = descFade(s).toFixed(3);
      }

      // ----- gauge: plots the display track -----
      const camNorm = trackNorm(tr, c);
      const puckY = yForNormPx(camNorm, h);
      if (puckRef.current) puckRef.current.style.transform = `translateY(${puckY.toFixed(1)}px)`;
      if (readoutRef.current) {
        readoutRef.current.style.transform = `translateY(${(puckY - 7).toFixed(1)}px)`;
        const label = `${engaged + 1} / ${tr.length}`;
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

      // leader line: puck → engaged card's right edge
      if (leaderRef.current && engagedCard) {
        const d = engagedCard.zp - c;
        if (d <= CULL_BEHIND) {
          leaderRef.current.setAttribute('x2', String(w - GAUGE_INSET));
          leaderRef.current.setAttribute('x1', String(w - GAUGE_INSET));
        } else {
          const s = scaleFor(d);
          const y = corridorY(s, h) + passState(d).drop * PASS_DROP_FRAC * h;
          leaderRef.current.setAttribute('x1', String(w - GAUGE_INSET));
          leaderRef.current.setAttribute('y1', puckY.toFixed(1));
          leaderRef.current.setAttribute('x2', (cardCx + (CARD_W * s) / 2).toFixed(1));
          leaderRef.current.setAttribute('y2', y.toFixed(1));
        }
      }

      // the ends: header shows in the pulled-back overview; footer past the last card
      if (headerRef.current) {
        headerRef.current.style.opacity = band(tr[0].zp - c, 60, 180).toFixed(3);
      }
      if (footerRef.current) {
        footerRef.current.style.opacity = band(c - tr[tr.length - 1].zp, 60, 180).toFixed(3);
      }

      return unsettled;
    },
    [],
  );

  const renderFrameRef = useRef(renderFrame);
  renderFrameRef.current = renderFrame;

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

  // ----- dolly (programmatic camera moves) --------------------------------
  const cancelDolly = useCallback(() => {
    if (dollyRef.current !== null) {
      cancelAnimationFrame(dollyRef.current);
      dollyRef.current = null;
      const scroller = scrollerRef.current;
      if (scroller) scroller.style.scrollSnapType = '';
    }
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
      // Suspend snap while easing through non-snap positions; every dolly
      // target IS a snap point, so restoring causes no jump.
      scroller.style.scrollSnapType = 'none';
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
          scroller.style.scrollSnapType = '';
          scroller.scrollTop = target;
        }
      };
      dollyRef.current = requestAnimationFrame(step);
    },
    [cancelDolly, markActivity],
  );

  const scrollForPlane = useCallback((zp: number) => scrollFor(rangeRef.current.cStart, zp), []);

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

  // Gauge pointer machine: drag → scrub; tap → dolly; long-press → ledger.
  const gaugeStateRef = useRef<{
    id: number;
    y0: number;
    moved: boolean;
    scrubbing: boolean;
    timer: number;
  } | null>(null);

  const camForNorm = useCallback((norm: number) => {
    const tr = trackRef.current;
    if (tr.length < 2) return tr.length ? tr[0].zp : 0;
    return tr[0].zp + norm * (tr[tr.length - 1].zp - tr[0].zp);
  }, []);

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
      const puckY = yForNorm(trackNorm(trackRef.current, c));
      const scrubbing = Math.abs(y - puckY) < 16;
      if (scrubbing) scroller.style.scrollSnapType = 'none';
      const timer = window.setTimeout(() => {
        // long-press: toggle the ledger, cancel any pending tap/scrub
        const st = gaugeStateRef.current;
        if (st && !st.moved) {
          gaugeStateRef.current = null;
          if (scrollerRef.current) scrollerRef.current.style.scrollSnapType = '';
          setLedgerOpen((o) => !o);
        }
      }, 450);
      gaugeStateRef.current = { id: e.pointerId, y0: y, moved: false, scrubbing, timer };
      (e.target as Element).setPointerCapture(e.pointerId);
    },
    [cancelDolly, markActivity, vh, yForNorm],
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
        if (!st.scrubbing) {
          // a drag that started off-puck scrubs too
          st.scrubbing = true;
          scroller.style.scrollSnapType = 'none';
        }
      }
      if (st.scrubbing && st.moved) {
        // direct, position-coupled — no easing
        const c = camForNorm(normForY(y));
        scroller.scrollTop = clamp(scrollFor(rangeRef.current.cStart, c), 0, rangeRef.current.maxScroll);
        gaugeActiveUntilRef.current = performance.now() + 800;
        markActivity();
      }
    },
    [camForNorm, markActivity, normForY],
  );

  const gaugePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const st = gaugeStateRef.current;
      const scroller = scrollerRef.current;
      gaugeStateRef.current = null;
      if (!st || !scroller || e.pointerId !== st.id) return;
      clearTimeout(st.timer);
      scroller.style.scrollSnapType = '';
      gaugeActiveUntilRef.current = performance.now() + 800;
      markActivity();
      const rect = viewportRef.current!.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const c = cameraAt(rangeRef.current.cStart, scroller.scrollTop);
      if (!st.moved) {
        // tap: dolly to the tapped position, resolving onto the nearest card
        setLedgerOpen(false);
        const target = nearestPlane(camForNorm(normForY(y)));
        if (target) {
          const dist = Math.abs(target.zp - c);
          dollyTo(scrollForPlane(target.zp), dist > 500 ? 560 : 420, easeDolly);
        }
      } else if (st.scrubbing) {
        // scrub released: come to rest on a card, never between
        const target = nearestPlane(c);
        if (target) dollyTo(scrollForPlane(target.zp), 180, easeSnap);
      }
    },
    [camForNorm, dollyTo, markActivity, nearestPlane, normForY, scrollForPlane],
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
    const onTouch = () => cancelDolly();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('touchstart', onTouch, { passive: true });
    scroller.addEventListener('wheel', onTouch, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('touchstart', onTouch);
      scroller.removeEventListener('wheel', onTouch);
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

  // ----- track changes: keep the engaged card under the camera ------------
  const trackKeyRef = useRef('');
  useEffect(() => {
    const key = track.map((t) => `${t.id}:${t.zp.toFixed(1)}`).join('|');
    if (trackKeyRef.current && trackKeyRef.current !== key) {
      const engaged = engagedIdRef.current;
      const t = track.find((x) => x.id === engaged);
      const scroller = scrollerRef.current;
      if (t && scroller && userScrolledRef.current) scroller.scrollTop = scrollForPlane(t.zp);
    }
    trackKeyRef.current = key;
    markActivity();
  }, [track, scrollForPlane, markActivity]);

  // ----- living HUD: data-delta ripples -----------------------------------
  const prevToneRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (!vh) return;
    const next = new Map<string, string>();
    const newRipples: Ripple[] = [];
    for (const { t, info } of byTrack) {
      const sig = `${info.status.tone}|${info.settled}`;
      next.set(t.id, sig);
      const prev = prevToneRef.current.get(t.id);
      if (prev !== undefined && prev !== sig && !reducedRef.current) {
        newRipples.push({
          key: rippleSeq++,
          y: yForNorm(trackNorm(track, t.zp)),
          color: info.settled ? 'var(--good)' : info.status.color,
        });
      }
    }
    prevToneRef.current = next;
    if (newRipples.length) setRipples((r) => [...r, ...newRipples]);
  }, [byTrack, track, vh, yForNorm]);

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
    if (isNewBuild) {
      if (reducedRef.current) {
        // instant reposition under a short fade
        viewportRef.current?.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 200 });
        const scroller = scrollerRef.current;
        if (scroller) scroller.scrollTop = scrollForPlane(track[0].zp);
      } else {
        // dots walk from yesterday's track position to today's, staggered …
        for (const { t, info } of byTrack) {
          const dot = dotElsRef.current.get(t.id);
          const prevNorm = stored!.byName[info.bubble.name];
          if (!dot) continue;
          const norm = trackNorm(track, t.zp);
          if (prevNorm !== undefined && Math.abs(prevNorm - norm) > 0.002) {
            const dy = yForNorm(prevNorm) - yForNorm(norm);
            dot.animate(
              [{ transform: `translateY(${dy.toFixed(1)}px)` }, { transform: 'translateY(0)' }],
              { duration: 600, delay: t.i * 40, easing: 'ease-in-out', fill: 'backwards' },
            );
          } else if (prevNorm === undefined) {
            dot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 600 + t.i * 40, fill: 'backwards' });
          }
        }
        // … then the camera dollies from the overview to the first focal plane
        window.setTimeout(() => dollyTo(scrollForPlane(track[0].zp), 500, easeDolly), 700 + track.length * 40);
      }
    }
    markActivity();
  }, [vh, track, byTrack, day, builtAt, storedPrev, dollyTo, scrollForPlane, markActivity, yForNorm]);

  // persist today's track position by bubble name for tomorrow's story
  useEffect(() => {
    if (!track.length) return;
    const byName: Record<string, number> = {};
    for (const { t, info } of byTrack) byName[info.bubble.name] = trackNorm(track, t.zp);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ identity: `${day}|${builtAt ?? ''}`, byName }));
    } catch {
      /* storage full/blocked — the rebuild story just won't animate */
    }
  }, [byTrack, track, day, builtAt]);

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
    const out: { f: number; major: boolean }[] = [];
    for (let i = 0; i <= 20; i++) out.push({ f: i / 20, major: i % 5 === 0 });
    return out;
  }, []);

  const dotLayout = useMemo(() => {
    if (!vh) return [];
    return track.map((t) => ({ t, y: yForNorm(trackNorm(track, t.zp)) }));
  }, [track, vh, yForNorm]);

  const ledgerRows = useMemo(() => {
    if (!vh || !ledgerOpen) return [];
    const ys = track.map((t) => yForNorm(trackNorm(track, t.zp)));
    const fanned = fanRows(ys, 30, vh - GAUGE_PAD);
    return track.map((t, idx) => ({ t, info: infos.get(t.id)!, y: fanned[idx] }));
  }, [track, infos, vh, ledgerOpen, yForNorm]);

  const dateLine = useMemo(() => {
    const d = new Date();
    const date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const parts = [`${bubbles.length} bubble${bubbles.length === 1 ? '' : 's'}`];
    if (urgentCount > 0) parts.push(`${urgentCount} urgent`);
    return `${date} · ${parts.join(' · ')}`;
  }, [bubbles.length, urgentCount]);

  if (!bubbles.length) return null;

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
                  return (
                    <button
                      key={b.id}
                      ref={attachCard(b.id)}
                      className={`dsc-card${rotation ? ' rotation' : ''}${info.settled ? ' settled' : ''}`}
                      style={
                        {
                          left: cx,
                          width: CARD_W,
                          zIndex: track.length - t.i,
                          '--tile-accent': info.status.color,
                        } as CSSProperties
                      }
                      onClick={() => handleCardTap(b, t.zp)}
                    >
                      <span className="dsc-base">
                        <span className="dsc-top">
                          <span className="dsc-name">{b.name}</span>
                          <span className="dsc-count">
                            {info.doneCount > 0
                              ? `${info.doneCount}/${info.total}`
                              : `${info.total} item${info.total === 1 ? '' : 's'}`}
                          </span>
                        </span>
                        <span className="dsc-chiprow">
                          <span className={`status-chip dsc-ghost${info.status.tone === 'red' && !info.settled ? ' filled' : ''}`}>
                            {info.settled ? 'done' : info.status.label}
                          </span>
                        </span>
                        {b.reason && !info.settled && <span className="dsc-desc">{b.reason}</span>}
                      </span>
                      <span className="dsc-pigment">
                        <span
                          className={`status-chip dsc-chip${info.settled ? ' done' : info.status.tone === 'red' ? ' filled' : ''}`}
                        >
                          {info.settled ? 'done' : info.status.label}
                        </span>
                      </span>
                    </button>
                  );
                })}
                <div className="dsc-footer" ref={footerRef}>
                  end of today
                </div>
              </div>
              {/* focal-plane snap points, plus rests at both ends */}
              <div className="dsc-snap" style={{ top: 0 }} />
              {track.map((t) => (
                <div key={t.id} className="dsc-snap" style={{ top: scrollFor(range.cStart, t.zp) }} />
              ))}
              <div className="dsc-snap" style={{ top: range.maxScroll }} />
            </div>
          </div>

          <svg className="dsc-leader" width={vw} height={vh} aria-hidden>
            <line ref={leaderRef} x1={0} y1={0} x2={0} y2={0} />
          </svg>

          {ledgerOpen && (
            <>
              <div className="dsc-dim" onClick={() => setLedgerOpen(false)} />
              <div className="dsc-ledger">
                {ledgerRows.map(({ t, info, y }) => (
                  <button
                    key={t.id}
                    className="dsc-ledger-row"
                    style={{ top: y }}
                    onClick={() => pickFromLedger(t.zp)}
                  >
                    <span
                      className="dsc-ledger-word"
                      style={{ color: info.settled ? 'var(--good)' : info.status.color }}
                    >
                      {info.settled ? '✓ done' : info.status.label}
                    </span>
                    <span className="dsc-ledger-name">{info.bubble.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div
            className="dsc-gauge"
            ref={gaugeRef}
            style={{ width: GAUGE_HIT }}
            onPointerDown={gaugePointerDown}
            onPointerMove={gaugePointerMove}
            onPointerUp={gaugePointerUp}
            onPointerCancel={gaugePointerUp}
          >
            <div className="dsc-scale" style={{ top: GAUGE_PAD, bottom: GAUGE_PAD }} />
            <div className="dsc-cap" style={{ top: GAUGE_PAD - 1 }} />
            <div className="dsc-cap" style={{ bottom: GAUGE_PAD - 1 }} />
            {ticks.map(({ f, major }) => (
              <div key={f} className={`dsc-tick${major ? ' major' : ''}`} style={{ top: yForNorm(f) }} />
            ))}
            {dotLayout.map(({ t, y }) => {
              const info = infos.get(t.id)!;
              const red = info.status.tone === 'red' && !info.settled;
              const dsize = red ? 7 : 5;
              return (
                <div
                  key={t.id}
                  ref={attachDot(t.id)}
                  className={`dsc-gdot${info.settled ? ' settled' : ''}${red ? ' red' : ''}`}
                  style={{
                    top: y - dsize / 2,
                    right: GAUGE_INSET - dsize / 2,
                    width: dsize,
                    height: dsize,
                    background: info.settled ? 'transparent' : info.status.color,
                    borderColor: info.settled ? 'var(--good)' : info.status.color,
                  }}
                />
              );
            })}
            {ripples.map((r) => (
              <div
                key={r.key}
                className="dsc-ripple"
                style={{ top: r.y, right: GAUGE_INSET, color: r.color }}
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

// module-scope helper so renderFrame (stable callback) can use it
function yForNormPx(norm: number, vh: number): number {
  return GAUGE_PAD + norm * (vh - 2 * GAUGE_PAD);
}
