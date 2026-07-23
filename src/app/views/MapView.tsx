import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bubble, ItemView, MapPayload } from '../../shared/types';
import { CAPTURED_BUBBLE_ID } from '../../shared/types';
import { describeAtTime, happeningToday } from '../../shared/cadence';
import BubbleMap from '../components/BubbleMap';
import DescentView from '../components/descent/DescentView';
import ItemRow from '../components/ItemRow';

export type NowView = 'descent' | 'tiles';

// The card grammar (shared/cards.ts) reserves ** and []; a title carrying
// them would shatter the utterance, so they never reach the markup.
const safeToken = (title: string) => title.replace(/[*[\]]/g, '');

// Brain-voice time of day: "9:30pm", "7pm" — the same phrasing the Brain
// weaves into its cards (shared/cadence describeAtTime), so a captured card
// reads in the Brain's register, not a widget's.
function brainTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  const hr = ((h + 11) % 12) + 1;
  return m ? `${hr}:${String(m).padStart(2, '0')}${ampm}` : `${hr}${ampm}`;
}

// The one moment a captured item is anchored to, if any: an event's start, a
// set rhythm's time, or a timed deadline. Date-only deadlines (stored at
// noon) carry no time; undated captures never reach this bucket.
function capturedDue(item: ItemView): string | null {
  if (item.type === 'HAPPEN' && item.eventAt) return brainTime(item.eventAt);
  if (item.cadence?.atTime) return describeAtTime(item.cadence.atTime);
  if (item.deadline && !item.deadline.includes('T12:00:00')) return brainTime(item.deadline);
  return null;
}

// Build the captured bubble's card sentence deterministically, in the same
// marked-up grammar the Brain uses (shared/cards.ts): each DO an actionable
// [chip](id), each fact/event a **bold** token, its due time woven in as
// "at **9:30pm**", the items joined as a plain-prose list. No Brain call —
// captures stay deterministic (§9.1) — but the card reads like every other.
function capturedSentence(items: ItemView[]): string {
  const parts = items.map((it) => {
    const token = it.type === 'DO' ? `[${safeToken(it.title)}](${it.id})` : `**${safeToken(it.title)}**`;
    const due = capturedDue(it);
    return due ? `${token} at **${due}**` : token;
  });
  if (parts.length <= 1) return `${parts[0] ?? ''}.`;
  if (parts.length === 2) return `${parts[0]}, and ${parts[1]}.`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}.`;
}

// The Now screen's slice of the §9.1 bucket: only captures that carry
// today's pressure surface here. Undated and future-dated captures stay in
// the bucket (Browse, review sheet) until the morning build files them.
// Shared with App.tsx so the layout class and the render agree.
export function capturedForToday(map: MapPayload): string[] {
  const now = new Date();
  const tz = -now.getTimezoneOffset();
  return map.capturedToday.filter((id) => {
    const it = map.items[id];
    return it && happeningToday(it, now, tz);
  });
}

export default function MapView({
  map,
  nowView,
  fallSpeed = 1,
  onOpenItem,
  onToggleComplete,
  onAddFirstStep,
}: {
  map: MapPayload;
  nowView: NowView;
  fallSpeed?: number;
  onOpenItem: (item: ItemView) => void;
  onToggleComplete: (item: ItemView) => void;
  onAddFirstStep?: (bubbleId: string, title: string) => void;
}) {
  const [openBubble, setOpenBubble] = useState<Bubble | null>(null);

  const capturedIds = useMemo(() => capturedForToday(map), [map]);
  const capturedItems = useMemo(
    () => capturedIds.map((id) => map.items[id]).filter(Boolean),
    [capturedIds, map.items],
  );

  // In the descent, Captured Today is not a fixed panel above the corridor —
  // it IS a bubble: a synthetic card that spawns when the first capture of
  // the day lands and dissolves when the morning build folds it away. It
  // rides at p=1.0 — the freshest, loudest thing — so a capture surfaces at
  // the top of the corridor instead of squeezing the viewport (§9.1).
  const capturedBubble: Bubble | null = useMemo(() => {
    if (!capturedItems.length) return null;
    return {
      id: CAPTURED_BUBBLE_ID,
      day: map.day,
      name: 'Captured today',
      kind: 'situation',
      prominence: 1,
      reason: 'Fresh captures, kept losslessly until the morning build folds them into real bubbles.',
      // One utterance in the Brain's own card grammar — chips, bold tokens,
      // due times woven in — so the captured card reads like every other.
      sentence: capturedSentence(capturedItems),
      firstStep: null,
      itemIds: capturedIds,
    };
  }, [capturedItems, capturedIds, map.day]);

  // Spawn signal: bumps when a capture is added, so the corridor can dolly
  // up to the captured bubble and show the new chip land.
  const [spawnNonce, setSpawnNonce] = useState(0);
  const prevCountRef = useRef(capturedItems.length);
  useEffect(() => {
    if (capturedItems.length > prevCountRef.current) setSpawnNonce((n) => n + 1);
    prevCountRef.current = capturedItems.length;
  }, [capturedItems.length]);

  // Keep the open bubble's view fresh as items complete. The synthetic
  // captured bubble resolves against its freshly-built self.
  const openBubbleLive = openBubble
    ? openBubble.id === CAPTURED_BUBBLE_ID
      ? capturedBubble
      : map.bubbles.find((b) => b.id === openBubble.id) ?? openBubble
    : null;

  const descent = nowView === 'descent' && (map.bubbles.length > 0 || capturedBubble !== null);

  const descentBubbles = useMemo(
    () => (capturedBubble ? [capturedBubble, ...map.bubbles] : map.bubbles),
    [capturedBubble, map.bubbles],
  );

  const capturedBlock = capturedItems.length > 0 && (
    <div className="captured-today">
      <h3>Captured today</h3>
      {capturedItems.map((item) => (
        <ItemRow key={item.id} item={item} onOpen={onOpenItem} onToggleComplete={onToggleComplete} />
      ))}
    </div>
  );

  const bubbleSheet = openBubbleLive && (
    <div className="sheet-backdrop" onClick={() => setOpenBubble(null)}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grabber" />
        <h2>{openBubbleLive.name}</h2>
        {openBubbleLive.reason && <p className="reason">{openBubbleLive.reason}</p>}
        {openBubbleLive.itemIds
          .map((id) => map.items[id])
          .filter(Boolean)
          .map((item) => (
            <ItemRow key={item.id} item={item} onOpen={onOpenItem} onToggleComplete={onToggleComplete} />
          ))}
      </div>
    </div>
  );

  if (descent) {
    return (
      <div className="descent-wrap">
        <DescentView
          bubbles={descentBubbles}
          items={map.items}
          day={map.day}
          builtAt={map.builtAt}
          capturedSpawnNonce={spawnNonce}
          attentionId={openBubble?.id ?? null}
          fallSpeed={fallSpeed}
          onOpen={setOpenBubble}
          onToggleComplete={onToggleComplete}
          onAddFirstStep={onAddFirstStep}
        />
        {bubbleSheet}
      </div>
    );
  }

  return (
    <div>
      {capturedBlock}

      {map.bubbles.length === 0 && capturedItems.length === 0 ? (
        <div className="map-empty">
          <p style={{ fontSize: 40, marginBottom: 12 }}>🫧</p>
          <p>
            Nothing here yet. Capture anything below — a task, a fact, an event — and the map will build itself each
            morning.
          </p>
        </div>
      ) : (
        <BubbleMap bubbles={map.bubbles} items={map.items} onOpen={setOpenBubble} />
      )}

      {bubbleSheet}
    </div>
  );
}
