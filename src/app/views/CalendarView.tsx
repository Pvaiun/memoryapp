import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ItemView } from '../../shared/types';
import { dayKey } from '../../shared/dates';
import { api, itemColor, localDay } from '../api';
import ItemRow from '../components/ItemRow';

// Calendar (§6): a presentation lens over the same backend — HAPPENs on their
// dates, DO deadlines, calendar-worthy recurrences. No separate store.
//
// The view is one continuous strip of weeks (no month pages). A two-week lens
// sits about a third of the way down the screen: both lens weeks render full
// wrappable keyword chips and span bands; everything else compresses to
// numbers + pips (solid dot = one-off, ring = recurrence). Scrolling drags
// the lens like a flat wheel picker; day detail opens on tap, under the lens.

interface Entry {
  itemId: string;
  date: string;
  kind: string;
}

const WEEKS_BACK = 8; // scrollable past before today's week
const WEEKS_TOTAL = 60; // ~14 months of continuous weeks
// The server walks occurrences with a per-item cap (100), so a year in one
// request would silently truncate frequent recurrences — fetch in 8-week windows.
const CHUNK_WEEKS = 8;
const LENS_FRACTION = 0.32; // lens line sits this far down the scroller
const SNAP_INSET = 18; // settle with the line this far inside the lens

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function lineOf(el: HTMLElement): number {
  return Math.round(el.clientHeight * LENS_FRACTION);
}

// Date-only values anchor to local noon (dates.ts), so noon-exact means "no
// clock time" — same convention ItemRow reads.
function clock(d: Date): string | null {
  if (d.getHours() === 12 && d.getMinutes() === 0) return null;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'to', 'for', 'with', 'my', 'our', 'and', 'of', 'on', 'at', 'in']);

// The few words a day speaks in: leading significant title words. The lens
// cells wrap to two lines, so this is a cap, not a squeeze.
function kw(title: string, max: number): string {
  const words = title.split(/\s+/);
  const strong = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  return (strong.length ? strong : words).slice(0, max).join(' ');
}

function tint(c: string): string {
  return `color-mix(in srgb, ${c} 15%, transparent)`;
}

export default function CalendarView({
  refreshKey,
  onOpenItem,
  onToggleComplete,
}: {
  refreshKey: number;
  onOpenItem: (item: ItemView) => void;
  onToggleComplete: (item: ItemView) => void;
}) {
  // "Today" is the sleep-cycle day (5am boundary): at 1am the highlight stays
  // on the evening's date. Cell placement stays wall-clock — it's a calendar.
  const today = localDay();

  const weeks = useMemo(() => {
    const anchor = new Date(`${today}T12:00:00`);
    const first = addDays(anchor, -anchor.getDay() - WEEKS_BACK * 7);
    first.setHours(0, 0, 0, 0);
    return Array.from({ length: WEEKS_TOTAL }, (_, i) => addDays(first, i * 7));
  }, [today]);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [items, setItems] = useState<Record<string, ItemView>>({});
  const [focusIdx, setFocusIdx] = useState(WEEKS_BACK);
  // No day is selected by default — the calendar itself is the view; detail
  // is strictly opt-in by tapping a day.
  const [selected, setSelected] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const focusRef = useRef(focusIdx);
  focusRef.current = focusIdx;
  // While a tap-driven smooth scroll is in flight, scroll events must not
  // re-derive focus (the destination is already chosen).
  const programmatic = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const calls = [];
    for (let i = 0; i < WEEKS_TOTAL; i += CHUNK_WEEKS) {
      const to = addDays(weeks[0], Math.min(i + CHUNK_WEEKS, WEEKS_TOTAL) * 7);
      calls.push(api.calendar(weeks[i].toISOString(), to.toISOString()));
    }
    Promise.all(calls)
      .then((rs) => {
        if (cancelled) return;
        setEntries(rs.flatMap((r) => r.entries));
        setItems(Object.assign({}, ...rs.map((r) => r.items)));
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [weeks, refreshKey]);

  const byDay = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of entries) {
      const k = dayKey(new Date(e.date));
      const list = m.get(k) ?? [];
      list.push(e);
      m.set(k, list);
    }
    return m;
  }, [entries]);

  // Multi-day one-offs render as one continuous band per week, not per-day
  // marks — a five-day visit is one visit.
  const spans = useMemo(() => {
    const out: { itemId: string; start: string; end: string }[] = [];
    for (const it of Object.values(items)) {
      if (!it.eventAt || !it.eventEnd || it.cadence) continue;
      const start = dayKey(new Date(it.eventAt));
      const end = dayKey(new Date(it.eventEnd));
      if (end > start) out.push({ itemId: it.id, start, end });
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }, [items]);
  const spanItemIds = useMemo(() => new Set(spans.map((s) => s.itemId)), [spans]);

  // Wheel-picker settle: once scrolling goes quiet, glide so the lens line
  // rests just inside the top lens week. Also corrects any offset drift from
  // tier-height transitions that ran during the scroll.
  const settle = useCallback(() => {
    programmatic.current = false;
    const el = scrollRef.current;
    const row = rowRefs.current[focusRef.current];
    if (!el || !row) return;
    const target = row.offsetTop - lineOf(el) + SNAP_INSET;
    if (Math.abs(el.scrollTop - target) > 3) el.scrollTo({ top: target, behavior: 'smooth' });
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el && !programmatic.current) {
      const line = el.scrollTop + lineOf(el);
      // An open day panel inflates the strip under the lens; measure it out
      // so the lens keeps its week-height cadence instead of needing an
      // extra panel-height of scroll to advance.
      const panel = el.querySelector<HTMLElement>('.wk-panel');
      const panelH = panel ? panel.offsetHeight + 10 : 0;
      // Top lens week = the row the lens line is inside (last top above it).
      let idx = 0;
      for (let i = 0; i < rowRefs.current.length; i++) {
        const r = rowRefs.current[i];
        if (!r) continue;
        const top = r.offsetTop - (panelH && i > focusRef.current + 1 ? panelH : 0);
        if (top <= line) idx = i;
        else break;
      }
      if (idx !== focusRef.current) {
        setFocusIdx(idx);
        setSelected(null); // scrolling the lens away closes the day panel
      }
    }
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(settle, 200);
  }, [settle]);

  useEffect(() => () => clearTimeout(settleTimer.current), []);

  // Open with today's week at the top of the lens; nothing selected.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const row = rowRefs.current[WEEKS_BACK];
    if (el && row) el.scrollTop = row.offsetTop - lineOf(el) + SNAP_INSET;
  }, []);

  const scrollToWeek = useCallback((wi: number) => {
    programmatic.current = true;
    setFocusIdx(wi);
    // Scroll after the tier reflow has a frame to apply; the settle pass
    // corrects the small drift the height transitions leave behind.
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      const row = rowRefs.current[wi];
      if (el && row) el.scrollTo({ top: row.offsetTop - lineOf(el) + SNAP_INSET, behavior: 'smooth' });
      setTimeout(() => {
        programmatic.current = false;
      }, 600);
    });
  }, []);

  const openDay = useCallback(
    (wi: number, k: string) => {
      if (wi === focusRef.current || wi === focusRef.current + 1) {
        setSelected((s) => (s === k ? null : k));
        return;
      }
      setSelected(k);
      scrollToWeek(wi);
    },
    [scrollToWeek],
  );

  const goToday = useCallback(() => {
    setSelected(null);
    scrollToWeek(WEEKS_BACK);
  }, [scrollToWeek]);

  const lensHasToday = focusIdx === WEEKS_BACK || focusIdx + 1 === WEEKS_BACK;
  // Thursday names the week's month (majority rule for straddling weeks).
  const focusMonth = addDays(weeks[focusIdx], 4);
  // The panel unfolds under the whole lens when the selected day is in it.
  const lensStart = dayKey(weeks[focusIdx]);
  const lensEnd = dayKey(addDays(weeks[Math.min(focusIdx + 1, WEEKS_TOTAL - 1)], 6));
  const selInLens = selected !== null && selected >= lensStart && selected <= lensEnd;

  return (
    <div className="calv">
      <div className="calv-head">
        <h3>{focusMonth.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h3>
        {lensHasToday ? (
          <span className="calv-sub">This week</span>
        ) : (
          <button className="cal-today-btn" onClick={goToday}>
            Today
          </button>
        )}
      </div>
      <div className="calv-dow">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className="calv-scroll" ref={scrollRef} onScroll={onScroll}>
        {weeks.map((ws, wi) => {
          const days = Array.from({ length: 7 }, (_, d) => addDays(ws, d));
          const keys = days.map(dayKey);
          const tier = wi === focusIdx ? 'a' : wi === focusIdx + 1 ? 'b' : 'c';
          const inLens = tier !== 'c';
          const weekSpans = spans.filter((s) => s.start <= keys[6] && s.end >= keys[0]);
          const bandGap = inLens && weekSpans.length ? weekSpans.length * 20 + 2 : 0;
          const monthStart = days.find((d) => d.getDate() === 1);
          return (
            <Fragment key={keys[0]}>
              {/* month marker — suppressed between the two lens weeks so the
                  lens reads as one box; the header title covers the seam */}
              {wi > 0 && monthStart && tier !== 'b' && (
                <div className="cal-month-mark">{monthStart.toLocaleDateString([], { month: 'long' })}</div>
              )}
              <div
                ref={(el) => {
                  rowRefs.current[wi] = el;
                }}
                className={`cal-week ${inLens ? `wk-lens wk-lens-${tier}` : 'wk-far'}`}
              >
                {days.map((d, di) => {
                  const k = keys[di];
                  const list = byDay.get(k) ?? [];
                  const marks = list.filter((e) => !spanItemIds.has(e.itemId));
                  return (
                    <button
                      key={k}
                      className={`cal-day${k === today ? ' today' : ''}${inLens && selected === k ? ' sel' : ''}`}
                      onClick={() => openDay(wi, k)}
                    >
                      <span className="n">{d.getDate()}</span>
                      {bandGap > 0 && <span className="band-gap" style={{ height: bandGap }} />}
                      {inLens &&
                        marks.slice(0, 2).map((e, ei) => {
                          const item = items[e.itemId];
                          if (!item) return null;
                          const c = itemColor(item);
                          return (
                            <span
                              key={`${e.itemId}-${ei}`}
                              className={`day-kw${e.kind === 'deadline' ? ' kw-due' : ''}${e.kind === 'occurrence' ? ' kw-rec' : ''}`}
                              style={{ color: c, background: tint(c) }}
                            >
                              {kw(item.title, 3)}
                            </span>
                          );
                        })}
                      {inLens && marks.length > 2 && <span className="day-more">+{marks.length - 2}</span>}
                      {!inLens && (
                        <span className="pips">
                          {marks.slice(0, 4).map((e, ei) => (
                            <i
                              key={ei}
                              className={e.kind === 'occurrence' ? 'pip-r' : 'pip-m'}
                              style={
                                e.kind === 'occurrence'
                                  ? { borderColor: items[e.itemId] ? itemColor(items[e.itemId]) : 'var(--text-faint)' }
                                  : { background: items[e.itemId] ? itemColor(items[e.itemId]) : 'var(--text-faint)' }
                              }
                            />
                          ))}
                        </span>
                      )}
                    </button>
                  );
                })}
                {weekSpans.map((s, si) => {
                  const item = items[s.itemId];
                  if (!item) return null;
                  const c = itemColor(item);
                  const startCol = s.start <= keys[0] ? 0 : keys.indexOf(s.start);
                  const endCol = s.end >= keys[6] ? 6 : keys.indexOf(s.end);
                  let label = '';
                  if (inLens) {
                    if (s.end <= keys[6]) {
                      const end = new Date(item.eventEnd!);
                      const t = clock(end);
                      label = `${item.title} · until ${end.toLocaleDateString([], { weekday: 'short' })}${t ? ` ${t}` : ''}`;
                    } else {
                      label = `${item.title} ›`;
                    }
                  }
                  const top = (inLens ? 40 : 32) + si * (inLens ? 20 : 6);
                  return (
                    <span
                      key={s.itemId}
                      className={`wk-band${s.start < keys[0] ? ' cont-l' : ''}${s.end > keys[6] ? ' cont-r' : ''}`}
                      style={{
                        left: `calc(${startCol} * 100% / 7 + 3px)`,
                        width: `calc(${endCol - startCol + 1} * 100% / 7 - 6px)`,
                        top,
                        background: tint(c),
                        borderColor: c,
                        color: c,
                      }}
                    >
                      {label}
                    </span>
                  );
                })}
              </div>
              {tier === 'b' && selInLens && selected && (
                <div className="wk-panel">
                  <div className="wk-panel-head">
                    <h4>
                      {new Date(`${selected}T12:00:00`).toLocaleDateString([], {
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
                      })}
                    </h4>
                    <button className="wk-panel-close" onClick={() => setSelected(null)} aria-label="Close day">
                      ✕
                    </button>
                  </div>
                  {(byDay.get(selected) ?? []).length === 0 && <div className="hint">Nothing scheduled.</div>}
                  {(byDay.get(selected) ?? []).map((e, i) => {
                    const item = items[e.itemId];
                    if (!item) return null;
                    return (
                      <div key={`${e.itemId}-${i}`} style={{ display: 'flex', alignItems: 'center' }}>
                        <span className="time-chip">
                          {e.kind === 'deadline' ? 'due' : (clock(new Date(e.date)) ?? 'all day')}
                        </span>
                        <div style={{ flex: 1 }}>
                          <ItemRow item={item} onOpen={onOpenItem} onToggleComplete={onToggleComplete} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Fragment>
          );
        })}
        <div className="cal-legend">
          <i className="pip-m" />
          <span>one-off</span>
          <i className="pip-r" />
          <span>repeats</span>
        </div>
      </div>
    </div>
  );
}
