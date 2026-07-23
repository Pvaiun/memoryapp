import { useEffect, useMemo, useState } from 'react';
import type { ItemView } from '../../shared/types';
import { dayKey } from '../../shared/dates';
import { api, itemColor, localDay } from '../api';
import ItemRow from '../components/ItemRow';

// Calendar (§6): a presentation lens over the same backend — HAPPENs on their
// dates, DO deadlines, recurring occurrences. No separate store.

interface Entry {
  itemId: string;
  date: string;
  kind: string;
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
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  // "Today" is the sleep-cycle day (5am boundary): at 1am the highlight stays
  // on the evening's date. Cell placement stays wall-clock — it's a calendar.
  const [selected, setSelected] = useState(localDay());
  const [entries, setEntries] = useState<Entry[]>([]);
  const [items, setItems] = useState<Record<string, ItemView>>({});

  useEffect(() => {
    const from = new Date(month.getFullYear(), month.getMonth(), 1);
    const to = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    api
      .calendar(from.toISOString(), to.toISOString())
      .then((r) => {
        setEntries(r.entries);
        setItems(r.items);
      })
      .catch(console.error);
  }, [month, refreshKey]);

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

  const cells = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [month]);

  const today = localDay();
  const selectedEntries = byDay.get(selected) ?? [];

  return (
    <div>
      <div className="cal-head">
        <button className="icon-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
          ‹
        </button>
        <h3>{month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h3>
        <button className="icon-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
          ›
        </button>
      </div>
      <div className="cal-grid">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <div key={i} className="dow">
            {d}
          </div>
        ))}
        {cells.map((d) => {
          const k = dayKey(d);
          const dayEntries = byDay.get(k) ?? [];
          return (
            <button
              key={k}
              className={`cal-cell${d.getMonth() !== month.getMonth() ? ' other' : ''}${k === today ? ' today' : ''}${
                k === selected ? ' selected' : ''
              }`}
              onClick={() => setSelected(k)}
            >
              {d.getDate()}
              <span className="dots">
                {dayEntries.slice(0, 3).map((e, i) => (
                  <i key={i} style={{ background: items[e.itemId] ? itemColor(items[e.itemId]) : 'var(--text-faint)' }} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <div className="agenda">
        <h4>
          {new Date(`${selected}T12:00:00`).toLocaleDateString([], {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          })}
        </h4>
        {selectedEntries.length === 0 && <div className="hint">Nothing scheduled.</div>}
        {selectedEntries.map((e, i) => {
          const item = items[e.itemId];
          if (!item) return null;
          return (
            <div key={`${e.itemId}-${i}`} style={{ display: 'flex', alignItems: 'center' }}>
              <span className="time-chip">
                {e.kind === 'deadline'
                  ? 'due'
                  : new Date(e.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </span>
              <div style={{ flex: 1 }}>
                <ItemRow item={item} onOpen={onOpenItem} onToggleComplete={onToggleComplete} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
