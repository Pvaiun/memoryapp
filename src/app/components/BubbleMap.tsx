import { useMemo } from 'react';
import type { Bubble, ItemView } from '../../shared/types';
import { layoutBubbles } from '../bubbleLayout';
import { themeColor } from '../api';

// The bubble map (§6): size = prominence, colour = theme. Two channels, nothing else.

function bubbleColor(bubble: Bubble, items: Record<string, ItemView>): string {
  if (bubble.kind === 'rotation') return 'hsl(260 30% 60%)';
  // Dominant theme across member items.
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

function wrapName(name: string, r: number): string[] {
  const maxChars = Math.max(6, Math.floor(r / 4.2));
  const words = name.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

export default function BubbleMap({
  bubbles,
  items,
  width,
  onOpen,
}: {
  bubbles: Bubble[];
  items: Record<string, ItemView>;
  width: number;
  onOpen: (bubble: Bubble) => void;
}) {
  const { placed, height } = useMemo(
    () => layoutBubbles(bubbles.map((b) => ({ id: b.id, prominence: b.prominence })), width),
    [bubbles, width],
  );
  const byId = useMemo(() => new Map(bubbles.map((b) => [b.id, b])), [bubbles]);

  if (!bubbles.length) return null;

  return (
    <svg className="bubble-map" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {placed.map((p) => {
        const bubble = byId.get(p.id)!;
        const color = bubbleColor(bubble, items);
        const doneCount = bubble.itemIds.filter((id) => items[id]?.status === 'completed').length;
        const total = bubble.itemIds.length;
        const allDone = total > 0 && doneCount === total;
        const lines = wrapName(bubble.name, p.r);
        const fontSize = Math.max(11, Math.min(17, p.r / 3.6));
        return (
          <g
            key={p.id}
            className="bubble"
            opacity={allDone ? 0.35 : 1}
            onClick={() => onOpen(bubble)}
          >
            <circle cx={p.x} cy={p.y} r={p.r} fill={color} opacity={0.88} />
            <circle cx={p.x} cy={p.y} r={p.r} fill="none" stroke={color} strokeOpacity={0.5} strokeWidth={1.5} />
            {lines.map((line, i) => (
              <text
                key={i}
                x={p.x}
                y={p.y + (i - (lines.length - 1) / 2) * (fontSize + 2)}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={fontSize}
              >
                {line}
              </text>
            ))}
            <text
              x={p.x}
              y={p.y + (lines.length / 2) * (fontSize + 2) + fontSize * 0.9}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={Math.max(10, fontSize - 4)}
              opacity={0.75}
            >
              {doneCount > 0 ? `${doneCount}/${total} done` : `${total} item${total === 1 ? '' : 's'}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
