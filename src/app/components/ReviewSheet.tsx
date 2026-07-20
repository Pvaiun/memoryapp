import type { CaptureResponse, ItemView } from '../../shared/types';
import ItemRow from './ItemRow';

// Mandatory review (user decision, superseding §10.1's nudge-only review):
// every capture ends here. Items are ALREADY created — this is a look at what
// was filed, with every inferred field one tap from fixable. Dismissing
// accepts everything as-is, so the flow stays one-tap for clean captures.

export default function ReviewSheet({
  response,
  items,
  onOpenItem,
  onToggleComplete,
  onUndoBoost,
  onClose,
}: {
  response: CaptureResponse;
  items: Record<string, ItemView>;
  onOpenItem: (item: ItemView) => void;
  onToggleComplete: (item: ItemView) => void;
  onUndoBoost: (itemId: string, appendedText: string) => void;
  onClose: () => void;
}) {
  const created = response.created.map((c) => items[c.id]).filter(Boolean);
  const boosted = response.boosted.filter((b) => items[b.item.id]);
  const total = created.length + boosted.length;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grabber" />
        <h2>{total > 1 ? `Filed as ${total} things` : 'Filed'}</h2>
        {response.nudge === 'low-confidence' && (
          <p className="reason">Some details were a guess — worth a glance below.</p>
        )}
        {created.map((item) => (
          <ItemRow key={item.id} item={item} onOpen={onOpenItem} onToggleComplete={onToggleComplete} />
        ))}
        {boosted.map((b) => (
          <div key={`${b.item.id}-${b.appendedText}`} className="boost-entry">
            <ItemRow
              item={items[b.item.id]}
              onOpen={onOpenItem}
              onToggleComplete={onToggleComplete}
            />
            <div className="boost-note">
              Matched something you already have — bumped its priority instead of duplicating.
              <button onClick={() => onUndoBoost(b.item.id, b.appendedText)}>Undo — make it separate</button>
            </div>
          </div>
        ))}
        <div className="sheet-actions">
          <button className="primary" onClick={onClose}>
            Looks good
          </button>
        </div>
        <p className="raw-capture">“{response.rawText}”</p>
      </div>
    </div>
  );
}
