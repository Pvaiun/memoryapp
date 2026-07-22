import { useEffect, useState } from 'react';
import { api } from '../api';
import type { NowView } from '../views/MapView';

interface Status {
  items: number;
  activeItems: number;
  themes: number;
  events: number;
  llm: boolean;
  push: boolean;
  pushSubscriptions: number;
  captureModel: string;
  brainModel: string;
  mapDay: string | null;
  mapBuiltAt: string | null;
  brainPrompt: 'full' | 'minimal';
  brainAddendum: string;
  brainOverrideEnabled: boolean;
  brainOverride: string;
}

export default function SettingsSheet({
  pushOn,
  nowView,
  onSetNowView,
  onEnablePush,
  onRebuild,
  onRebuildNoHistory,
  onExport,
  onCopyBrainSnapshot,
  onClose,
}: {
  pushOn: boolean | null;
  nowView: NowView;
  onSetNowView: (v: NowView) => void;
  onEnablePush: () => void;
  onRebuild: () => void;
  onRebuildNoHistory: () => void;
  onExport: () => void;
  onCopyBrainSnapshot: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [brainPrompt, setBrainPrompt] = useState<'full' | 'minimal' | null>(null);

  const [addendum, setAddendum] = useState('');
  const [savedAddendum, setSavedAddendum] = useState('');
  const [overrideOn, setOverrideOn] = useState(false);
  const [overrideText, setOverrideText] = useState('');
  const [savedOverride, setSavedOverride] = useState('');

  useEffect(() => {
    api.status().then((s) => {
      const st = s as unknown as Status;
      setStatus(st);
      setBrainPrompt(st.brainPrompt ?? 'minimal');
      setAddendum(st.brainAddendum ?? '');
      setSavedAddendum(st.brainAddendum ?? '');
      setOverrideOn(!!st.brainOverrideEnabled);
      setOverrideText(st.brainOverride ?? '');
      setSavedOverride(st.brainOverride ?? '');
    }).catch(() => {});
  }, []);

  // The self-serve workshop layer: text appended verbatim to whichever Brain
  // prompt runs. Save persists; Clear removes it entirely.
  const saveAddendum = () => {
    const t = addendum.trim();
    api.setBrainAddendum(t).then(() => {
      setAddendum(t);
      setSavedAddendum(t);
    }).catch(() => {});
  };
  const clearAddendum = () => {
    setAddendum('');
    api.setBrainAddendum('').then(() => setSavedAddendum('')).catch(() => {});
  };

  // Full prompt override. The checkbox is the ONLY thing that arms it — the
  // server uses the saved text solely while enabled, so an unchecked box
  // leaves any draft completely inert. Turning it on with nothing saved
  // prefills the editor with the live default (variant + addendum); nothing
  // runs off the override until Save.
  const toggleOverride = (on: boolean) => {
    const prev = overrideOn;
    setOverrideOn(on);
    api.setBrainOverride({ enabled: on }).catch(() => setOverrideOn(prev));
    if (on && !savedOverride && !overrideText.trim()) {
      api.brainPromptText().then(({ text }) => setOverrideText(text)).catch(() => {});
    }
  };
  const saveOverride = () => {
    const t = overrideText.trim();
    api.setBrainOverride({ text: t }).then(() => {
      setOverrideText(t);
      setSavedOverride(t);
    }).catch(() => {});
  };
  // Reset restores the editor to the live default AND saves it, so the stored
  // override can never silently lag what's on screen.
  const resetOverride = () => {
    api.brainPromptText().then(({ text }) => {
      setOverrideText(text);
      return api.setBrainOverride({ text }).then(() => setSavedOverride(text));
    }).catch(() => {});
  };

  // The morning-prompt toggle (workshop shootout, longitudinal arm): which
  // Brain prompt tomorrow's first-open rebuild uses. Optimistic; reverts on
  // failure. Workshop rebuild buttons override per run.
  const pickPrompt = (v: 'full' | 'minimal') => {
    const prev = brainPrompt;
    setBrainPrompt(v);
    api.setBrainPrompt(v).catch(() => setBrainPrompt(prev));
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grabber" />
        <h2>Settings</h2>

        {status && (
          <div className="settings-status">
            <div className="settings-row">
              <span>Map built</span>
              <span>
                {status.mapBuiltAt
                  ? `${new Date(status.mapBuiltAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} (for ${status.mapDay})`
                  : 'never'}
              </span>
            </div>
            <div className="settings-row">
              <span>Items</span>
              <span>
                {status.activeItems} active · {status.items} total · {status.themes} themes
              </span>
            </div>
            <div className="settings-row">
              <span>History log</span>
              <span>{status.events} events</span>
            </div>
            <div className="settings-row">
              <span>AI</span>
              <span>{status.llm ? `${status.captureModel} + ${status.brainModel}` : 'not configured — fallback mode'}</span>
            </div>
            <div className="settings-row">
              <span>Alerts</span>
              <span>
                {!status.push
                  ? 'server keys missing'
                  : pushOn
                    ? `on (${status.pushSubscriptions} device${status.pushSubscriptions === 1 ? '' : 's'})`
                    : 'off on this device'}
              </span>
            </div>
          </div>
        )}

        <div className="field">
          <label>Now view</label>
          <div className="seg">
            <button className={nowView === 'descent' ? 'on' : ''} onClick={() => onSetNowView('descent')}>
              Descent
            </button>
            <button className={nowView === 'tiles' ? 'on' : ''} onClick={() => onSetNowView('tiles')}>
              Tiles (classic)
            </button>
          </div>
          <small className="settings-hint">
            Descent is the new depth instrument — experimental. Tiles is the previous mosaic.
          </small>
        </div>

        <div className="field">
          <label>Morning Brain prompt</label>
          <div className="seg">
            <button className={brainPrompt === 'minimal' ? 'on' : ''} onClick={() => pickPrompt('minimal')}>
              Minimal
            </button>
            <button className={brainPrompt === 'full' ? 'on' : ''} onClick={() => pickPrompt('full')}>
              Full
            </button>
          </div>
          <small className="settings-hint">
            Which prompt builds tomorrow's map — comparing them over days. Workshop rebuilds override per run.
          </small>
        </div>

        <div className="field">
          <label>Brain prompt addendum</label>
          <textarea
            rows={4}
            value={addendum}
            onChange={(e) => setAddendum(e.target.value)}
            placeholder="Extra instructions appended verbatim to the Brain prompt — try tone, emphasis, anything"
          />
          <div className="seg">
            <button disabled={addendum.trim() === savedAddendum} onClick={saveAddendum}>
              {addendum.trim() === savedAddendum && savedAddendum ? 'Saved' : 'Save'}
            </button>
            <button disabled={!addendum && !savedAddendum} onClick={clearAddendum}>
              Clear
            </button>
          </div>
          <small className="settings-hint">
            Applies to every rebuild until cleared. The Brain snapshot records what was active.
          </small>
        </div>

        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={overrideOn}
              onChange={(e) => toggleOverride(e.target.checked)}
            />{' '}
            Override Brain prompt
          </label>
          {overrideOn && (
            <>
              <textarea
                rows={14}
                value={overrideText}
                onChange={(e) => setOverrideText(e.target.value)}
                placeholder="The entire Brain prompt, verbatim"
              />
              <div className="seg">
                <button disabled={overrideText.trim() === savedOverride} onClick={saveOverride}>
                  {overrideText.trim() === savedOverride && savedOverride ? 'Saved' : 'Save'}
                </button>
                <button onClick={resetOverride}>Reset to default</button>
              </div>
              <small className="settings-hint">
                While checked, the saved text above IS the whole Brain prompt — the Minimal/Full toggle and the
                addendum are ignored. Unsaved edits and an empty box don't run: the normal flow stays in charge.
                Unchecking returns to the normal flow; the text stays saved but inert.
              </small>
            </>
          )}
        </div>

        <div className="settings-actions">
          <button
            className="settings-btn primary"
            onClick={() => {
              onClose();
              onRebuild();
            }}
          >
            Rebuild map now
            <small>Re-runs the Brain for today — clusters, summaries, profile</small>
          </button>
          <button
            className="settings-btn"
            onClick={() => {
              onClose();
              onRebuildNoHistory();
            }}
          >
            Rebuild map now — no history
            <small>The Brain composes fresh, without yesterday's groupings — for workshopping</small>
          </button>
          {!pushOn && (
            <button
              className="settings-btn"
              onClick={() => {
                onClose();
                onEnablePush();
              }}
            >
              Enable alerts on this device
              <small>Punctual pushes for events and hard deadlines</small>
            </button>
          )}
          <button className="settings-btn" onClick={onCopyBrainSnapshot}>
            Copy Brain snapshot
            <small>What the Brain sees + the map it built — for workshopping</small>
          </button>
          <button className="settings-btn" onClick={onExport}>
            Download full backup
            <small>Everything as one JSON file — items, history, themes</small>
          </button>
        </div>
      </div>
    </div>
  );
}
