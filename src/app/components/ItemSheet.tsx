import { useState } from 'react';
import type { AffectTag, Cadence, Flavour, ItemView } from '../../shared/types';
import { AFFECT_TAGS } from '../../shared/types';
import { FLAVOURS } from '../../shared/flavour';
import { eventPassed, isDoneForNow } from '../../shared/cadence';
import { api } from '../api';

// The review/edit surface (§10.2): every AI-inferred field independently
// editable, the item independently rejectable. Flavour override is
// presentation-only (§4) — relabelling never changes behaviour.

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

const CADENCE_PRESETS: { label: string; value: Cadence | null }[] = [
  { label: 'None', value: null },
  { label: 'Daily', value: { freq: 'daily', interval: 1 } },
  { label: 'Weekly', value: { freq: 'weekly', interval: 1 } },
  { label: 'Monthly', value: { freq: 'monthly', interval: 1 } },
];

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export default function ItemSheet({
  item,
  onClose,
  onChanged,
  onDeleted,
}: {
  item: ItemView;
  onClose: () => void;
  onChanged: (item: ItemView) => void;
  onDeleted: (id: string) => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [type, setType] = useState(item.type);
  const [deadline, setDeadline] = useState(toLocalInput(item.deadline));
  const [hardness, setHardness] = useState(item.deadlineHardness ?? 'hard');
  const [cadence, setCadence] = useState<Cadence | null>(item.cadence);
  const [optionality, setOptionality] = useState(item.optionality);
  const [effort, setEffort] = useState(item.effort);
  const [eventAt, setEventAt] = useState(toLocalInput(item.eventAt));
  const [eventEnd, setEventEnd] = useState(toLocalInput(item.eventEnd));
  const [priority, setPriority] = useState(Math.round(item.effectivePriority * 100));
  const [priorityTouched, setPriorityTouched] = useState(false);
  const [flavourOverride, setFlavourOverride] = useState<Flavour | ''>(item.flavourOverride ?? '');
  const [themes, setThemes] = useState(item.themes.map((t) => t.name).join(', '));
  const [affects, setAffects] = useState<AffectTag[]>([...new Set((item.affects ?? []).map((a) => a.tag))]);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const { item: fresh } = await api.editItem(item.id, {
        title,
        type,
        deadline: type === 'DO' ? fromLocalInput(deadline) : null,
        deadlineHardness: type === 'DO' && deadline ? hardness : null,
        cadence: type === 'KNOW' ? null : cadence,
        optionality,
        effort,
        eventAt: type === 'HAPPEN' ? fromLocalInput(eventAt) : null,
        eventEnd: type === 'HAPPEN' ? fromLocalInput(eventEnd) : null,
        priority: priorityTouched ? priority / 100 : undefined,
        flavourOverride: flavourOverride || null,
        themes: themes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        affects,
      });
      onChanged(fresh);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const reject = async () => {
    if (!confirm('Remove this item? Its raw capture text is kept in history.')) return;
    await api.rejectItem(item.id);
    onDeleted(item.id);
    onClose();
  };

  const applyExit = async (call: Promise<{ item: ItemView }>) => {
    const { item: fresh } = await call;
    onChanged(fresh);
    onClose();
  };

  // Lifecycle exits (per flavour). The positive exit is 'completed' everywhere
  // it exists, labelled in the flavour's own words; events have no positive
  // exit — they pass on their own (neutral) or get flagged missed (the fail).
  const oneShotEvent = item.type === 'HAPPEN' && !item.cadence;
  const spentEvent = oneShotEvent && (item.status === 'passed' || eventPassed(item, Date.now()));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grabber" />
        <div className="field">
          <label>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div className="field">
          <label>Kind</label>
          <div className="seg">
            {(['DO', 'KNOW', 'HAPPEN'] as const).map((t) => (
              <button key={t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>
                {t === 'DO' ? 'To do' : t === 'KNOW' ? 'To know' : 'Happens'}
              </button>
            ))}
          </div>
        </div>

        {type === 'DO' && (
          <>
            <div className="field-row">
              <div className="field">
                <label>Deadline</label>
                <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </div>
              {deadline && (
                <div className="field" style={{ maxWidth: 150 }}>
                  <label>Hardness</label>
                  <div className="seg">
                    <button className={hardness === 'hard' ? 'on' : ''} onClick={() => setHardness('hard')}>
                      Hard
                    </button>
                    <button className={hardness === 'soft' ? 'on' : ''} onClick={() => setHardness('soft')}>
                      Soft
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="field-row">
              <div className="field">
                <label>Rhythm</label>
                <div className="seg">
                  {CADENCE_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      className={(cadence?.freq ?? null) === (p.value?.freq ?? null) ? 'on' : ''}
                      onClick={() =>
                        setCadence((prev) => {
                          if (!p.value) return null;
                          // Re-tapping the active rhythm keeps its day/time
                          // details; switching frequency keeps the time only.
                          if (prev?.freq === p.value.freq) return prev;
                          return { ...p.value, ...(prev?.atTime ? { atTime: prev.atTime } : {}) };
                        })
                      }
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              {cadence && (
                <div className="field" style={{ maxWidth: 150 }}>
                  <label>At time</label>
                  <input
                    type="time"
                    value={cadence.atTime ?? ''}
                    onChange={(e) => {
                      const { atTime: _drop, ...rest } = cadence;
                      setCadence(e.target.value ? { ...rest, atTime: e.target.value } : rest);
                    }}
                  />
                </div>
              )}
            </div>
            {cadence?.freq === 'weekly' && (
              <div className="field">
                <label>On days</label>
                <div className="seg">
                  {WEEKDAY_LABELS.map((label, day) => (
                    <button
                      key={day}
                      className={cadence.byWeekday?.includes(day) ? 'on' : ''}
                      onClick={() => {
                        const days = cadence.byWeekday?.includes(day)
                          ? (cadence.byWeekday ?? []).filter((d) => d !== day)
                          : [...(cadence.byWeekday ?? []), day].sort();
                        const { byWeekday: _drop, ...rest } = cadence;
                        setCadence(days.length ? { ...rest, byWeekday: days } : rest);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="field-row">
              <div className="field">
                <label>Must / nice to do</label>
                <div className="seg">
                  <button className={optionality === 'must' ? 'on' : ''} onClick={() => setOptionality('must')}>
                    Must
                  </button>
                  <button className={optionality === 'nice' ? 'on' : ''} onClick={() => setOptionality('nice')}>
                    Nice
                  </button>
                </div>
              </div>
              <div className="field">
                <label>Effort</label>
                <div className="seg">
                  {(['quick', 'medium', 'large'] as const).map((e) => (
                    <button key={e} className={effort === e ? 'on' : ''} onClick={() => setEffort(e)}>
                      {e === 'quick' ? 'Quick' : e === 'medium' ? 'Medium' : 'Big'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {type === 'HAPPEN' && (
          <div className="field-row">
            <div className="field">
              <label>When</label>
              <input type="datetime-local" value={eventAt} onChange={(e) => setEventAt(e.target.value)} />
            </div>
            <div className="field">
              <label>Until (optional)</label>
              <input type="datetime-local" value={eventEnd} onChange={(e) => setEventEnd(e.target.value)} />
            </div>
          </div>
        )}

        <div className="field-row">
          <div className="field">
            <label>Priority ({priority >= 65 ? 'high' : priority >= 40 ? 'medium' : 'low'})</label>
            <input
              type="range"
              min={0}
              max={100}
              value={priority}
              onChange={(e) => {
                setPriority(parseInt(e.target.value, 10));
                setPriorityTouched(true);
              }}
            />
          </div>
          <div className="field" style={{ maxWidth: 150 }}>
            <label>Shown as</label>
            <select value={flavourOverride} onChange={(e) => setFlavourOverride(e.target.value as Flavour | '')}>
              <option value="">{item.flavour} (auto)</option>
              {FLAVOURS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label>Themes (comma-separated)</label>
          <input value={themes} onChange={(e) => setThemes(e.target.value)} placeholder="Home, Health" />
        </div>

        <div className="field">
          <label>Felt as (from your phrasing)</label>
          <div className="seg wrap">
            {AFFECT_TAGS.map((t) => (
              <button
                key={t}
                className={affects.includes(t) ? 'on' : ''}
                onClick={() =>
                  setAffects((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
                }
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="sheet-actions">
          <button className="danger" onClick={reject}>
            Remove
          </button>
          {item.status === 'active' && item.type === 'KNOW' && (
            <button onClick={() => applyExit(api.completeItem(item.id))}>Got it</button>
          )}
          {item.status === 'active' && item.type === 'DO' && item.cadence && (
            <button onClick={() => applyExit(api.completeItem(item.id, true))}>Achieved</button>
          )}
          {/* A spent event can't be cancelled anymore — its exits are pass
              (automatic) or missed; Dismiss covers everything still open. */}
          {item.status === 'active' && !spentEvent && (
            <button onClick={() => applyExit(api.dismissItem(item.id))}>Dismiss</button>
          )}
          {(item.status === 'passed' || (item.status === 'active' && spentEvent)) && (
            <button onClick={() => applyExit(api.missItem(item.id))}>Missed it</button>
          )}
          {(item.status === 'dismissed' || item.status === 'missed') && (
            <button onClick={() => applyExit(api.reopenItem(item.id))}>
              {item.status === 'missed' ? 'Not missed' : 'Restore'}
            </button>
          )}
          {(item.status === 'completed' || (item.type === 'DO' && item.status === 'active' && isDoneForNow(item))) && (
            <button onClick={() => applyExit(api.uncompleteItem(item.id))}>
              {item.status === 'completed' ? 'Un-complete' : 'Not done today'}
            </button>
          )}
          <button className="primary" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {item.rawTexts.length > 0 && (
          <ul className="phrasings">
            {[...item.rawTexts].reverse().map((r, i) => (
              <li key={i}>
                <span>{new Date(r.ts).toLocaleDateString()}</span>
                {r.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
