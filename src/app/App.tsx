import { useCallback, useEffect, useRef, useState } from 'react';
import type { ItemView, MapPayload } from '../shared/types';
import type { CaptureResponse } from '../shared/types';
import { api, AuthError } from './api';
import PasswordGate from './components/PasswordGate';
import ReviewSheet from './components/ReviewSheet';
import SettingsSheet from './components/SettingsSheet';
import MapView from './views/MapView';
import BrowseView from './views/BrowseView';
import CalendarView from './views/CalendarView';
import SearchView from './views/SearchView';
import ItemSheet from './components/ItemSheet';

type Tab = 'map' | 'browse' | 'calendar' | 'search';

// Web Speech API (not yet in TS's DOM lib) — present on Android/desktop Chrome.
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } } }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null;
}

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
  const [review, setReview] = useState<CaptureResponse | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [captureText, setCaptureText] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [pushOn, setPushOn] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(false);
  const [listening, setListening] = useState(false);
  const captureRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Text that was in the box when dictation started; speech appends after it.
  const dictationBaseRef = useRef('');
  // Finals accumulated across utterances/restarts (Chrome auto-ends on
  // silence; we restart until the user explicitly taps stop).
  const dictationFinalsRef = useRef('');
  const stopRequestedRef = useRef(false);
  const fatalErrorRef = useRef(false);
  const speechSupported = getSpeechRecognition() !== null;

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
      if (err instanceof AuthError) {
        setLocked(true);
        return;
      }
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
    // Stop dictation so late speech results can't refill the cleared box.
    stopRequestedRef.current = true;
    recognitionRef.current?.stop();
    dictationBaseRef.current = '';
    dictationFinalsRef.current = '';
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
      // Review is part of the flow (user decision): every capture ends at the
      // review sheet. Items are already created; dismissing accepts as-is.
      setReview(res);
    } catch (err) {
      setCaptureText(text); // never lose a capture
      toast(`Capture failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setCapturing(false);
      captureRef.current?.focus();
    }
  }, [captureText, capturing, toast, loadMap]);

  // Dictation: transcribe into the capture box, editable before sending.
  // Listening continues through pauses — the recognizer is restarted whenever
  // it auto-ends on silence — and stops ONLY when the user taps the stop
  // button (or sends). Fatal mic errors break the restart loop.
  const startRecognizer = useCallback(() => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) return false;
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    // Deliberately NOT continuous: Android Chrome reports continuous-mode
    // results cumulatively (each entry repeats the whole utterance so far),
    // which duplicated text when concatenated. One utterance per session +
    // our onend auto-restart keeps listening just as well, on every platform.
    rec.continuous = false;
    rec.interimResults = true;

    const render = (interim: string) => {
      const joined = [dictationBaseRef.current, dictationFinalsRef.current, interim.trim()]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ');
      setCaptureText(joined);
    };

    rec.onresult = (e) => {
      // Read ONLY the latest result: on Android earlier entries are cumulative
      // repeats, and in non-continuous mode the last entry is the utterance.
      const res = e.results[e.results.length - 1];
      if (!res) return;
      const chunk = res[0].transcript.trim();
      if (!chunk) return;
      if (res.isFinal) {
        // Fold each finished utterance into the accumulated text exactly once
        // (guard against the same final being delivered twice).
        if (!dictationFinalsRef.current.endsWith(chunk)) {
          dictationFinalsRef.current = `${dictationFinalsRef.current} ${chunk}`.replace(/\s+/g, ' ').trim();
        }
        render('');
      } else {
        render(chunk);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        fatalErrorRef.current = true;
        toast('Microphone access was blocked — allow it in your browser settings.');
      } else if (e.error === 'audio-capture') {
        fatalErrorRef.current = true;
        toast('No microphone found on this device.');
      } else if (e.error !== 'aborted' && e.error !== 'no-speech') {
        // Transient (e.g. network): keep the session; the restart loop handles it.
        console.warn('dictation error', e.error);
      }
    };
    rec.onend = () => {
      // Drop any dangling interim text; finals are already folded in onresult.
      render('');
      if (!stopRequestedRef.current && !fatalErrorRef.current) {
        // Auto-ended on silence — keep listening until the user says done.
        try {
          startRecognizer();
          return;
        } catch {
          /* fall through to a real stop */
        }
      }
      setListening(false);
      recognitionRef.current = null;
      captureRef.current?.focus();
    };
    recognitionRef.current = rec;
    rec.start();
    return true;
  }, [toast]);

  const toggleMic = useCallback(() => {
    if (listening) {
      stopRequestedRef.current = true;
      recognitionRef.current?.stop();
      return;
    }
    stopRequestedRef.current = false;
    fatalErrorRef.current = false;
    dictationBaseRef.current = captureRef.current?.value.trim() ?? '';
    dictationFinalsRef.current = '';
    try {
      if (startRecognizer()) setListening(true);
    } catch {
      toast("Couldn't start the microphone.");
    }
  }, [listening, startRecognizer, toast]);

  // Undo a recapture-merge from the review sheet: reverts the boost and splits
  // the phrasing back out as its own item.
  const undoBoost = useCallback(
    async (itemId: string, appendedText: string) => {
      try {
        const { newItem } = await api.undoRecapture(itemId, appendedText);
        setReview((r) =>
          r
            ? {
                ...r,
                boosted: r.boosted.filter((b) => !(b.item.id === itemId && b.appendedText === appendedText)),
                created: newItem ? [...r.created, newItem] : r.created,
              }
            : r,
        );
        if (newItem) {
          setMap((m) =>
            m
              ? { ...m, items: { ...m.items, [newItem.id]: newItem }, capturedToday: [newItem.id, ...m.capturedToday] }
              : m,
          );
        }
        setRefreshKey((k) => k + 1);
        loadMap();
      } catch (err) {
        toast(`Undo failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [loadMap, toast],
  );

  // User-initiated re-run for bulk-import days: fold Captured Today into real
  // bubbles now instead of waiting for tomorrow's first open.
  const organizeNow = useCallback(async () => {
    setBuilding(true);
    try {
      setMap(await api.rebuildMap(true));
    } catch (err) {
      toast(`Couldn't rebuild: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBuilding(false);
    }
  }, [toast]);

  const exportAll = useCallback(async () => {
    try {
      const data = await api.exportAll();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `memory-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(`Export failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [toast]);

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

  if (locked) {
    return (
      <div className="app">
        <PasswordGate
          onUnlock={() => {
            setLocked(false);
            loadMap();
          }}
        />
      </div>
    );
  }

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
        <div className="brand">
          <span className="brand-dot" />
          <div>
            <h1>Memory</h1>
            <div className="day">
              {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
            </div>
          </div>
        </div>
        <div className="header-actions">
          <button className="icon-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
            ⚙
          </button>
        </div>
      </header>

      <main className="view">
        {tab === 'map' && map && (
          <MapView map={map} onOpenItem={setOpenItem} onToggleComplete={toggleComplete} onOrganizeNow={organizeNow} />
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
          placeholder={listening ? 'Listening…' : 'Capture anything…'}
          value={captureText}
          onChange={(e) => {
            setCaptureText(e.target.value);
            // Manual edits mid-dictation become the new base text.
            if (listening) {
              dictationBaseRef.current = e.target.value;
              dictationFinalsRef.current = '';
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              capture();
            }
          }}
        />
        {speechSupported && (
          <button
            className={`mic-btn${listening ? ' listening' : ''}`}
            onClick={toggleMic}
            aria-label={listening ? 'Done dictating' : 'Dictate'}
          >
            {listening ? '⏹' : '🎙'}
          </button>
        )}
        <button disabled={!captureText.trim() || capturing} onClick={capture} aria-label="Capture">
          {capturing ? '…' : '↑'}
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

      {settingsOpen && (
        <SettingsSheet
          pushOn={pushOn}
          onEnablePush={enablePush}
          onRebuild={organizeNow}
          onExport={exportAll}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {review && map && (
        <ReviewSheet
          response={review}
          items={map.items}
          onOpenItem={setOpenItem}
          onToggleComplete={toggleComplete}
          onUndoBoost={undoBoost}
          onClose={() => setReview(null)}
        />
      )}

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
