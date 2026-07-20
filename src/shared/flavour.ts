import type { Flavour, Item } from './types';

// Flavour derivation (§4) — first match wins. Derived, never stored;
// a stored user override (presentation-only) wins over the derived value.
export function deriveFlavour(item: Pick<Item, 'type' | 'pingNatured' | 'deadline' | 'deadlineHardness' | 'cadence' | 'flavourOverride'>): Flavour {
  if (item.flavourOverride) return item.flavourOverride;
  if (item.type === 'KNOW') return 'Note';
  if (item.type === 'HAPPEN') return 'Event';
  // DO:
  if (item.pingNatured) return 'Reminder'; // checked before deadline (§4 rule 3)
  if (item.deadline && item.deadlineHardness === 'hard') return 'Task';
  if (item.cadence) return 'Goal'; // cadence and no hard deadline
  return 'Task'; // default DO flavour
}

export const FLAVOURS: Flavour[] = ['Task', 'Goal', 'Reminder', 'Event', 'Note'];
