import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bubble, ItemView, MapPayload } from '../../shared/types';
import { CAPTURED_BUBBLE_ID } from '../../shared/types';
import BubbleMap from '../components/BubbleMap';
import DescentView from '../components/descent/DescentView';
import ItemRow from '../components/ItemRow';

export type NowView = 'descent' | 'tiles';

// The card grammar (shared/cards.ts) reserves ** and []; a title carrying
// them would shatter the utterance, so they never reach the markup.
const safeToken = (title: string) => title.replace(/[*[\]]/g, '');

export default function MapView({
  map,
  nowView,
  onOpenItem,
  onToggleComplete,
  onOrganizeNow,
  onAddFirstStep,
}: {
  map: MapPayload;
  nowView: NowView;
  onOpenItem: (item: ItemView) => void;
  onToggleComplete: (item: ItemView) => void;
  onOrganizeNow: () => void;
  onAddFirstStep?: (bubbleId: string, title: string) => void;
}) {
  const [openBubble, setOpenBubble] = useState<Bubble | null>(null);

  const capturedItems = useMemo(
    () => map.capturedToday.map((id) => map.items[id]).filter(Boolean),
    [map.capturedToday, map.items],
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
      // One utterance from the bucket itself: every DO is a live chip,
      // everything else a bold token.
      sentence: capturedItems
        .map((it) => (it.type === 'DO' ? `[${safeToken(it.title)}](${it.id})` : `**${safeToken(it.title)}**`))
        .join('  '),
      firstStep: null,
      itemIds: map.capturedToday,
    };
  }, [capturedItems, map.capturedToday, map.day]);

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
      <h3>
        Captured today
        {capturedItems.length >= 5 && (
          <button className="organize-now" onClick={onOrganizeNow}>
            Organize now
          </button>
        )}
      </h3>
      {capturedItems.map((item) => (
        <ItemRow key={item.id} item={item} onOpen={onOpenItem} onToggleComplete={onToggleComplete} />
      ))}
    </div>
  );

  const bubbleSheet = openBubbleLive && (
    <div className="sheet-backdrop" onClick={() => setOpenBubble(null)}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grabber" />
        <h2>
          {openBubbleLive.name}
          {openBubbleLive.id === CAPTURED_BUBBLE_ID && capturedItems.length >= 5 && (
            <button className="organize-now" onClick={onOrganizeNow}>
              Organize now
            </button>
          )}
        </h2>
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
