import { useState } from 'react';
import type { Bubble, ItemView, MapPayload } from '../../shared/types';
import BubbleMap from '../components/BubbleMap';
import DescentView from '../components/descent/DescentView';
import ItemRow from '../components/ItemRow';

export type NowView = 'descent' | 'tiles';

export default function MapView({
  map,
  nowView,
  onOpenItem,
  onToggleComplete,
  onOrganizeNow,
}: {
  map: MapPayload;
  nowView: NowView;
  onOpenItem: (item: ItemView) => void;
  onToggleComplete: (item: ItemView) => void;
  onOrganizeNow: () => void;
}) {
  const [openBubble, setOpenBubble] = useState<Bubble | null>(null);

  const capturedItems = map.capturedToday.map((id) => map.items[id]).filter(Boolean);
  // Keep the open bubble's view fresh as items complete.
  const openBubbleLive = openBubble ? map.bubbles.find((b) => b.id === openBubble.id) ?? openBubble : null;

  const descent = nowView === 'descent' && map.bubbles.length > 0;

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
        {capturedBlock}
        <DescentView
          bubbles={map.bubbles}
          items={map.items}
          day={map.day}
          builtAt={map.builtAt}
          onOpen={setOpenBubble}
          onToggleComplete={onToggleComplete}
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
