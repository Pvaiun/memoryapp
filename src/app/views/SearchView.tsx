import { useEffect, useRef, useState } from 'react';
import type { ItemView } from '../../shared/types';
import { isClosedStatus } from '../../shared/types';
import { api } from '../api';
import ItemRow from '../components/ItemRow';

// Smart Search (§6): deterministic and always-available — the reliable find
// path. Hybrid keyword + semantic; "Sarah's food thing" finds the nut allergy.

export default function SearchView({
  onOpenItem,
  onToggleComplete,
}: {
  onOpenItem: (item: ItemView) => void;
  onToggleComplete: (item: ItemView) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ itemIds: string[]; items: Record<string, ItemView> } | null>(null);
  const [searching, setSearching] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(timer.current);
    if (!q.trim()) {
      setResults(null);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(async () => {
      try {
        setResults(await api.search(q));
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer.current);
  }, [q]);

  return (
    <div>
      <div className="search-bar">
        <input
          autoFocus
          placeholder="Find anything…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {!q.trim() && (
        <div className="hint">
          Search matches exact words and gist.
        </div>
      )}
      {results && q.trim() && (() => {
        // Closed items (completed, dismissed, passed, missed) are opt-in,
        // behind the same subtle reveal as Browse — the reliable find path
        // surfaces what's live first, but the record stays one tap away.
        const open = results.itemIds.filter((id) => !isClosedStatus(results.items[id].status));
        const past = results.itemIds.filter((id) => isClosedStatus(results.items[id].status));
        return (
          <div className="section-card">
            {results.itemIds.length === 0 && !searching && <div className="hint">No matches.</div>}
            {open.map((id) => (
              <ItemRow key={id} item={results.items[id]} onOpen={onOpenItem} onToggleComplete={onToggleComplete} />
            ))}
            {showPast && past.map((id) => (
              <ItemRow key={id} item={results.items[id]} onOpen={onOpenItem} onToggleComplete={onToggleComplete} />
            ))}
            {past.length > 0 && (
              <button className="done-foot" onClick={() => setShowPast(!showPast)}>
                {showPast
                  ? 'Hide past items'
                  : `${past.length} past item${past.length === 1 ? '' : 's'} hidden · show`}
              </button>
            )}
          </div>
        );
      })()}
    </div>
  );
}
