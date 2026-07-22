import { useEffect, useState } from 'react';
import type { Flavour, ItemView } from '../../shared/types';
import { FLAVOURS } from '../../shared/flavour';
import { api, themeColor } from '../api';
import ItemRow from '../components/ItemRow';
import { isDone } from '../done';

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
    if (!showDone && isDone(item)) return false;
    return flavour === 'All' || item.flavour === flavour;
  };

  // Within a section: active before done, dated before undated (soonest
  // first), then priority — so each theme reads as its own mini to-do list.
  const orderIds = (ids: string[]) =>
    [...ids].sort((a, b) => {
      const A = data.items[a];
      const B = data.items[b];
      if (isDone(A) !== isDone(B)) return isDone(A) ? 1 : -1;
      const aDate = A.deadline ?? A.eventAt;
      const bDate = B.deadline ?? B.eventAt;
      if (!!aDate !== !!bDate) return aDate ? -1 : 1;
      if (aDate && bDate && aDate !== bDate) return aDate < bDate ? -1 : 1;
      return B.effectivePriority - A.effectivePriority;
    });

  const sections = data.themes
    .map((t) => ({ ...t, itemIds: orderIds(t.itemIds.filter(visible)) }))
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
