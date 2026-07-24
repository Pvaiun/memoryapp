import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ItemView } from '../../shared/types';
import { dayKey } from '../../shared/dates';
import { api, itemColor, localDay } from '../api';
import ItemRow from '../components/ItemRow';

// Calendar (§6): a presentation lens over the same backend — HAPPENs on their
// dates, DO deadlines, calendar-worthy recurrences. No separate store.
//
// One continuous strip of weeks at a single, always-legible zoom (the "map"
// philosophy: whatever is on screen is readable — no magnifier lens, no tiny
// pips). Quiet weeks stay compact; busy weeks grow to fit their events. A
// sticky header names the month you're looking at, derived passively from the
// scroll position. Tapping a day unfolds its detail inline, under that week.

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
const CHIPS_PER_DAY = 3; // then a "+N" overflow marker
const BAND_H = 20; // per multi-day band row reserved at the top of a week

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Date-only values anchor to local noon (dates.ts), so noon-exact means "no
// clock time" — same convention ItemRow reads.
function clock(d: Date): string | null {
  if (d.getHours() === 12 && d.getMinutes() === 0) return null;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// A grid cell is ~7 characters wide, so the full "7:30 PM" would eat the title.
// Compact it to "7:30p" / "2p" — enough to place the event, room left to read it.
function chipTime(d: Date): string | null {
  if (d.getHours() === 12 && d.getMinutes() === 0) return null;
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? 'a' : 'p';
  const h12 = h % 12 || 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}${suffix}`;
}

function tint(c: string): string {
  return `color-mix(in srgb, ${c} 16%, transparent)`;
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
  // No day is selected by default — the calendar itself is the view; detail is
  // strictly opt-in by tapping a day.
  const [selected, setSelected] = useState<string | null>(null);
  // The week sitting at the top of the viewport names the header month; today's
  // visibility gates the "Today" button. Both are read passively from scroll.
  const [topIdx, setTopIdx] = useState(WEEKS_BACK);
  const [todayVisible, setTodayVisible] = useState(true);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const ticking = useRef(false);

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
    // All-day first, then by clock time — the reading order of a real day.
    for (const list of m.values()) {
      list.sort((a, b) => {
        const ca = clock(new Date(a.date));
        const cb = clock(new Date(b.date));
        if (!ca && cb) return -1;
        if (ca && !cb) return 1;
        return a.date.localeCompare(b.date);
      });
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

  // Passive scroll read: which week is topmost (names the month) and whether
  // today's week is still on screen (gates the Today button). No snapping, no
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
        if (r && r.offsetTop <= top + 4) idx = i;
        else if (r) break;
      }
      setTopIdx(idx);
      const trow = rowRefs.current[WEEKS_BACK];
      if (trow) setTodayVisible(trow.offsetTop < bottom - 24 && trow.offsetTop + trow.offsetHeight > top);
    });
  }, []);

  // Open with today's week just below the top edge, so the recent past peeks in.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const row = rowRefs.current[WEEKS_BACK];
    if (el && row) el.scrollTop = row.offsetTop - Math.round(el.clientHeight * 0.12);
  }, []);

  const goToday = useCallback(() => {
    const el = scrollRef.current;
    const row = rowRefs.current[WEEKS_BACK];
    if (el && row) el.scrollTo({ top: row.offsetTop - Math.round(el.clientHeight * 0.12), behavior: 'smooth' });
  }, []);

  const openDay = useCallback((k: string) => {
    setSelected((s) => (s === k ? null : k));
  }, []);

  // Thursday names a straddling week's month (majority rule).
  const headMonth = addDays(weeks[topIdx], 4);

  return (
    <div className="calv">
      <div className="calv-head">
        <h3>{headMonth.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h3>
        {!todayVisible && (
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
          const weekSpans = spans.filter((s) => s.start <= keys[6] && s.end >= keys[0]);
          const bandGap = weekSpans.length ? weekSpans.length * BAND_H + 4 : 0;
          const monthStart = days.find((d) => d.getDate() === 1);
          const selCol = selected && selected >= keys[0] && selected <= keys[6] ? keys.indexOf(selected) : -1;
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
                className="cal-week"
              >
                {days.map((d, di) => {
                  const k = keys[di];
                  const list = byDay.get(k) ?? [];
                  const marks = list.filter((e) => !spanItemIds.has(e.itemId));
                  const isToday = k === today;
                  const isSel = selected === k;
                  return (
                    <button
                      key={k}
                      className={`cal-day${isToday ? ' today' : ''}${isSel ? ' sel' : ''}`}
                      onClick={() => openDay(k)}
                    >
                      <span className="n">{d.getDate()}</span>
                      {bandGap > 0 && <span className="band-gap" style={{ height: bandGap }} />}
                      {marks.slice(0, CHIPS_PER_DAY).map((e, ei) => {
                        const item = items[e.itemId];
                        if (!item) return null;
                        const c = itemColor(item);
                        const due = e.kind === 'deadline';
                        const rec = e.kind === 'occurrence';
                        const t = due ? null : chipTime(new Date(e.date));
                        return (
                          <span
                            key={`${e.itemId}-${ei}`}
                            className={`cal-chip${due ? ' is-due' : ''}${rec ? ' is-rec' : ''}`}
                            style={{ color: c, background: tint(c) }}
                          >
                            {due && <b className="chip-t">due</b>}
                            {t && <b className="chip-t">{t}</b>}
                            <span className="chip-x">{item.title}</span>
                          </span>
                        );
                      })}
                      {marks.length > CHIPS_PER_DAY && <span className="day-more">+{marks.length - CHIPS_PER_DAY} more</span>}
                    </button>
                  );
                })}
                {weekSpans.map((s, si) => {
                  const item = items[s.itemId];
                  if (!item) return null;
                  const c = itemColor(item);
                  const startCol = s.start <= keys[0] ? 0 : keys.indexOf(s.start);
                  const endCol = s.end >= keys[6] ? 6 : keys.indexOf(s.end);
                  let label: string;
                  if (s.end <= keys[6]) {
                    const end = new Date(item.eventEnd!);
                    const t = clock(end);
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
                {selCol >= 0 && (
                  <span className="cal-sel-caret" style={{ left: `calc(${selCol} * 100% / 7 + 50% / 7)` }} />
                )}
              </div>
              {selCol >= 0 && selected && (
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
      </div>
    </div>
  );
}
