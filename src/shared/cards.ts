// Descent cards (card design doc §1-§6): the presentation lens over a bubble.
// The Brain writes one marked-up sentence per bubble; everything else on the
// card — construction, bricks, far form, theme accent — is derived here,
// mechanically, from the cluster's shape. Shared between worker (alias
// resolution, plain-text stripping) and client (rendering).
//
// Sentence markup, the card grammar:
//   **text**        bold entity/date token — survives depth cropping
//   [label](id)     actionable chip bound to a DO item — tappable checkbox
// Nothing else. If a card can't be said in this grammar, the cluster is wrong.

import type { ItemView } from './types';
import { sleepDayDiffLocal } from './dates';

export type CardSegment =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'chip'; text: string; itemId: string };

const TOKEN_RE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseSentence(sentence: string): CardSegment[] {
  const out: CardSegment[] = [];
  let last = 0;
  for (const m of sentence.matchAll(TOKEN_RE)) {
    if (m.index! > last) out.push({ kind: 'text', text: sentence.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'bold', text: m[1] });
    // The grammar has no nesting, but models write [Ask **Kyle**](i9) anyway —
    // the markers must never reach the screen.
    else out.push({ kind: 'chip', text: m[2].replace(/\*\*/g, ''), itemId: m[3] });
    last = m.index! + m[0].length;
  }
  if (last < sentence.length) out.push({ kind: 'text', text: sentence.slice(last) });
  return out;
}

// Chip guarantee (§7: chips act where they are read): every member DO is
// completable from the card even when the prose forgot to chip it — unchipped
// DOs append as bare chips after the utterance. The prompt asks for chips;
// the renderer guarantees them. Completed DOs append too, so a card stays
// stable (checkable ✓, un-checkable) across completion. Callers skip rotation
// bubbles — those are chip-free by design.
export function withMemberChips(segments: CardSegment[], members: ItemView[]): CardSegment[] {
  const chipped = new Set(segments.filter((s) => s.kind === 'chip').map((s) => s.itemId));
  const missing = members.filter(
    (m) => m.type === 'DO' && !chipped.has(m.id) && (m.status === 'active' || m.status === 'completed'),
  );
  if (!missing.length) return segments;
  return [
    ...segments,
    ...missing.flatMap((m): CardSegment[] => [
      { kind: 'text', text: ' ' },
      { kind: 'chip', text: m.title, itemId: m.id },
    ]),
  ];
}

// Plain prose — for the sheet, tiles, and anywhere the markup mustn't leak.
export function stripSentence(sentence: string): string {
  return parseSentence(sentence)
    .map((s) => s.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

// The far form (§6): only the recognizable nouns survive distance.
export function farTokens(segments: CardSegment[]): string[] {
  return segments.filter((s) => s.kind !== 'text').map((s) => s.text.trim());
}

// Worker-side hygiene over the Brain's raw output: chip refs are short
// aliases (i3) — resolve them to real item ids; a chip whose alias is
// unknown or points outside the bubble degrades to a bold token, never
// breaks prose. Chip count is the Brain's call (completing from the card
// is the point); maxChips exists for callers that want a ceiling.
export function resolveSentence(
  sentence: string,
  idByAlias: Map<string, string>,
  memberIds: Set<string>,
  maxChips = Infinity,
): string {
  let chips = 0;
  return sentence.replace(TOKEN_RE, (whole, bold: string | undefined, label: string, ref: string) => {
    if (bold !== undefined) return whole;
    const id = idByAlias.get(ref.trim()) ?? (memberIds.has(ref.trim()) ? ref.trim() : undefined);
    if (!id || !memberIds.has(id) || chips >= maxChips) return `**${label}**`;
    chips += 1;
    return `[${label}](${id})`;
  });
}

// ---------- constructions (§3): chosen by cluster shape, never by topic ----------

export type CardConstruction = 'woven' | 'batch' | 'nudge';

export function deriveConstruction(items: ItemView[], firstStep: string | null): CardConstruction {
  if (items.length >= 4) {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.type, (counts.get(it.type) ?? 0) + 1);
    const dominant = Math.max(...counts.values());
    if (dominant / items.length >= 0.75) return 'batch';
  }
  if (items.length === 1) {
    const it = items[0];
    const undated = !it.deadline && !it.eventAt;
    if (undated && (it.effort === 'large' || firstStep !== null)) return 'nudge';
  }
  return 'woven';
}

// ---------- bricks (§4): physical features, derived from the members ----------

// Span rail: a duration track for anything occupying a range of time.
// Union of the bubble's multi-day event spans; frac is today's position.
export interface SpanRailBrick {
  startMs: number;
  endMs: number;
  todayFrac: number; // 0..1 along the rail
}

export function deriveSpanRail(items: ItemView[], now: number): SpanRailBrick | null {
  let start = Infinity;
  let end = -Infinity;
  for (const it of items) {
    if (it.status !== 'active' || !it.eventAt || !it.eventEnd) continue;
    const a = new Date(it.eventAt).getTime();
    const b = new Date(it.eventEnd).getTime();
    if (b - a < 20 * 3_600_000) continue; // a range of days, not an afternoon
    start = Math.min(start, a);
    end = Math.max(end, b);
  }
  if (!isFinite(start) || end <= start) return null;
  return { startMs: start, endMs: end, todayFrac: clamp01((now - start) / (end - start)) };
}

// Deadline notch: a corner countdown for the nearest HARD date.
export interface DeadlineNotchBrick {
  days: number; // sleep-cycle days from today (5am boundary); negative = overdue
  label: string;
}

export function deriveDeadlineNotch(items: ItemView[], now: number): DeadlineNotchBrick | null {
  let nearest = Infinity;
  for (const it of items) {
    if (it.status !== 'active' || !it.deadline || it.deadlineHardness !== 'hard') continue;
    nearest = Math.min(nearest, new Date(it.deadline).getTime());
  }
  if (!isFinite(nearest)) return null;
  const days = sleepDayDiffLocal(nearest, now);
  if (days > 30) return null; // too far to be glanceable pressure
  const label = days < 0 ? 'overdue' : days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
  return { days, label };
}

// Theme accent (§5): the card wears its anchor item's theme — fallback,
// the majority theme of members. Ties resolve toward the bubble's item
// order, so the same cluster wears the same hue every morning.
export function anchorThemeName(items: ItemView[]): string | null {
  const counts = new Map<string, number>();
  for (const it of items) {
    const name = it.themes[0]?.name;
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const it of items) {
    const name = it.themes[0]?.name;
    if (!name) continue;
    const n = counts.get(name)!;
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  return best;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
