import { useMemo } from 'react';
import type { Bubble, ItemView } from '../../shared/types';
import { themeColor } from '../api';

// The map (§6) as a packed mosaic: rounded tiles stuck together, sized by
// prominence (area = the one scarce resource, §9.2), coloured by theme.
// Deterministic for identical input — the map never jiggles.

function bubbleColor(bubble: Bubble, items: Record<string, ItemView>): string {
  if (bubble.kind === 'rotation') return 'hsl(260 25% 40%)';
  const counts = new Map<string, number>();
  for (const id of bubble.itemIds) {
    for (const t of items[id]?.themes ?? []) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [name, count] of counts) {
    if (count > n) {
      best = name;
      n = count;
    }
  }
  return best ? themeColor(best) : 'hsl(220 15% 55%)';
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
        // today's loud thing is unmissable.
        const height = Math.round(58 + maxP * 96);
        return (
          <div key={ri} className="tile-row" style={{ height }}>
            {row.map((bubble) => {
              const color = bubbleColor(bubble, items);
              const doneCount = bubble.itemIds.filter((id) => items[id]?.status === 'completed').length;
              const total = bubble.itemIds.length;
              const allDone = total > 0 && doneCount === total;
              const fontSize = Math.max(13, Math.min(19, 12 + bubble.prominence * 8));
              return (
                <button
                  key={bubble.id}
                  className={`tile bubble${bubble.kind === 'rotation' ? ' rotation' : ''}`}
                  style={{
                    flexGrow: bubble.prominence / rowWeight,
                    flexBasis: 0,
                    background: bubble.kind === 'rotation' ? 'transparent' : color,
                    borderColor: color,
                    opacity: allDone ? 0.35 : 1,
                  }}
                  onClick={() => onOpen(bubble)}
                >
                  <span className="tile-name" style={{ fontSize }}>
                    {bubble.name}
                  </span>
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
