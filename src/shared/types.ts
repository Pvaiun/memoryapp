// Core domain types for Memory.
// Backend types (§3) are functional and never shown to the user;
// flavour (§4) is the user-facing vocabulary, derived in flavour.ts.

export type BackendType = 'DO' | 'KNOW' | 'HAPPEN';

export type Flavour = 'Task' | 'Goal' | 'Reminder' | 'Event' | 'Note';

export type DeadlineHardness = 'hard' | 'soft';

export type Optionality = 'must' | 'nice';

export type Effort = 'quick' | 'medium' | 'large';

export type PriorityLevel = 'low' | 'medium' | 'high';

export type ItemStatus = 'active' | 'completed' | 'deleted';

// Shared RRULE-like core model (§3.1). Exotic rules deliberately parked (§14.1).
export interface Cadence {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number; // every N freq units, >= 1
  byWeekday?: number[]; // 0=Sun..6=Sat, for weekly
  byMonthDay?: number; // 1..31, for monthly
  // Optional anchor time-of-day, "HH:MM" 24h in the USER'S timezone. Recurring
  // DOs ping and render per-occurrence at this time (§11.4); occurrence math
  // goes through the atTime helpers in cadence.ts, which handle the tz shift.
  atTime?: string;
}

// One appended phrasing of an item. Recapture appends, never rewrites (§9.3).
export interface RawText {
  ts: string; // ISO timestamp
  text: string;
}

export interface Item {
  id: string;
  type: BackendType;
  title: string;
  rawTexts: RawText[];
  status: ItemStatus;

  // DO parameters (§3.1)
  deadline: string | null; // ISO date or datetime
  deadlineHardness: DeadlineHardness | null;
  cadence: Cadence | null;
  optionality: Optionality;
  effort: Effort;
  pingNatured: boolean; // Reminder derivation input (§4 rule 3)

  // HAPPEN parameters
  eventAt: string | null; // ISO datetime
  eventEnd: string | null;
  alertLeadMinutes: number | null; // per-event push lead override (§11.4)

  // Priority (§9.3): base + boosts with decay; user edit wins.
  priorityBase: number; // 0..1 (low .25 / medium .5 / high .75)
  priorityBoost: number; // accumulated recapture boost, decays over time
  boostUpdatedAt: string | null; // when boost was last touched (decay anchor)
  userPriority: number | null; // explicit user edit; takes precedence

  // Presentation-only flavour override (§4). Sparse; null for the common case.
  flavourOverride: Flavour | null;

  // Tier-1 deterministic aggregates (§7.2)
  createdAt: string;
  updatedAt: string;
  lastTouchedAt: string;
  lastCompletedAt: string | null;
  completionCount: number;
  streak: number;
  lastSurfacedAt: string | null; // rehearsal rotation input (§9.2)

  parseConfidence: number; // coarse 0..1 from Smart Capture (§10.1)
  themes: Theme[];
}

export interface Theme {
  id: string;
  name: string;
}

export interface Bubble {
  id: string;
  day: string; // YYYY-MM-DD the map was built for
  name: string;
  kind: 'situation' | 'rotation';
  prominence: number; // 0..1 — size on the map (§6)
  reason: string; // plain-prose rationale (stripped sentence) for tiles/sheet
  // The descent card's face (card design doc §1): one marked-up utterance —
  // **bold** entity/date tokens, [label](itemId) actionable chips. Parsed by
  // shared/cards.ts; empty string → the card falls back to `reason` as prose.
  sentence: string;
  // Nudge construction only (§3): the single first-step ledge action.
  firstStep: string | null;
  itemIds: string[];
}

export interface MapPayload {
  day: string;
  builtAt: string | null;
  stale: boolean; // true → client should trigger a rebuild (first open of day, §9.1)
  bubbles: Bubble[];
  capturedToday: string[]; // item ids in the deterministic Captured Today bucket (§9.1)
  items: Record<string, ItemView>;
}

// What the client renders for an item: the item plus derived fields.
export interface ItemView extends Item {
  flavour: Flavour;
  effectivePriority: number;
  neglected: boolean; // now − lastCompleted exceeds cadence (§7.2)
}

export type EventActor = 'user' | 'ai' | 'system';

export interface LogEvent {
  id: string;
  ts: string;
  actor: EventActor;
  type: string;
  itemId: string | null;
  bubbleId: string | null;
  payload: unknown; // before→after structured payload (§7.1)
}

// Smart Capture parse result for one segmented item (§10.2)
export interface ParsedItem {
  type: BackendType;
  title: string;
  deadlinePhrase: string | null;
  deadlineHardness: DeadlineHardness | null;
  cadence: Cadence | null;
  optionality: Optionality;
  effort: Effort;
  pingNatured: boolean;
  eventAtPhrase: string | null;
  alertLeadMinutes: number | null;
  priority: PriorityLevel;
  themes: string[]; // theme names — existing reused or new coined (§5)
  // Recapture-match (§10.3): id of the existing item this capture re-refers to.
  matchItemId: string | null;
}

export interface ParseResult {
  items: ParsedItem[];
  confidence: 'high' | 'low'; // coarse signal driving the review nudge (§10.1)
}

export interface CaptureResponse {
  captureId: string;
  rawText: string; // echoed for the review sheet
  created: ItemView[];
  boosted: { item: ItemView; appendedText: string }[]; // recapture merges, each undoable
  nudge: 'split' | 'low-confidence' | 'merge' | null;
}
