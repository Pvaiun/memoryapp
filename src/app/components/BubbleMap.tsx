import { useMemo } from 'react';
import type { Bubble, ItemView } from '../../shared/types';
import { bubbleCounts, bubbleStatus } from './bubbleStatus';

// The map (§6) as a packed mosaic: rounded tiles stuck together, sized by
// prominence (area = the one scarce resource, §9.2). Status is an edge bar
// plus a chip printing the time word, readable without a legend:
// red = due now/overdue, amber = pressing this week, blue = upcoming event,
// neutral = standing, purple = rotation.
// Deterministic for identical input — the map never jiggles.

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
              const { doneCount, total, allDone } = bubbleCounts(bubble, items);
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
