import { useEffect, useRef, useState } from 'react';
import type { ItemView } from '../../shared/types';
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
          placeholder="Find anything… (“Sarah's food thing”)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {!q.trim() && (
        <div className="hint">
          Search matches exact words and gist — you usually remember the shape of a thing, not its words.
        </div>
      )}
      {results && q.trim() && (
        <div className="section-card">
          {results.itemIds.length === 0 && !searching && <div className="hint">No matches.</div>}
          {results.itemIds.map((id) => (
            <ItemRow key={id} item={results.items[id]} onOpen={onOpenItem} onToggleComplete={onToggleComplete} />
          ))}
        </div>
      )}
    </div>
  );
}
