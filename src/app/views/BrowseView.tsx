import { useEffect, useMemo, useState } from 'react';
import type { Cadence, Flavour, ItemView } from '../../shared/types';
import { FLAVOURS } from '../../shared/flavour';
import { isDoneForNow } from '../../shared/cadence';
import { api, themeColor, FLAVOUR_ICONS } from '../api';

// Browse (§6): the stable catalogue. Pure representation — no urgency, no
// judgement (attending is the Map's job). One axis structures the page, the
// other filters it: theme is a facet (items hold several), flavour is a
// partition (exactly one each), and the "shelve by" pivot decides which is
// which. A spread bar in the header shows how the catalogue distributes
// across themes.

type ShelveBy = 'theme' | 'flavour' | 'az';

const SHELVE_KEY = 'memory-browse-shelve';
const OPEN_KEY = 'memory-browse-open';

const UNFILED_COLOR = 'hsl(220 15% 55%)';

function loadShelveBy(): ShelveBy {
  const v = localStorage.getItem(SHELVE_KEY);
  return v === 'flavour' || v === 'az' ? v : 'theme';
}

function loadOpen(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

// Compact date for the anchor column — no times (Calendar owns those), no
// overdue styling (no judgement here).
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.round((d.getTime() - now.getTime()) / 86_400_000);
  if (Math.abs(days) < 1 && d.getDate() === now.getDate()) return 'today';
  if (days >= 0 && days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function shortCadence(c: Cadence): string {
  const unit = { daily: 'd', weekly: 'w', monthly: 'mo', yearly: 'y' }[c.freq];
  return c.interval > 1 ? `every ${c.interval}${unit}` : { daily: 'daily', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' }[c.freq];
}

function anchorText(item: ItemView): string {
  const dated = item.deadline ?? item.eventAt;
  if (dated) return fmtWhen(dated);
  if (item.cadence) return shortCadence(item.cadence);
  return '';
}

// Stable, stated order within a shelf: dated first (soonest first), then A–Z.
// Done-for-today recurring items sink below the rest — state, not judgement.
function catalogueOrder(a: ItemView, b: ItemView): number {
  const doneA = isDoneForNow(a);
  const doneB = isDoneForNow(b);
  if (doneA !== doneB) return doneA ? 1 : -1;
  const ad = a.deadline ?? a.eventAt;
  const bd = b.deadline ?? b.eventAt;
  if (!!ad !== !!bd) return ad ? -1 : 1;
  if (ad && bd && ad !== bd) return ad < bd ? -1 : 1;
  return a.title.localeCompare(b.title);
}

function plural(f: Flavour): string {
  return `${f}s`;
}

interface Section {
  key: string;
  name: string;
  color: string | null; // theme colour edge; null for flavour/letter shelves
  glyph: string | null; // flavour glyph on flavour shelves
  digest: string; // collapsed-state composition, e.g. "✓3 ⏰1 ✎2"
  active: ItemView[];
  done: ItemView[];
  alwaysOpen: boolean;
}

function CatalogueRow({ item, onOpen }: { item: ItemView; onOpen: (item: ItemView) => void }) {
  const done = item.status === 'completed';
  // A recurring DO checked off today (§ done-for-today): still active, so no
  // strikethrough — the anchor column states the fact instead.
  const doneNow = !done && isDoneForNow(item);
  return (
    <div className={`cat-row${done ? ' done' : ''}${doneNow ? ' done-today' : ''}`} onClick={() => onOpen(item)}>
      <span className="glyph">{FLAVOUR_ICONS[item.flavour]}</span>
      <span className={`title${item.flavour === 'Note' ? ' note' : ''}`}>{item.title}</span>
      <span className="dots">
        {item.themes.map((t) => (
          <i key={t.id} title={t.name} style={{ background: themeColor(t.name) }} />
        ))}
      </span>
      <span className="when">{doneNow ? `✓ ${anchorText(item)}` : anchorText(item)}</span>
    </div>
  );
}

export default function BrowseView({
  refreshKey,
  onOpenItem,
}: {
  refreshKey: number;
  onOpenItem: (item: ItemView) => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.browse>> | null>(null);
  const [shelveBy, setShelveBy] = useState<ShelveBy>(loadShelveBy);
  const [flavourFilter, setFlavourFilter] = useState<Flavour | null>(null);
  const [themeFilter, setThemeFilter] = useState<string[]>([]); // theme ids, any-of
  const [showDone, setShowDone] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen);

  useEffect(() => {
    api.browse().then(setData).catch(console.error);
  }, [refreshKey]);

  const setShelve = (s: ShelveBy) => {
    setShelveBy(s);
    localStorage.setItem(SHELVE_KEY, s);
  };

  const toggleOpen = (key: string) => {
    setOpen((o) => {
      const next = { ...o, [key]: !o[key] };
      localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      return next;
    });
  };

  const derived = useMemo(() => {
    if (!data) return null;
    const all = Object.values(data.items);
    const active = all.filter((i) => i.status !== 'completed');
    const doneItems = all.filter((i) => i.status === 'completed');

    // Theme "shelves" as raw id lists, plus an Unfiled shelf for items that
    // belong to no theme (invisible in the old theme-only rendering).
    const themedIds = new Set(data.themes.flatMap((t) => t.itemIds));
    const unfiledIds = all.filter((i) => !themedIds.has(i.id)).map((i) => i.id);
    const themeShelves = [
      ...data.themes.map((t) => ({ id: t.id, name: t.name, color: themeColor(t.name), itemIds: t.itemIds })),
      ...(unfiledIds.length ? [{ id: 'unfiled', name: 'Unfiled', color: UNFILED_COLOR, itemIds: unfiledIds }] : []),
    ];

    const flavourCount = Object.fromEntries(FLAVOURS.map((f) => [f, 0])) as Record<Flavour, number>;
    for (const i of active) flavourCount[i.flavour]++;

    const themeCount = new Map<string, number>();
    for (const t of themeShelves) {
      themeCount.set(t.id, t.itemIds.filter((id) => data.items[id]?.status !== 'completed').length);
    }

    return { all, active, doneItems, themeShelves, flavourCount, themeCount };
  }, [data]);

  if (!data || !derived) return <div className="hint">Loading…</div>;

  const { active, themeShelves, flavourCount, themeCount } = derived;

  const inThemeFilter = (item: ItemView) =>
    themeFilter.length === 0 ||
    item.themes.some((t) => themeFilter.includes(t.id)) ||
    (themeFilter.includes('unfiled') && item.themes.length === 0);

  const matchesFilters = (item: ItemView) =>
    shelveBy === 'theme' ? !flavourFilter || item.flavour === flavourFilter : inThemeFilter(item);

  // ---- sections for the current pivot ------------------------------------
  const emptyNames: string[] = []; // shelves emptied by the active filter, stated not hidden
  let sections: Section[] = [];

  const split = (items: ItemView[]) => ({
    active: items.filter((i) => i.status !== 'completed').sort(catalogueOrder),
    done: items.filter((i) => i.status === 'completed').sort(catalogueOrder),
  });

  if (shelveBy === 'theme') {
    for (const shelf of themeShelves) {
      const items = shelf.itemIds.map((id) => data.items[id]).filter(Boolean);
      const kept = items.filter(matchesFilters);
      if (items.length && !kept.length) {
        emptyNames.push(shelf.name);
        continue;
      }
      if (!kept.length) continue;
      const { active: act, done } = split(kept);
      const digest = FLAVOURS.filter((f) => act.some((i) => i.flavour === f))
        .map((f) => `${FLAVOUR_ICONS[f]}${act.filter((i) => i.flavour === f).length}`)
        .join(' ');
      sections.push({
        key: shelf.id,
        name: shelf.name,
        color: shelf.color,
        glyph: null,
        digest,
        active: act,
        done,
        alwaysOpen: false,
      });
    }
  } else if (shelveBy === 'flavour') {
    for (const f of FLAVOURS) {
      const items = derived.all.filter((i) => i.flavour === f);
      const kept = items.filter(matchesFilters);
      if (items.length && !kept.length) {
        emptyNames.push(plural(f).toLowerCase());
        continue;
      }
      if (!kept.length) continue;
      const { active: act, done } = split(kept);
      sections.push({ key: f, name: plural(f), color: null, glyph: FLAVOUR_ICONS[f], digest: '', active: act, done, alwaysOpen: false });
    }
  } else {
    const kept = derived.all.filter(matchesFilters).sort((a, b) => a.title.localeCompare(b.title));
    const byLetter = new Map<string, ItemView[]>();
    for (const i of kept) {
      const c = i.title[0]?.toUpperCase() ?? '#';
      const letter = c >= 'A' && c <= 'Z' ? c : '#';
      byLetter.set(letter, [...(byLetter.get(letter) ?? []), i]);
    }
    sections = [...byLetter.entries()].map(([letter, items]) => {
      const { active: act, done } = split(items);
      return { key: `az-${letter}`, name: letter, color: null, glyph: null, digest: '', active: act, done, alwaysOpen: true };
    });
  }

  const visibleCount = sections.reduce((n, s) => n + s.active.length, 0);
  const hiddenDone = sections.reduce((n, s) => n + s.done.length, 0);
  const filtered = shelveBy === 'theme' ? flavourFilter !== null : themeFilter.length > 0;

  // ---- spread bar: theme filings among items matching the current filter --
  const barItems = active.filter((i) => (shelveBy === 'theme' ? !flavourFilter || i.flavour === flavourFilter : true));
  const segments = themeShelves
    .map((shelf) => ({
      id: shelf.id,
      name: shelf.name,
      color: shelf.color,
      count:
        shelf.id === 'unfiled'
          ? barItems.filter((i) => i.themes.length === 0).length
          : barItems.filter((i) => i.themes.some((t) => t.id === shelf.id)).length,
    }))
    .filter((s) => s.count > 0);
  const filings = segments.reduce((n, s) => n + s.count, 0);

  const filterLabel =
    shelveBy === 'theme'
      ? flavourFilter
        ? plural(flavourFilter)
        : ''
      : themeShelves
          .filter((t) => themeFilter.includes(t.id))
          .map((t) => t.name)
          .join(', ');

  const onSegmentTap = (id: string) => {
    if (shelveBy === 'theme') {
      if (!open[id]) toggleOpen(id);
      document.getElementById(`shelf-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      toggleTheme(id);
    }
  };

  const toggleTheme = (id: string) =>
    setThemeFilter((cur) => (cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id]));

  const emptyNote =
    emptyNames.length === 0
      ? null
      : shelveBy === 'theme'
        ? `No ${plural(flavourFilter as Flavour).toLowerCase()} in ${emptyNames.join(' or ')}.`
        : `No ${emptyNames.join(' or ')} in ${filterLabel}.`;

  return (
    <div className="browse">
      <div className="spread-head">
        <span>
          {filtered ? `${visibleCount} of ${active.length} · ${filterLabel}` : `${active.length} things · ${data.themes.length} themes`}
        </span>
      </div>
      <div className="spread-bar">
        {segments.map((s) => (
          <button
            key={s.id}
            title={`${s.name} · ${s.count}`}
            aria-label={`${s.name}, ${s.count} items`}
            className={shelveBy !== 'theme' && themeFilter.length && !themeFilter.includes(s.id) ? 'off' : ''}
            style={{ width: `${(s.count / Math.max(1, filings)) * 100}%`, background: s.color }}
            onClick={() => onSegmentTap(s.id)}
          />
        ))}
      </div>

      <div className="pivot">
        <span className="pivot-label">Shelve by</span>
        <div className="seg">
          {(
            [
              ['theme', 'Theme'],
              ['flavour', 'Type'],
              ['az', 'A–Z'],
            ] as const
          ).map(([value, label]) => (
            <button key={value} className={shelveBy === value ? 'on' : ''} onClick={() => setShelve(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flavour-chips">
        {shelveBy === 'theme' ? (
          <>
            <button className={`chip${!flavourFilter ? ' on' : ''}`} onClick={() => setFlavourFilter(null)}>
              All <b>{active.length}</b>
            </button>
            {FLAVOURS.map((f) => (
              <button
                key={f}
                className={`chip${flavourFilter === f ? ' on' : ''}`}
                onClick={() => setFlavourFilter(flavourFilter === f ? null : f)}
              >
                {FLAVOUR_ICONS[f]} {plural(f)} <b>{flavourCount[f]}</b>
              </button>
            ))}
          </>
        ) : (
          <>
            <button className={`chip${themeFilter.length === 0 ? ' on' : ''}`} onClick={() => setThemeFilter([])}>
              All <b>{active.length}</b>
            </button>
            {themeShelves.map((t) => (
              <button
                key={t.id}
                className={`chip${themeFilter.includes(t.id) ? ' on' : ''}`}
                onClick={() => toggleTheme(t.id)}
              >
                <span className="tdot" style={{ background: t.color }} /> {t.name} <b>{themeCount.get(t.id) ?? 0}</b>
                {themeFilter.includes(t.id) ? ' ✕' : ''}
              </button>
            ))}
          </>
        )}
      </div>

      {sections.length === 0 && <div className="hint">Nothing filed here yet.</div>}

      {sections.map((s) =>
        s.alwaysOpen ? (
          <div key={s.key}>
            <div className="az-letter">{s.name}</div>
            <div className="shelf">
              <div className="shelf-items no-head">
                {s.active.map((i) => (
                  <CatalogueRow key={i.id} item={i} onOpen={onOpenItem} />
                ))}
                {showDone && s.done.map((i) => <CatalogueRow key={i.id} item={i} onOpen={onOpenItem} />)}
              </div>
            </div>
          </div>
        ) : (
          <div key={s.key} id={`shelf-${s.key}`} className="shelf" style={s.color ? { ['--tc' as string]: s.color } : undefined}>
            <button className="shelf-head" onClick={() => toggleOpen(s.key)}>
              {s.glyph && <span className="glyph">{s.glyph}</span>}
              <span className="name">{s.name}</span>
              <span className="ct">{s.active.length}</span>
              <span className="digest">
                {!open[s.key] ? s.digest : ''}
                <span className="chev">{open[s.key] ? '▾' : '▸'}</span>
              </span>
            </button>
            {open[s.key] && (
              <div className="shelf-items">
                {s.active.map((i) => (
                  <CatalogueRow key={i.id} item={i} onOpen={onOpenItem} />
                ))}
                {showDone && s.done.map((i) => <CatalogueRow key={i.id} item={i} onOpen={onOpenItem} />)}
              </div>
            )}
          </div>
        ),
      )}

      {emptyNote && <div className="empty-note">{emptyNote}</div>}

      {hiddenDone > 0 && (
        <button className="done-foot" onClick={() => setShowDone(!showDone)}>
          {showDone
            ? 'Hide completed items'
            : `${hiddenDone} completed item${hiddenDone === 1 ? '' : 's'} hidden · show`}
        </button>
      )}
    </div>
  );
}
