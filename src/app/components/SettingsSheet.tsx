import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, type PromptSlot } from '../api';
import type { NowView } from '../views/MapView';

// Collapsible settings group — the sheet groups its controls so the whole
// menu isn't one long wall. Bodies render only while open, but every input's
// value lives in SettingsSheet state, so collapsing never drops a draft.
function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`settings-section${open ? ' open' : ''}`}>
      <button className="settings-section-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>{title}</span>
        <span className="chevron" aria-hidden>
          ›
        </span>
      </button>
      {open && <div className="settings-section-body">{children}</div>}
    </div>
  );
}

// One prompt override box: checkbox to arm it, the full prompt text, Save,
// and Reset to the default it stands in for. Presentational — its draft lives
// in SettingsSheet state (see Section) so collapsing never drops an edit.
type OverrideDraft = { on: boolean; text: string; saved: string };
const NO_DRAFT: OverrideDraft = { on: false, text: '', saved: '' };

function PromptOverrideField({
  label,
  placeholder,
  hint,
  draft,
  onToggle,
  onChange,
  onSave,
  onReset,
}: {
  label: string;
  placeholder: string;
  hint: string;
  draft: OverrideDraft;
  onToggle: (on: boolean) => void;
  onChange: (text: string) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const unchanged = draft.text.trim() === draft.saved;
  return (
    <div className="field">
      <label className="checkbox-label">
        {label}
        <input type="checkbox" checked={draft.on} onChange={(e) => onToggle(e.target.checked)} />
      </label>
      {draft.on && (
        <>
          <textarea rows={14} value={draft.text} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
          <div className="seg">
            <button disabled={unchanged} onClick={onSave}>
              {unchanged && draft.saved ? 'Saved' : 'Save'}
            </button>
            <button onClick={onReset}>Reset to default</button>
          </div>
          <small className="settings-hint">{hint}</small>
        </>
      )}
    </div>
  );
}

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
  brainPrompt: 'full' | 'minimal' | 'staged';
  brainAddendum: string;
  brainOverrides: Record<PromptSlot, { enabled: boolean; text: string }>;
}

export default function SettingsSheet({
  pushOn,
  nowView,
  fallSpeed,
  onSetFallSpeed,
  onSetNowView,
  onEnablePush,
  onRebuild,
  onRebuildNoHistory,
  onRebuildNoProfile,
  onExport,
  onCopyBrainSnapshot,
  onClose,
}: {
  pushOn: boolean | null;
  nowView: NowView;
  fallSpeed: number;
  onSetFallSpeed: (v: number) => void;
  onSetNowView: (v: NowView) => void;
  onEnablePush: () => void;
  onRebuild: () => void;
  onRebuildNoHistory: () => void;
  onRebuildNoProfile: () => void;
  onExport: () => void;
  onCopyBrainSnapshot: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [brainPrompt, setBrainPrompt] = useState<'full' | 'minimal' | 'staged' | null>(null);

  const [addendum, setAddendum] = useState('');
  const [savedAddendum, setSavedAddendum] = useState('');
  const [overrides, setOverrides] = useState<Record<PromptSlot, OverrideDraft>>({
    single: NO_DRAFT,
    curator: NO_DRAFT,
    writer: NO_DRAFT,
  });
  const patchOverride = (slot: PromptSlot, patch: Partial<OverrideDraft>) =>
    setOverrides((o) => ({ ...o, [slot]: { ...o[slot], ...patch } }));

  useEffect(() => {
    api.status().then((s) => {
      const st = s as unknown as Status;
      setStatus(st);
      setBrainPrompt(st.brainPrompt ?? 'minimal');
      setAddendum(st.brainAddendum ?? '');
      setSavedAddendum(st.brainAddendum ?? '');
      const fromStatus = (slot: PromptSlot): OverrideDraft => {
        const o = st.brainOverrides?.[slot];
        return { on: !!o?.enabled, text: o?.text ?? '', saved: o?.text ?? '' };
      };
      setOverrides({ single: fromStatus('single'), curator: fromStatus('curator'), writer: fromStatus('writer') });
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

  // Prompt overrides, one per prompt (single-call, curator, writer). The
  // checkbox is the ONLY thing that arms one — the server uses the saved text
  // solely while enabled, so an unchecked box leaves any draft completely
  // inert. Turning one on with nothing saved prefills the editor with the
  // live default for that prompt; nothing runs off an override until Save.
  const toggleOverride = (slot: PromptSlot, on: boolean) => {
    const prev = overrides[slot];
    patchOverride(slot, { on });
    api.setBrainOverride(slot, { enabled: on }).catch(() => patchOverride(slot, { on: prev.on }));
    if (on && !prev.saved && !prev.text.trim()) {
      api.brainPromptText(slot).then(({ text }) => patchOverride(slot, { text })).catch(() => {});
    }
  };
  const saveOverride = (slot: PromptSlot) => {
    const t = overrides[slot].text.trim();
    api.setBrainOverride(slot, { text: t }).then(() => patchOverride(slot, { text: t, saved: t })).catch(() => {});
  };
  // Reset restores the editor to the live default AND saves it, so the stored
  // override can never silently lag what's on screen.
  const resetOverride = (slot: PromptSlot) => {
    api.brainPromptText(slot).then(({ text }) => {
      patchOverride(slot, { text });
      return api.setBrainOverride(slot, { text }).then(() => patchOverride(slot, { saved: text }));
    }).catch(() => {});
  };
  const overrideField = (slot: PromptSlot, label: string, placeholder: string, hint: string) => (
    <PromptOverrideField
      label={label}
      placeholder={placeholder}
      hint={hint}
      draft={overrides[slot]}
      onToggle={(on) => toggleOverride(slot, on)}
      onChange={(text) => patchOverride(slot, { text })}
      onSave={() => saveOverride(slot)}
      onReset={() => resetOverride(slot)}
    />
  );

  // The morning-prompt toggle (workshop shootout, longitudinal arm): which
  // Brain prompt or pipeline tomorrow's first-open rebuild uses. Optimistic;
  // reverts on failure. Workshop rebuild buttons override per run.
  const pickPrompt = (v: 'full' | 'minimal' | 'staged') => {
    const prev = brainPrompt;
    setBrainPrompt(v);
    api.setBrainPrompt(v).catch(() => setBrainPrompt(prev));
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grabber" />
        <h2>Settings</h2>

        <Section title="Display" defaultOpen>
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
            <label>Fall speed</label>
            <input
              type="range"
              className="slider"
              min={0.4}
              max={2.5}
              step={0.1}
              value={fallSpeed}
              onChange={(e) => onSetFallSpeed(parseFloat(e.target.value))}
              disabled={nowView !== 'descent'}
            />
            <div className="slider-scale">
              <span>Slow</span>
              <span>{fallSpeed.toFixed(1)}×</span>
              <span>Fast</span>
            </div>
            <small className="settings-hint">
              How fast a finished bubble drops to the floor when it settles in the Descent view.
            </small>
          </div>
        </Section>

        <Section title="Morning Brain">
          <div className="field">
            <label>Morning Brain prompt</label>
            <div className="seg">
              <button className={brainPrompt === 'minimal' ? 'on' : ''} onClick={() => pickPrompt('minimal')}>
                Minimal
              </button>
              <button className={brainPrompt === 'full' ? 'on' : ''} onClick={() => pickPrompt('full')}>
                Full
              </button>
              <button className={brainPrompt === 'staged' ? 'on' : ''} onClick={() => pickPrompt('staged')}>
                Staged
              </button>
            </div>
            <small className="settings-hint">
              Which Brain builds tomorrow's map — comparing them over days. Minimal and Full are the single-call
              prompts; Staged is the split pipeline (code places the day's required items, a curator call picks
              what else deserves airtime, a writer call names the cards). The override boxes below follow this
              choice: one for the single-call prompt, or one each for the curator and the writer.
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
              Applies to every rebuild until cleared — appended to the single-call prompt, or to the curator
              prompt under Staged, but never to an overridden prompt. The Brain snapshot records what was active.
            </small>
          </div>

          {brainPrompt === 'staged' ? (
            <>
              {overrideField(
                'curator',
                'Override curator prompt',
                'The entire curator prompt, verbatim',
                "While checked, the saved text above IS the curator prompt — what else goes on the map and how it groups — and the addendum is ignored. Unsaved edits and an empty box don't run. Unchecking returns to the default; the text stays saved but inert.",
              )}
              {overrideField(
                'writer',
                'Override writer prompt',
                'The entire writer prompt, verbatim',
                "While checked, the saved text above IS the writer prompt — every card's name and sentence. Unsaved edits and an empty box don't run. Unchecking returns to the default; the text stays saved but inert.",
              )}
            </>
          ) : (
            overrideField(
              'single',
              'Override Brain prompt',
              'The entire Brain prompt, verbatim',
              "While checked, the saved text above IS the single-call Brain prompt, and the addendum is ignored. Unsaved edits and an empty box don't run. Unchecking returns to the default; the text stays saved but inert.",
            )
          )}
        </Section>

        <Section title="Map & data">
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
                <span>
                  {status.llm ? `${status.captureModel} + ${status.brainModel}` : 'not configured — fallback mode'}
                </span>
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
            <button
              className="settings-btn"
              onClick={() => {
                onClose();
                onRebuildNoProfile();
              }}
            >
              Rebuild map now — no profile
              <small>The Brain composes without the user profile — for judging what the profile adds</small>
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
        </Section>
      </div>
    </div>
  );
}
