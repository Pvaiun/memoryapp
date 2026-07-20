import { useMemo } from 'react';
import type { Bubble, ItemView } from '../../shared/types';

// The map (§6) as a packed mosaic: rounded tiles stuck together, sized by
// prominence (area = the one scarce resource, §9.2). Status is an edge bar
// plus a chip printing the time word, readable without a legend:
// red = due now/overdue, amber = pressing this week, blue = upcoming event,
// neutral = standing, purple = rotation.
// Deterministic for identical input — the map never jiggles.

const DAY_MS = 86_400_000;

type Tone = 'red' | 'amber' | 'blue' | 'grey' | 'purple';

const TONE_COLORS: Record<Tone, string> = {
  red: 'hsl(348 75% 66%)', // due now / happening now
  amber: 'hsl(40 75% 62%)', // pressing
  blue: 'hsl(215 80% 68%)', // upcoming event
  grey: 'hsl(222 18% 62%)', // standing
  purple: 'hsl(260 30% 55%)', // rotation
};

interface TileStatus {
  tone: Tone;
  color: string;
  label: string;
}

// Calendar-day distance (local), so an event at 9am tomorrow says "tomorrow"
// even when it's under 24h away.
function calDayDiff(t: number, now: number): number {
  const a = new Date(t);
  const b = new Date(now);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}

function fmtEventDay(t: number, now: number): string {
  const d = new Date(t);
  if (calDayDiff(t, now) < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Status = tone + the time word printed on the chip, both from one scan of the
// bubble's ACTIVE items, so the scale needs no legend and completing the
// urgent item downgrades the tile immediately. Tone precedence is unchanged:
// red > amber > blue > grey.
function bubbleStatus(bubble: Bubble, items: Record<string, ItemView>): TileStatus {
  if (bubble.kind === 'rotation') return { tone: 'purple', color: TONE_COLORS.purple, label: 'rehearsal' };
  const now = Date.now();
  let overdue = false;
  let dueToday = false;
  let happeningNow = false;
  let redEventDiff = Infinity; // calendar-day distance of the nearest <48h event
  let soonestDue = Infinity;
  let slipped = false;
  let nextEvent = Infinity;
  for (const id of bubble.itemIds) {
    const it = items[id];
    if (!it || it.status === 'completed') continue;
    if (it.deadline) {
      const due = new Date(it.deadline).getTime();
      if (due < now) overdue = true;
      else if (due < now + DAY_MS) dueToday = true;
      else if (due < now + 7 * DAY_MS) soonestDue = Math.min(soonestDue, due);
    }
    if (it.neglected) slipped = true;
    if (it.eventAt) {
      const at = new Date(it.eventAt).getTime();
      const end = it.eventEnd ? new Date(it.eventEnd).getTime() : at;
      if (at < now + 2 * DAY_MS && end > now - DAY_MS) {
        if (at <= now) happeningNow = true;
        else redEventDiff = Math.min(redEventDiff, calDayDiff(at, now));
      } else if (at > now) nextEvent = Math.min(nextEvent, at);
    }
  }
  if (overdue || dueToday || happeningNow || redEventDiff < Infinity) {
    const label = overdue
      ? 'overdue'
      : happeningNow
        ? 'now'
        : dueToday
          ? 'due today'
          : redEventDiff <= 0
            ? 'today'
            : redEventDiff === 1
              ? 'tomorrow'
              : 'in 2 days';
    return { tone: 'red', color: TONE_COLORS.red, label };
  }
  if (soonestDue < Infinity) {
    const days = Math.max(2, Math.ceil((soonestDue - now) / DAY_MS));
    return { tone: 'amber', color: TONE_COLORS.amber, label: `${days} days` };
  }
  if (slipped) return { tone: 'amber', color: TONE_COLORS.amber, label: 'slipped' };
  if (bubble.prominence >= 0.7) return { tone: 'amber', color: TONE_COLORS.amber, label: 'pressing' };
  if (nextEvent < Infinity) return { tone: 'blue', color: TONE_COLORS.blue, label: fmtEventDay(nextEvent, now) };
  return { tone: 'grey', color: TONE_COLORS.grey, label: 'standing' };
}

// Greedy row packing: highest prominence first; a dominant bubble gets its own
// full-width row, smaller ones share a row (max 3) like bar segments.
function packRows(bubbles: Bubble[]): Bubble[][] {
  const sorted = [...bubbles].sort((a, b) => b.prominence - a.prominence);
  const rows: Bubble[][] = [];
  let cur: Bubble[] = [];
  let weight = 0;
  const flush = () => {
    if (cur.length) rows.push(cur);
    cur = [];
    weight = 0;
  };
  for (const b of sorted) {
    if (b.prominence >= 0.75) {
      flush();
      rows.push([b]);
      continue;
    }
    if (cur.length >= 3 || weight + b.prominence > 1.05) flush();
    cur.push(b);
    weight += b.prominence;
  }
  flush();
  return rows;
}

export default function BubbleMap({
  bubbles,
  items,
  onOpen,
}: {
  bubbles: Bubble[];
  items: Record<string, ItemView>;
  width?: number; // kept for call-site compatibility; layout is now fluid
  onOpen: (bubble: Bubble) => void;
}) {
  const rows = useMemo(() => packRows(bubbles), [bubbles]);
  if (!bubbles.length) return null;

  return (
    <div className="tile-map">
      {rows.map((row, ri) => {
        const rowWeight = row.reduce((s, b) => s + b.prominence, 0);
        const maxP = Math.max(...row.map((b) => b.prominence));
        // Height scales with the row's biggest tile: small dots stay compact,
        // today's loud thing is unmissable. Roomier now that cards describe
        // themselves.
        const height = Math.round(88 + maxP * 84);
        return (
          <div key={ri} className="tile-row" style={{ height }}>
            {row.map((bubble) => {
              const status = bubbleStatus(bubble, items);
              const doneCount = bubble.itemIds.filter((id) => items[id]?.status === 'completed').length;
              const total = bubble.itemIds.length;
              const allDone = total > 0 && doneCount === total;
              const fontSize = Math.max(13, Math.min(19, 12 + bubble.prominence * 8));
              // Urgency glow: reserved for genuinely loud bubbles (§9.2's
              // "large, loud" end of the prominence range).
              const hot = !allDone && bubble.kind !== 'rotation' && bubble.prominence >= 0.8;
              return (
                <button
                  key={bubble.id}
                  className={`tile bubble${bubble.kind === 'rotation' ? ' rotation' : ''}${hot ? ' hot' : ''}${allDone ? ' settled' : ''}`}
                  style={{
                    flexGrow: bubble.prominence / rowWeight,
                    flexBasis: 0,
                    ['--tile-accent' as string]: status.color,
                  }}
                  onClick={() => onOpen(bubble)}
                >
                  <span className="tile-top">
                    {allDone ? (
                      <span className="status-chip done">done</span>
                    ) : (
                      <span className={`status-chip${status.tone === 'red' ? ' filled' : ''}`}>{status.label}</span>
                    )}
                    <span className="tile-count">
                      {doneCount > 0 ? `${doneCount}/${total}` : `${total} item${total === 1 ? '' : 's'}`}
                    </span>
                  </span>
                  <span className="tile-name" style={{ fontSize }}>
                    {bubble.name}
                  </span>
                  {bubble.reason && !allDone && <span className="tile-desc">{bubble.reason}</span>}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
