import { useEffect, useState } from 'react';
import { api } from '../api';

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
}

export default function SettingsSheet({
  pushOn,
  onEnablePush,
  onRebuild,
  onExport,
  onClose,
}: {
  pushOn: boolean | null;
  onEnablePush: () => void;
  onRebuild: () => void;
  onExport: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    api.status().then((s) => setStatus(s as unknown as Status)).catch(() => {});
  }, []);

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
          <button className="settings-btn" onClick={onExport}>
            Download full backup
            <small>Everything as one JSON file — items, history, themes</small>
          </button>
        </div>
      </div>
    </div>
  );
}
