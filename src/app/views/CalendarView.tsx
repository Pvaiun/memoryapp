import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { ItemView } from '../../shared/types';
import { isClosedStatus } from '../../shared/types';
import { isDoneForNow } from '../../shared/cadence';
import { dayKey } from '../../shared/dates';
import { api, itemColor, localDay } from '../api';

// Calendar (§6): a presentation lens over the same backend — HAPPENs on their
// dates, DO deadlines, calendar-worthy recurrences. No separate store.
//
// Two renderings of one continuous scroller, both at a single always-legible
// zoom (the "map" philosophy: whatever is on screen is readable — no magnifier
// lens, no tiny pips):
//
//   month — seven columns, the shape of a month, chips too narrow for sentences
//   week  — a sticky seven-column spine over a full-width agenda
//
// The split exists because seven columns on a phone is ~43px of chip no matter
// which view you are in, so a "week" made of columns buys nothing the month
// doesn't already show. The agenda gives the title the full width instead
// (~253px), and the spine keeps the part seven columns are genuinely good at:
// the week's shape, plus where you are standing in it.
//
// Both modes share the scroller, the week refs and the passive scroll read, so
// the month header, the Today button and the chunked fetch are mode-agnostic.

interface Entry {
  itemId: string;
  date: string;
  kind: string;
}

type CalMode = 'month' | 'week';

const WEEKS_BACK = 8; // scrollable past before today's week
const WEEKS_TOTAL = 60; // ~14 months of continuous weeks
// The server walks occurrences with a per-item cap (100), so a year in one
// request would silently truncate frequent recurrences — fetch in 8-week windows.
const CHUNK_WEEKS = 8;
const CHIPS_PER_DAY = 3; // then a "+N" overflow marker (month mode)
const BAND_H = 20; // per multi-day band row reserved at the top of a week
const TOP_INSET = 2; // today's week rests this far below the top edge
// A day's load bar fills at this many items — five is a heavy day here, and
// past it the bar just reads "full" rather than compressing everything else.
const LOAD_FULL = 5;

const MODE_KEY = 'memory.calView';
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function readMode(): CalMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'week' ? 'week' : 'month';
  } catch {
    return 'month';
  }
}

// Distance from an element to the scroller, summed up the offsetParent chain.
// Reading el.offsetTop directly only works while nothing between the two is
// positioned — a constraint the span bracket now breaks by design.
function offsetTopIn(el: HTMLElement, container: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = el;
  while (node && node !== container) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return top;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Whether a date names a moment comes from the item, not from the instant.
// Reading it off the clock ("is this exactly noon?") made a real noon meeting
// indistinguishable from an all-day entry, in both directions.
function isTimed(item: ItemView | undefined): boolean {
  return !!item && item.datePrecision !== 'day';
}

function clock(d: Date, item: ItemView | undefined): string | null {
  if (!isTimed(item)) return null;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// A grid cell is ~7 characters wide, so the full "7:30 PM" would eat the title.
// Compact it to "7:30p" / "2p" — enough to place the event, room left to read it.
function chipTime(d: Date, item: ItemView | undefined): string | null {
  if (!isTimed(item)) return null;
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? 'a' : 'p';
  const h12 = h % 12 || 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}${suffix}`;
}

// The agenda's time gutter is a fixed column, so times keep their minutes and
// line up on the colon — "11:00a" over "7:00p", not the chip's clipped "7p".
function agendaTime(d: Date, item: ItemView | undefined): string | null {
  if (!isTimed(item)) return null;
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`;
}

function tint(c: string): string {
  return `color-mix(in srgb, ${c} 16%, transparent)`;
}

// Composed rather than a single toLocaleDateString({weekday, day}) call: that
// yields "26 Sun" in many locales, and the weekday has to lead here — it's what
// the eye scans down the agenda for.
function dayLabel(d: Date): string {
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${d.getDate()}`;
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
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState<Record<string, ItemView>>({});
  // Which rendering you last used is a per-device preference, like the Now view
  // — coming back to the calendar shouldn't reset how you read it.
  const [mode, setModeState] = useState<CalMode>(readMode);
  // The week sitting at the top of the viewport names the header; today's
  // visibility gates the "This week" button; in the agenda the day at the top is
  // marked on the spine. All three are read passively from scroll.
  const [topIdx, setTopIdx] = useState(WEEKS_BACK);
  const [weekVisible, setWeekVisible] = useState(true);
  const [topDay, setTopDay] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const dayRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const ticking = useRef(false);
  // Set when a month-view day tap switches into the agenda: the layout effect
  // below consumes it to land on that exact day rather than its week.
  const pendingDay = useRef<string | null>(null);
  const prevMode = useRef(mode);

  const setMode = useCallback((m: CalMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* private mode or quota — the preference just doesn't survive the session */
    }
  }, []);

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
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
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
    // All-day first, then by clock time — the reading order of a real day.
    for (const list of m.values()) {
      list.sort((a, b) => {
        const ta = isTimed(items[a.itemId]);
        const tb = isTimed(items[b.itemId]);
        if (ta !== tb) return ta ? 1 : -1;
        return a.date.localeCompare(b.date);
      });
    }
    return m;
  }, [entries, items]);

  // Multi-day one-offs render as one continuous band per week (month) or a
  // bracket down the days they cover (agenda), not per-day marks — a five-day
  // visit is one visit.
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

  // Passive scroll read: which week is topmost (names the header) and whether
  // this week is still on screen (gates the This week button). No snapping, no
  // programmatic-scroll guards — the strip is one flat zoom that scrolls freely.
  const onScroll = useCallback(() => {
    if (ticking.current) return;
    ticking.current = true;
    requestAnimationFrame(() => {
      ticking.current = false;
      const el = scrollRef.current;
      if (!el) return;
      const top = el.scrollTop;
      const bottom = top + el.clientHeight;
      let idx = 0;
      for (let i = 0; i < rowRefs.current.length; i++) {
        const r = rowRefs.current[i];
        if (r && offsetTopIn(r, el) <= top + 4) idx = i;
        else if (r) break;
      }
      setTopIdx(idx);
      const trow = rowRefs.current[WEEKS_BACK];
      if (trow) {
        const rt = offsetTopIn(trow, el);
        setWeekVisible(rt < bottom - 24 && rt + trow.offsetHeight > top);
      }
      // The spine also marks the day you're standing on. Only the top week's
      // seven days can hold that mark, so the extra scan stays seven elements.
      if (mode === 'week') {
        let mark: string | null = null;
        for (let d = 0; d < 7; d++) {
          const k = dayKey(addDays(weeks[idx], d));
          const de = dayRefs.current.get(k);
          if (de && offsetTopIn(de, el) <= top + 4) mark = k;
        }
        setTopDay(mark);
      }
    });
  }, [mode, weeks]);

  // Open with today's week as the very top line — it's a scrolling calendar,
  // so the past is one scroll up; the present shouldn't cost a row of screen.
  //
  // Placed twice, and the second time is the one that counts. At mount every
  // day is an empty pill, so the eight weeks of past above today are at their
  // shortest; when the entries land those weeks grow and carry today's week
  // down the strip, leaving a scrollTop that now points days earlier. Once
  // placed against real content the flag stops it fighting the user's scroll.
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (placed.current) return;
    if (loaded) placed.current = true;
    const el = scrollRef.current;
    const row = rowRefs.current[WEEKS_BACK];
    // 'instant', not 'auto': .calv-scroll sets scroll-behavior: smooth, which
    // governs plain scrollTop assignment as well, and 'auto' defers to exactly
    // that. Either would animate the whole eight weeks from the top of the
    // strip down to today — twice, since this runs again once entries land.
    // Landing on today is not a journey; only the Today button is.
    if (el && row) el.scrollTo({ top: offsetTopIn(row, el) - TOP_INSET, behavior: 'instant' });
  }, [loaded]);

  // Switching mode is a zoom, not a jump: hold the date that was at the top of
  // the viewport. Both renderings are the same scroller over the same weeks, so
  // "what's at the top" is a coordinate they share.
  useLayoutEffect(() => {
    if (prevMode.current === mode) return;
    prevMode.current = mode;
    const el = scrollRef.current;
    if (!el) return;
    const day = pendingDay.current;
    pendingDay.current = null;
    const target = (day && dayRefs.current.get(day)) || rowRefs.current[topIdx];
    if (target) el.scrollTo({ top: offsetTopIn(target, el) - TOP_INSET, behavior: 'instant' });
  }, [mode, topIdx]);

  const goThisWeek = useCallback(() => {
    const el = scrollRef.current;
    const row = rowRefs.current[WEEKS_BACK];
    if (el && row) el.scrollTo({ top: offsetTopIn(row, el) - TOP_INSET, behavior: 'smooth' });
  }, []);

  const goDay = useCallback((k: string) => {
    const el = scrollRef.current;
    const d = dayRefs.current.get(k);
    if (el && d) el.scrollTo({ top: offsetTopIn(d, el) - TOP_INSET, behavior: 'smooth' });
  }, []);

  // Tapping a day in the month view is the "zoom in" gesture: it drops you into
  // the agenda at that day. That leaves the old day-detail sheet with no job —
  // the agenda is that sheet, for seven days at a time instead of one.
  const openDay = useCallback(
    (k: string) => {
      pendingDay.current = k;
      setMode('week');
    },
    [setMode],
  );

  // Thursday names a straddling week's month (majority rule).
  const headMonth = addDays(weeks[topIdx], 4);
  const wkStart = weeks[topIdx];
  const wkEnd = addDays(wkStart, 6);
  const headWeek = `${wkStart.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${wkEnd.toLocaleDateString(
    [],
    wkStart.getMonth() === wkEnd.getMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' },
  )}`;

  // One day's entries as agenda rows. Span items are excluded — they render
  // once as the bracket around the days they cover, not per day.
  const agendaRows = (k: string) => {
    const list = (byDay.get(k) ?? []).filter((e) => !spanItemIds.has(e.itemId));
    return list.map((e, i) => {
      const item = items[e.itemId];
      if (!item) return null;
      const c = itemColor(item);
      const due = e.kind === 'deadline';
      const rec = e.kind === 'occurrence';
      const t = due ? null : agendaTime(new Date(e.date), item);
      // Recurring DOs never reach status='completed' — their checked state is
      // doneToday, released again when the sleep-cycle day rolls (5am).
      // ...and doneness belongs to the occurrence it was ticked for. isDoneForNow
      // answers "is the rhythm satisfied right now", which is true of today's
      // occurrence only — painting next Sunday's as already done says a thing
      // that hasn't happened yet is finished. Same for its checkbox: a future
      // occurrence has nothing to tick, and ticking it would mark today's.
      const rhythm = !!item.cadence;
      const checkable =
        item.type === 'DO' && (item.status === 'active' || item.status === 'completed') && (!rhythm || k === today);
      const done = isClosedStatus(item.status) || (isDoneForNow(item) && (!rhythm || k === today));
      return (
        <div
          key={`${e.itemId}-${i}`}
          className={`ag-row${done ? ' done' : ''}`}
          onClick={() => onOpenItem(item)}
        >
          <span className={`ag-when${due ? ' due' : ''}`}>{due ? 'due' : (t ?? '·')}</span>
          <span className="ag-what" style={{ '--ag-c': c } as CSSProperties}>
            {item.title}
            {rec && <i className="ag-rep">⟳</i>}
          </span>
          {checkable && (
            <button
              className={`ag-box${done ? ' done' : ''}`}
              aria-label={done ? 'Mark not done' : 'Mark done'}
              onClick={(ev) => {
                ev.stopPropagation();
                onToggleComplete(item);
              }}
            >
              ✓
            </button>
          )}
        </div>
      );
    });
  };

  const agendaDay = (d: Date, k: string, inSpan = false, lead?: ReactNode) => {
    const rows = agendaRows(k);
    const filled = rows.length > 0 || !!lead;
    return (
      <div
        key={k}
        className={`cal-agenda-day${filled ? ' has' : ''}${k === today ? ' is-today' : ''}`}
        ref={(el) => {
          if (el) dayRefs.current.set(k, el);
          else dayRefs.current.delete(k);
        }}
      >
        <div className={`ag-day${k === today ? ' today' : ''}`}>
          <b>{dayLabel(d)}</b>
          {k === today && <span className="ag-today-tag">Today</span>}
          {/* A quiet day costs one line, not a header plus a line of its own —
              over an empty stretch the agenda is mostly these. Inside a span
              bracket an empty day means "still the trip", so it says nothing. */}
          {!filled && !inSpan && <span className="ag-empty">Nothing</span>}
        </div>
        {lead}
        {rows}
      </div>
    );
  };

  return (
    <div className="calv">
      <div className="calv-head">
        <h3>{mode === 'week' ? headWeek : headMonth.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h3>
        <div className="calv-tools">
          {!weekVisible && (
            <button className="cal-today-btn" onClick={goThisWeek}>
              This week
            </button>
          )}
          {/* A tap, not a pinch: month and agenda are two renderings, not two
              points on a zoom continuum — there is nothing in between them. */}
          <div className="cal-seg" role="group" aria-label="Calendar view">
            <button className={mode === 'month' ? 'on' : ''} aria-pressed={mode === 'month'} onClick={() => setMode('month')}>
              Month
            </button>
            <button className={mode === 'week' ? 'on' : ''} aria-pressed={mode === 'week'} onClick={() => setMode('week')}>
              Week
            </button>
          </div>
        </div>
      </div>
      {mode === 'month' ? (
        <div className="calv-dow">
          {DOW.map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
      ) : (
        // The spine: seven columns kept for the one thing 43px can carry
        // honestly — the week's shape — plus where you are standing in it.
        <div className="cal-spine">
          {Array.from({ length: 7 }, (_, i) => {
            const d = addDays(wkStart, i);
            const k = dayKey(d);
            const n = (byDay.get(k) ?? []).length;
            return (
              <button
                key={k}
                className={`spine-d${k === today ? ' today' : ''}${k === topDay ? ' at' : ''}`}
                onClick={() => goDay(k)}
                aria-label={`Go to ${dayLabel(d)}`}
              >
                <span className="spine-dow">{DOW[d.getDay()]}</span>
                <span className="spine-n">{d.getDate()}</span>
                <span className="spine-load">
                  <i style={{ width: `${Math.min(n / LOAD_FULL, 1) * 100}%` }} />
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className="calv-scroll" ref={scrollRef} onScroll={onScroll}>
        {weeks.map((ws, wi) => {
          const days = Array.from({ length: 7 }, (_, d) => addDays(ws, d));
          const keys = days.map(dayKey);
          const weekSpans = spans.filter((s) => s.start <= keys[6] && s.end >= keys[0]);
          const bandGap = weekSpans.length ? weekSpans.length * BAND_H + 4 : 0;
          const monthStart = days.find((d) => d.getDate() === 1);
          return (
            <Fragment key={keys[0]}>
              {wi > 0 && monthStart && (
                <div className="cal-month-mark">
                  {monthStart.toLocaleDateString([], { month: 'long' })}
                  {monthStart.getMonth() === 0 ? ` ${monthStart.getFullYear()}` : ''}
                </div>
              )}
              <div
                ref={(el) => {
                  rowRefs.current[wi] = el;
                }}
                className={mode === 'week' ? 'cal-agenda-week' : 'cal-week'}
              >
                {mode === 'week'
                  ? // Walk the week left to right, pulling the days a span covers
                    // into one bracketed group. Overlapping spans are rare here;
                    // the first to claim a day owns it, and any other renders as
                    // an ordinary row.
                    (() => {
                      const out = [];
                      let di = 0;
                      while (di < 7) {
                        const s = weekSpans.find((sp) => keys[di] >= sp.start && keys[di] <= sp.end);
                        if (!s) {
                          out.push(agendaDay(days[di], keys[di]));
                          di++;
                          continue;
                        }
                        let to = di;
                        while (to + 1 < 7 && keys[to + 1] >= s.start && keys[to + 1] <= s.end) to++;
                        const item = items[s.itemId];
                        const startsHere = s.start >= keys[0];
                        const endsHere = s.end <= keys[6];
                        const covered = days.slice(di, to + 1);
                        out.push(
                          <div className="ag-group" key={`${s.itemId}-${keys[di]}`}>
                            <span
                              className={`ag-bracket${startsHere ? '' : ' cont-t'}${endsHere ? '' : ' cont-b'}`}
                              style={item ? ({ '--ag-c': itemColor(item) } as CSSProperties) : undefined}
                            />
                            {covered.map((d, i) =>
                              agendaDay(
                                d,
                                keys[di + i],
                                true,
                                i === 0 && startsHere && item ? (
                                  <div
                                    className="ag-span-label"
                                    style={{ '--ag-c': itemColor(item) } as CSSProperties}
                                    onClick={() => onOpenItem(item)}
                                  >
                                    {item.title}
                                    <small>
                                      {dayLabel(new Date(item.eventAt!))} – {dayLabel(new Date(item.eventEnd!))}
                                    </small>
                                  </div>
                                ) : undefined,
                              ),
                            )}
                          </div>,
                        );
                        di = to + 1;
                      }
                      return out;
                    })()
                  : days.map((d, di) => {
                      const k = keys[di];
                      const list = byDay.get(k) ?? [];
                      const marks = list.filter((e) => !spanItemIds.has(e.itemId));
                      const isToday = k === today;
                      return (
                        <button key={k} className={`cal-day${isToday ? ' today' : ''}`} onClick={() => openDay(k)}>
                          <span className="n">{d.getDate()}</span>
                          {bandGap > 0 && <span className="band-gap" style={{ height: bandGap }} />}
                          {marks.slice(0, CHIPS_PER_DAY).map((e, ei) => {
                            const item = items[e.itemId];
                            if (!item) return null;
                            const c = itemColor(item);
                            const due = e.kind === 'deadline';
                            const rec = e.kind === 'occurrence';
                            const t = due ? null : chipTime(new Date(e.date), item);
                            return (
                              <span
                                key={`${e.itemId}-${ei}`}
                                className={`cal-chip${due ? ' is-due' : ''}${rec ? ' is-rec' : ''}`}
                                style={{ color: c, background: tint(c) }}
                              >
                                {/* time on its own line so the title gets the full
                                    column width and wraps whole-word, not mid-word */}
                                {t && <b className="chip-t-line">{t}</b>}
                                <span className="chip-x">
                                  {due && <b className="chip-t">due </b>}
                                  {item.title}
                                </span>
                              </span>
                            );
                          })}
                          {marks.length > CHIPS_PER_DAY && (
                            <span className="day-more">+{marks.length - CHIPS_PER_DAY} more</span>
                          )}
                        </button>
                      );
                    })}
                {mode === 'month' &&
                  weekSpans.map((s, si) => {
                    const item = items[s.itemId];
                    if (!item) return null;
                    const c = itemColor(item);
                    const startCol = s.start <= keys[0] ? 0 : keys.indexOf(s.start);
                    const endCol = s.end >= keys[6] ? 6 : keys.indexOf(s.end);
                    let label: string;
                    if (s.end <= keys[6]) {
                      const end = new Date(item.eventEnd!);
                      const t = clock(end, item);
                      label = `${item.title} · until ${end.toLocaleDateString([], { weekday: 'short' })}${t ? ` ${t}` : ''}`;
                    } else {
                      label = `${item.title} ›`;
                    }
                    return (
                      <span
                        key={s.itemId}
                        className={`wk-band${s.start < keys[0] ? ' cont-l' : ''}${s.end > keys[6] ? ' cont-r' : ''}`}
                        style={{
                          left: `calc(${startCol} * 100% / 7 + 3px)`,
                          width: `calc(${endCol - startCol + 1} * 100% / 7 - 6px)`,
                          top: 30 + si * BAND_H,
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
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
