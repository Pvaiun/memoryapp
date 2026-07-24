// Core domain types for Memory.
// Backend types (§3) are functional and never shown to the user;
// flavour (§4) is the user-facing vocabulary, derived in flavour.ts.

export type BackendType = 'DO' | 'KNOW' | 'HAPPEN';

export type Flavour = 'Task' | 'Goal' | 'Reminder' | 'Event' | 'Note';

export type DeadlineHardness = 'hard' | 'soft';

export type Optionality = 'must' | 'nice';

export type Effort = 'quick' | 'medium' | 'large';

export type PriorityLevel = 'low' | 'medium' | 'high';

// Lifecycle (§7): 'completed' is the one positive terminal for every flavour
// (labelled per flavour in the UI — Done / Achieved / Got it). 'dismissed' is
// the user saying a thing stopped mattering. 'passed' is system-asserted on
// one-shot events whose moment elapsed — it claims nothing about the user;
// 'missed' is the user's explicit "didn't make it" on such an event.
// 'deleted' is pure hygiene (a mis-parse, a duplicate) and carries no meaning.
export type ItemStatus = 'active' | 'completed' | 'dismissed' | 'passed' | 'missed' | 'deleted';

// Every non-hygiene exit: the item's lifecycle has ended but it remains part
// of the user's record (searchable, browsable under "past").
export const CLOSED_STATUSES = ['completed', 'dismissed', 'passed', 'missed'] as const;

export function isClosedStatus(status: string): boolean {
  return (CLOSED_STATUSES as readonly string[]).includes(status);
}

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

// Affect (§10): the emotional colour the user's own phrasing carried at
// capture. A closed vocabulary so history stays countable across recaptures —
// "forgotten" twice is a fact no single capture contains. Extracted by Smart
// Capture, user-editable in the item sheet, read by the Brain as data only.
export const AFFECT_TAGS = [
  'nervous',
  'dreading',
  'excited',
  'someday',
  'for-someone',
  'guilty',
  'forgotten',
  'important',
  'heavy',
] as const;
export type AffectTag = (typeof AFFECT_TAGS)[number];

export interface AffectEntry {
  tag: AffectTag;
  ts: string; // ISO timestamp of the capture that carried it
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

  // Whether a RECURRING item earns calendar presence (§6). One-offs always
  // paint their dates; this gates cadence occurrences only — a bi-weekly
  // therapy session belongs on the calendar, nightly dishwasher duty is
  // ambient routine that would bury it. Parser-set at capture, user override
  // in the item sheet wins.
  showOnCalendar: boolean;

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
  affects: AffectEntry[]; // affect history, appended per capture/recapture
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
  // Nudge construction only (§3): the Brain's break-it-down invitation. The
  // user's answer becomes a real item on the card, and this clears to null.
  firstStep: string | null;
  itemIds: string[];
}

// Client-side presentation id for the synthetic "Captured today" bubble the
// descent view builds over the §9.1 bucket. Never a real (server) bubble id.
export const CAPTURED_BUBBLE_ID = '__captured-today__';

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
  // Completed within the user-local sleep-cycle day (5am boundary, same as
  // localDay). A recurring DO never reaches status='completed', so this is
  // what its checkbox renders from — done for today, re-armed when the user
  // wakes into the next day.
  doneToday: boolean;
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

// ---------- Map retrospective (the Brain's conscience) ----------
// A read-only, fully deterministic look back at how a past day's map actually
// fared — derived only from the state-change events already in the Tier-0 log
// (§7.1), never new behavioural telemetry (which stays parked, §7.1/§11.6).
// It is the missing other half of the Brain workshop: the workshop lets you
// tune the Brain by hand; this tells you whether the maps it built were any
// good — the failure signals the no-override bet (§8.3) is meant to keep visible.

export interface RetroBubble {
  id: string;
  name: string;
  kind: 'situation' | 'rotation';
  prominence: number;
  reason: string;
  itemIds: string[]; // members the map showed that day
  completedItemIds: string[]; // members with a 'completed' event that day
  touchedItemIds: string[]; // members otherwise acted on that day (edited / re-themed / first-step / dismissed / missed)
  engaged: boolean; // any member acted on at all — did this grouping earn its slot?
}

// A completion that day for an item the map showed in NO bubble. `fresh` marks
// a Captured-Today item (created that day, not yet folded in — a fair miss)
// versus an older item the Brain had and buried (the signal worth reading).
export interface RetroMiss {
  itemId: string;
  fresh: boolean;
}

export interface RetroPayload {
  day: string; // the sleep-cycle day looked back on (YYYY-MM-DD)
  hasMap: boolean; // whether a map was actually built for this day
  builtAt: string | null;
  prevDay: string | null; // nearest earlier day with a map (for the stepper)
  nextDay: string | null; // nearest later day with a map
  bubbles: RetroBubble[]; // prominence-ordered, as shown
  misses: RetroMiss[]; // completions the map didn't surface
  totals: {
    bubbles: number;
    engagedBubbles: number;
    completedFromMap: number; // distinct items completed that a bubble held
    completedOffMap: number; // distinct items completed that no bubble held (older only)
    capturedThatDay: number; // items created that day
  };
  items: Record<string, ItemView>; // titles / flavour for everything referenced
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
  affect: AffectTag[]; // 0-2 tags; the phrasing's emotional colour, usually []
  // For recurring items: does this recurrence belong on the calendar
  // (commitment/appointment) or is it ambient routine (chore/habit)?
  // Meaningless (always true) for one-offs.
  calendarWorthy: boolean;
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
