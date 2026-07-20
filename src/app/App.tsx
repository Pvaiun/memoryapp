import { useCallback, useEffect, useRef, useState } from 'react';
import type { ItemView, MapPayload } from '../shared/types';
import { api } from './api';
import MapView from './views/MapView';
import BrowseView from './views/BrowseView';
import CalendarView from './views/CalendarView';
import SearchView from './views/SearchView';
import ItemSheet from './components/ItemSheet';

type Tab = 'map' | 'browse' | 'calendar' | 'search';

interface Toast {
  id: number;
  msg: string;
  action?: { label: string; fn: () => void };
}

let toastSeq = 1;

export default function App() {
  const [tab, setTab] = useState<Tab>('map');
  const [map, setMap] = useState<MapPayload | null>(null);
  const [building, setBuilding] = useState(false);
  const [openItem, setOpenItem] = useState<ItemView | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [captureText, setCaptureText] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [pushOn, setPushOn] = useState<boolean | null>(null);
  const captureRef = useRef<HTMLTextAreaElement>(null);

  const toast = useCallback((msg: string, action?: Toast['action'], ttl = 6000) => {
    const id = toastSeq++;
    setToasts((ts) => [...ts, { id, msg, action }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), ttl);
  }, []);

  // First open of the day (§9.1): if the map is stale, rebuild behind a loading
  // screen — never shown stale-then-swapped.
  const loadMap = useCallback(async () => {
    try {
      const m = await api.getMap();
      if (m.stale) {
        setBuilding(true);
        const rebuilt = await api.rebuildMap();
        setMap(rebuilt);
        setBuilding(false);
      } else {
        setMap(m);
      }
    } catch (err) {
      setBuilding(false);
      toast(`Couldn't load the map: ${err instanceof Error ? err.message : err}`);
    }
  }, [toast]);

  useEffect(() => {
    loadMap();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    // Re-check staleness when returning to the app across a day boundary.
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadMap();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadMap]);

  useEffect(() => {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      setPushOn(false);
      return;
    }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setPushOn(!!sub))
      .catch(() => setPushOn(false));
  }, []);

  const patchItemEverywhere = useCallback((item: ItemView) => {
    setMap((m) => (m && m.items[item.id] ? { ...m, items: { ...m.items, [item.id]: item } } : m));
    setRefreshKey((k) => k + 1);
  }, []);

  const removeItemEverywhere = useCallback((id: string) => {
    setMap((m) => {
      if (!m) return m;
      const items = { ...m.items };
      delete items[id];
      return {
        ...m,
        items,
        capturedToday: m.capturedToday.filter((x) => x !== id),
        bubbles: m.bubbles.map((b) => ({ ...b, itemIds: b.itemIds.filter((x) => x !== id) })),
      };
    });
    setRefreshKey((k) => k + 1);
  }, []);

  // Within-day changes are deterministic (§9.1): completing updates in place.
  const toggleComplete = useCallback(
    async (item: ItemView) => {
      try {
        const res =
          item.status === 'completed' ? await api.uncompleteItem(item.id) : await api.completeItem(item.id);
        patchItemEverywhere(res.item);
        if (item.status !== 'completed' && res.item.cadence) {
          toast(`Done — rhythm kept${res.item.streak > 1 ? ` (${res.item.streak} in a row)` : ''}`);
        }
      } catch (err) {
        toast(`${err instanceof Error ? err.message : err}`);
      }
    },
    [patchItemEverywhere, toast],
  );

  // Optimistic capture (§10.1): typed it, it's filed. Nudges only when warranted.
  const capture = useCallback(async () => {
    const text = captureText.trim();
    if (!text || capturing) return;
    setCapturing(true);
    setCaptureText('');
    try {
      const res = await api.capture(text);
      // New items land in Captured Today instantly (§9.1).
      setMap((m) => {
        if (!m) return m;
        const items = { ...m.items };
        for (const it of res.created) items[it.id] = it;
        for (const b of res.boosted) items[b.item.id] = b.item;
        return {
          ...m,
          items,
          capturedToday: [...res.created.map((i) => i.id), ...m.capturedToday],
        };
      });
      setRefreshKey((k) => k + 1);

      // The one destructive op — recapture-merge — is never silent (§10.1).
      for (const b of res.boosted) {
        toast(`Bumped “${b.item.title}”`, {
          label: 'Undo',
          fn: async () => {
            const { newItem } = await api.undoRecapture(b.item.id, b.appendedText);
            if (newItem) {
              setMap((m) =>
                m
                  ? { ...m, items: { ...m.items, [newItem.id]: newItem }, capturedToday: [newItem.id, ...m.capturedToday] }
                  : m,
              );
            }
            setRefreshKey((k) => k + 1);
            loadMap();
          },
        }, 10000);
      }
      if (res.nudge === 'split') {
        toast(`Split into ${res.created.length} items`, {
          label: 'Review',
          fn: () => {
            setTab('map');
            if (res.created[0]) setOpenItem(res.created[0]);
          },
        });
      } else if (res.nudge === 'low-confidence' && res.created[0]) {
        toast('Filed — took a guess at the details', {
          label: 'Check',
          fn: () => setOpenItem(res.created[0]),
        });
      }
    } catch (err) {
      setCaptureText(text); // never lose a capture
      toast(`Capture failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setCapturing(false);
      captureRef.current?.focus();
    }
  }, [captureText, capturing, toast, loadMap]);

  const enablePush = useCallback(async () => {
    try {
      const { publicKey } = await api.pushPublicKey();
      if (!publicKey) {
        toast('Push keys not configured on the server yet.');
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(publicKey),
      });
      await api.pushSubscribe(sub.toJSON());
      setPushOn(true);
      toast('Alerts on — only for things at their moment.');
    } catch (err) {
      toast(`Couldn't enable alerts: ${err instanceof Error ? err.message : err}`);
    }
  }, [toast]);

  if (building || (!map && !toasts.length)) {
    return (
      <div className="app">
        <div className="loading-screen">
          <div className="loading-bubbles">
            <span />
            <span />
            <span />
          </div>
          <div>{building ? 'Building today’s map…' : 'Loading…'}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Memory</h1>
          <div className="day">
            {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
        </div>
        <div className="header-actions">
          <button
            className={`icon-btn${pushOn ? ' active' : ''}`}
            title={pushOn ? 'Alerts on' : 'Enable alerts'}
            onClick={pushOn ? undefined : enablePush}
          >
            {pushOn ? '🔔' : '🔕'}
          </button>
        </div>
      </header>

      <main className="view">
        {tab === 'map' && map && (
          <MapView map={map} onOpenItem={setOpenItem} onToggleComplete={toggleComplete} />
        )}
        {tab === 'browse' && (
          <BrowseView refreshKey={refreshKey} onOpenItem={setOpenItem} onToggleComplete={toggleComplete} />
        )}
        {tab === 'calendar' && (
          <CalendarView refreshKey={refreshKey} onOpenItem={setOpenItem} onToggleComplete={toggleComplete} />
        )}
        {tab === 'search' && <SearchView onOpenItem={setOpenItem} onToggleComplete={toggleComplete} />}
      </main>

      <div className="capture-bar">
        <textarea
          ref={captureRef}
          rows={1}
          placeholder="Capture anything…"
          value={captureText}
          onChange={(e) => setCaptureText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              capture();
            }
          }}
        />
        <button disabled={!captureText.trim() || capturing} onClick={capture}>
          {capturing ? '…' : 'Save'}
        </button>
      </div>

      <nav className="tab-bar">
        {(
          [
            ['map', '🫧', 'Now'],
            ['browse', '🗂', 'Browse'],
            ['calendar', '📅', 'Calendar'],
            ['search', '🔍', 'Find'],
          ] as [Tab, string, string][]
        ).map(([t, glyph, label]) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            <span className="glyph">{glyph}</span>
            {label}
          </button>
        ))}
      </nav>

      {openItem && (
        <ItemSheet
          item={openItem}
          onClose={() => setOpenItem(null)}
          onChanged={patchItemEverywhere}
          onDeleted={removeItemEverywhere}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span className="msg">{t.msg}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.fn();
                  setToasts((ts) => ts.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((base64.length + 3) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
