import { useEffect, useState } from 'react';
import type { Flavour, ItemView } from '../../shared/types';
import { FLAVOURS } from '../../shared/flavour';
import { api, themeColor } from '../api';
import ItemRow from '../components/ItemRow';

// Browse (§6): the stable shelves — organized by theme, filterable by flavour.

export default function BrowseView({
  refreshKey,
  onOpenItem,
  onToggleComplete,
}: {
  refreshKey: number;
  onOpenItem: (item: ItemView) => void;
  onToggleComplete: (item: ItemView) => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.browse>> | null>(null);
  const [flavour, setFlavour] = useState<Flavour | 'All'>('All');
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    api.browse().then(setData).catch(console.error);
  }, [refreshKey]);

  if (!data) return <div className="hint">Loading…</div>;

  const visible = (id: string) => {
    const item = data.items[id];
    if (!item) return false;
    if (!showDone && item.status === 'completed') return false;
    return flavour === 'All' || item.flavour === flavour;
  };

  const sections = data.themes
    .map((t) => ({ ...t, itemIds: t.itemIds.filter(visible) }))
    .filter((t) => t.itemIds.length);

  return (
    <div>
      <div className="flavour-chips">
        {(['All', ...FLAVOURS] as const).map((f) => (
          <button key={f} className={`chip${flavour === f ? ' on' : ''}`} onClick={() => setFlavour(f)}>
            {f === 'All' ? 'Everything' : `${f}s`}
          </button>
        ))}
        <button className={`chip${showDone ? ' on' : ''}`} onClick={() => setShowDone(!showDone)}>
          {showDone ? 'Hiding nothing' : 'Show done'}
        </button>
      </div>
      {sections.length === 0 && <div className="hint">Nothing filed here yet.</div>}
      {sections.map((t) => (
        <div key={t.id} className="theme-section">
          <h3>
            <span className="theme-dot" style={{ background: themeColor(t.name), color: themeColor(t.name) }} />
            {t.name} <span className="count">{t.itemIds.length}</span>
          </h3>
          {t.itemIds.map((id) => (
            <ItemRow key={id} item={data.items[id]} onOpen={onOpenItem} onToggleComplete={onToggleComplete} />
          ))}
        </div>
      ))}
    </div>
  );
}
