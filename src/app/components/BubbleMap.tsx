import { useMemo } from 'react';
import type { Bubble, ItemView } from '../../shared/types';

// The map (§6) as a packed mosaic: rounded tiles stuck together, sized by
// prominence (area = the one scarce resource, §9.2). Edge colour is a status
// scale readable without a legend: red = due now/overdue, amber = pressing
// this week, blue = upcoming event, neutral = standing, purple = rotation.
// Deterministic for identical input — the map never jiggles.

const DAY_MS = 86_400_000;

function bubbleColor(bubble: Bubble, items: Record<string, ItemView>): string {
  if (bubble.kind === 'rotation') return 'hsl(260 30% 55%)';
  const now = Date.now();
  let urgent = false;
  let soon = false;
  let event = false;
  for (const id of bubble.itemIds) {
    const it = items[id];
    if (!it || it.status === 'completed') continue;
    if (it.deadline) {
      const due = new Date(it.deadline).getTime();
      if (due < now + DAY_MS) urgent = true;
      else if (due < now + 7 * DAY_MS) soon = true;
    }
    if (it.neglected) soon = true;
    if (it.eventAt) {
      const at = new Date(it.eventAt).getTime();
      const end = it.eventEnd ? new Date(it.eventEnd).getTime() : at;
      if (at < now + 2 * DAY_MS && end > now - DAY_MS) urgent = true;
      else if (at > now) event = true;
    }
  }
  if (urgent) return 'hsl(348 75% 66%)'; // due now / happening now
  if (soon || bubble.prominence >= 0.7) return 'hsl(40 75% 62%)'; // pressing
  if (event) return 'hsl(215 80% 68%)'; // upcoming event
  return 'hsl(222 18% 62%)'; // standing
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
              const color = bubbleColor(bubble, items);
              const doneCount = bubble.itemIds.filter((id) => items[id]?.status === 'completed').length;
              const total = bubble.itemIds.length;
              const allDone = total > 0 && doneCount === total;
              const fontSize = Math.max(13, Math.min(19, 12 + bubble.prominence * 8));
              // Urgency glow: reserved for genuinely loud bubbles (§9.2's
              // "large, loud" end of the prominence range).
              const hot = bubble.kind !== 'rotation' && bubble.prominence >= 0.8;
              return (
                <button
                  key={bubble.id}
                  className={`tile bubble${bubble.kind === 'rotation' ? ' rotation' : ''}${hot ? ' hot' : ''}`}
                  style={{
                    flexGrow: bubble.prominence / rowWeight,
                    flexBasis: 0,
                    ['--tile-accent' as string]: color,
                    opacity: allDone ? 0.35 : 1,
                  }}
                  onClick={() => onOpen(bubble)}
                >
                  <span className="tile-name" style={{ fontSize }}>
                    {bubble.name}
                  </span>
                  {bubble.reason && <span className="tile-desc">{bubble.reason}</span>}
                  <span className="tile-count">
                    {doneCount > 0 ? `${doneCount}/${total} done` : `${total} item${total === 1 ? '' : 's'}`}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
