import { useEffect, useState } from 'react';
import type { ItemView, RetroPayload } from '../../shared/types';
import { api, FLAVOUR_ICONS, itemColor } from '../api';

// The Brain's conscience (§8.3): a quiet, read-only look back at how a day's
// map actually fared — which groupings the user engaged, and what the map
// buried. All deterministic, from the Tier-0 log; the other half of the Brain
// workshop, which tunes the map but never told you whether it was any good.
export default function RetroSheet({
  onClose,
  onOpenItem,
}: {
  onClose: () => void;
  onOpenItem: (item: ItemView) => void;
}) {
  const [day, setDay] = useState<string | undefined>(undefined);
  const [retro, setRetro] = useState<RetroPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRetro(null);
    setError(null);
    api
      .mapRetro(day)
      .then((r) => live && setRetro(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [day]);

  const t = retro?.totals;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grabber" />
        <div className="retro-head">
          <h2>How the map did</h2>
          {retro && (
            <div className="retro-nav">
              <button disabled={!retro.prevDay} onClick={() => setDay(retro.prevDay ?? undefined)} aria-label="Earlier day">
                ‹
              </button>
              <span className="retro-day">{retro.day}</span>
              <button disabled={!retro.nextDay} onClick={() => setDay(retro.nextDay ?? undefined)} aria-label="Later day">
                ›
              </button>
            </div>
          )}
        </div>

        {error && <p className="retro-empty">Couldn’t load: {error}</p>}
        {!retro && !error && <p className="retro-empty">Looking back…</p>}

        {retro && !retro.hasMap && (
          <p className="retro-empty">
            No map was built for {retro.day}.
            {retro.prevDay && (
              <>
                {' '}
                <button className="retro-link" onClick={() => setDay(retro.prevDay ?? undefined)}>
                  See {retro.prevDay} instead →
                </button>
              </>
            )}
          </p>
        )}

        {retro && retro.hasMap && t && (
          <>
            <div className="retro-tallies">
              <div className="retro-tally">
                <b>
                  {t.engagedBubbles}/{t.bubbles}
                </b>
                <span>bubbles engaged</span>
              </div>
              <div className="retro-tally">
                <b>{t.completedFromMap}</b>
                <span>done from the map</span>
              </div>
              <div className={`retro-tally${t.completedOffMap ? ' warn' : ''}`}>
                <b>{t.completedOffMap}</b>
                <span>done it missed</span>
              </div>
              <div className="retro-tally">
                <b>{t.capturedThatDay}</b>
                <span>captured</span>
              </div>
            </div>

            <div className="retro-bubbles">
              {retro.bubbles.map((b) => (
                <div key={b.id} className={`retro-bubble${b.engaged ? ' engaged' : ' idle'}`}>
                  <div className="retro-bubble-head">
                    <span className="retro-prom" style={{ ['--p' as string]: b.prominence }} aria-hidden />
                    <span className="retro-bubble-name">{b.name}</span>
                    {b.kind === 'rotation' && <span className="retro-kind">rotation</span>}
                    <span className="retro-bubble-verdict">
                      {b.completedItemIds.length > 0
                        ? `${b.completedItemIds.length} done`
                        : b.touchedItemIds.length > 0
                          ? 'touched'
                          : 'untouched'}
                    </span>
                  </div>
                  {b.reason && <div className="retro-reason">{b.reason}</div>}
                  <div className="retro-items">
                    {b.itemIds.map((id) => {
                      const it = retro.items[id];
                      if (!it) return null;
                      const done = b.completedItemIds.includes(id);
                      const touched = b.touchedItemIds.includes(id);
                      return (
                        <button
                          key={id}
                          className={`retro-item${done ? ' done' : touched ? ' touched' : ''}`}
                          onClick={() => onOpenItem(it)}
                        >
                          <span className="retro-item-dot" style={{ background: itemColor(it) }} aria-hidden />
                          <span className="retro-item-glyph" aria-hidden>
                            {FLAVOUR_ICONS[it.flavour]}
                          </span>
                          <span className="retro-item-title">{it.title}</span>
                          {done && <span className="retro-item-tag">done</span>}
                          {touched && <span className="retro-item-tag soft">touched</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {retro.misses.some((m) => !m.fresh) && (
              <div className="retro-misses">
                <h3>Buried — done that day, but the map didn’t surface it</h3>
                {retro.misses
                  .filter((m) => !m.fresh)
                  .map((m) => {
                    const it = retro.items[m.itemId];
                    if (!it) return null;
                    return (
                      <button key={m.itemId} className="retro-item done miss" onClick={() => onOpenItem(it)}>
                        <span className="retro-item-dot" style={{ background: itemColor(it) }} aria-hidden />
                        <span className="retro-item-glyph" aria-hidden>
                          {FLAVOUR_ICONS[it.flavour]}
                        </span>
                        <span className="retro-item-title">{it.title}</span>
                      </button>
                    );
                  })}
              </div>
            )}

            <p className="retro-foot">
              Only completions and edits already in the history log — no tracking. A read of whether the Brain surfaced
              the right things, so the map can get better.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
