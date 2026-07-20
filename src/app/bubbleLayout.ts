// Deterministic bubble layout: greedy spiral placement, largest first.
// Size = prominence, the map's one scarce resource (§9.2). No physics library —
// placement must be stable for identical input so the map never jiggles.

export interface LayoutBubble {
  id: string;
  prominence: number; // 0..1
}

export interface PlacedBubble extends LayoutBubble {
  x: number;
  y: number;
  r: number;
}

export function layoutBubbles(bubbles: LayoutBubble[], width: number): {
  placed: PlacedBubble[];
  height: number;
} {
  if (!bubbles.length) return { placed: [], height: 0 };

  const minR = Math.max(34, width * 0.09);
  const maxR = Math.min(width * 0.32, 150);
  const sized = bubbles
    .map((b) => ({ ...b, r: minR + Math.sqrt(clamp01(b.prominence)) * (maxR - minR) }))
    .sort((a, b) => b.r - a.r);

  const placed: PlacedBubble[] = [];
  const cx = width / 2;
  const pad = 8;

  for (const b of sized) {
    if (!placed.length) {
      placed.push({ ...b, x: cx, y: b.r + pad });
      continue;
    }
    // Walk a spiral from the current cluster centroid until collision-free.
    const centroidY =
      placed.reduce((s, p) => s + p.y, 0) / placed.length;
    let best: { x: number; y: number } | null = null;
    for (let t = 0; t < 2000 && !best; t += 1) {
      const angle = t * 0.35;
      const dist = 4 + t * 1.9;
      const x = cx + Math.cos(angle) * dist;
      const y = centroidY + Math.sin(angle) * dist * 0.9;
      if (x - b.r < pad || x + b.r > width - pad || y - b.r < pad) continue;
      let ok = true;
      for (const p of placed) {
        const dx = p.x - x;
        const dy = p.y - y;
        if (dx * dx + dy * dy < (p.r + b.r + pad) * (p.r + b.r + pad)) {
          ok = false;
          break;
        }
      }
      if (ok) best = { x, y };
    }
    if (!best) {
      // Fallback: below everything.
      const bottom = Math.max(...placed.map((p) => p.y + p.r));
      best = { x: cx, y: bottom + b.r + pad };
    }
    placed.push({ ...b, x: best.x, y: best.y });
  }

  const height = Math.max(...placed.map((p) => p.y + p.r)) + pad * 2;
  return { placed, height };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
