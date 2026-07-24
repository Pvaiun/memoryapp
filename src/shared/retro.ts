// Map retrospective — the deterministic scoring core (§7.1, §8.3).
//
// Pure: given the bubbles a day's map showed and the state-change events that
// landed on that same sleep-cycle day, decide what the map got right and what
// it missed. No DB, no AI, no clock — same data in → same verdict out, so the
// worker can compute it and a test can pin it. The worker half (retro.ts)
// only does the loading and the day-boundary math; the judgment lives here.

import type { RetroBubble, RetroMiss } from './types';

// The Tier-0 event types that count as the user *acting on* an item, split into
// the one that means "handled" (completed) and the rest that mean "engaged".
export const COMPLETION_EVENTS = new Set(['completed']);
export const TOUCH_EVENTS = new Set(['edited', 're_themed', 'first_step_added', 'dismissed', 'missed']);

export interface RetroBubbleInput {
  id: string;
  name: string;
  kind: 'situation' | 'rotation';
  prominence: number;
  reason: string;
  itemIds: string[];
}

export interface RetroScore {
  bubbles: RetroBubble[];
  misses: RetroMiss[];
  totals: {
    bubbles: number;
    engagedBubbles: number;
    completedFromMap: number;
    completedOffMap: number;
    capturedThatDay: number;
  };
}

// `completed` / `touched` are the item-id sets for the day (a recurring DO that
// never reaches status='completed' still lands here via its completed *event*,
// which is exactly right — the retro asks "did the user act on it today").
// `createdThatDay` marks Captured-Today items so a same-day completion the map
// hadn't folded in yet reads as a fair miss, not a burial.
export function scoreRetro(
  bubbles: RetroBubbleInput[],
  completed: Set<string>,
  touched: Set<string>,
  createdThatDay: Set<string>,
  capturedThatDay: number,
): RetroScore {
  const inMap = new Set<string>();
  for (const b of bubbles) for (const id of b.itemIds) inMap.add(id);

  const scored: RetroBubble[] = bubbles.map((b) => {
    const completedItemIds = b.itemIds.filter((id) => completed.has(id));
    const touchedItemIds = b.itemIds.filter((id) => touched.has(id) && !completed.has(id));
    return {
      id: b.id,
      name: b.name,
      kind: b.kind,
      prominence: b.prominence,
      reason: b.reason,
      itemIds: b.itemIds,
      completedItemIds,
      touchedItemIds,
      engaged: completedItemIds.length > 0 || touchedItemIds.length > 0,
    };
  });

  // Misses: an item completed that day that no bubble held. Sorted so the
  // burials (older items the Brain had and dropped) lead over the fair,
  // fresh Captured-Today misses.
  const misses: RetroMiss[] = [...completed]
    .filter((id) => !inMap.has(id))
    .map((id) => ({ itemId: id, fresh: createdThatDay.has(id) }))
    .sort((a, b) => Number(a.fresh) - Number(b.fresh) || (a.itemId < b.itemId ? -1 : 1));

  const completedOffMap = misses.filter((m) => !m.fresh).length;
  const completedFromMap = [...completed].filter((id) => inMap.has(id)).length;

  return {
    bubbles: scored,
    misses,
    totals: {
      bubbles: bubbles.length,
      engagedBubbles: scored.filter((b) => b.engaged).length,
      completedFromMap,
      completedOffMap,
      capturedThatDay,
    },
  };
}
