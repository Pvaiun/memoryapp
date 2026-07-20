import { useState } from 'react';
import type { Bubble, ItemView, MapPayload } from '../../shared/types';
import BubbleMap from '../components/BubbleMap';
import ItemRow from '../components/ItemRow';

export default function MapView({
  map,
  onOpenItem,
  onToggleComplete,
}: {
  map: MapPayload;
  onOpenItem: (item: ItemView) => void;
  onToggleComplete: (item: ItemView) => void;
}) {
  const [openBubble, setOpenBubble] = useState<Bubble | null>(null);

  const capturedItems = map.capturedToday.map((id) => map.items[id]).filter(Boolean);
  // Keep the open bubble's view fresh as items complete.
  const openBubbleLive = openBubble ? map.bubbles.find((b) => b.id === openBubble.id) ?? openBubble : null;

  return (
    <div>
      {capturedItems.length > 0 && (
        <div className="captured-today">
          <h3>Captured today</h3>
          {capturedItems.map((item) => (
            <ItemRow key={item.id} item={item} onOpen={onOpenItem} onToggleComplete={onToggleComplete} />
          ))}
        </div>
      )}

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

      {openBubbleLive && (
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
      )}
    </div>
  );
}
