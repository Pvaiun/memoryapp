import { useState } from 'react';
import type { AffectTag, Cadence, Flavour, ItemView } from '../../shared/types';
import { AFFECT_TAGS } from '../../shared/types';
import { FLAVOURS } from '../../shared/flavour';
import { eventPassed, isDoneForNow } from '../../shared/cadence';
import { api } from '../api';

// The review/edit surface (§10.2): every AI-inferred field independently
// editable, the item independently rejectable. Flavour override is
// presentation-only (§4) — relabelling never changes behaviour.

const pad = (n: number) => String(n).padStart(2, '0');

// The two input shapes, one per precision: an all-day date edits as a bare
// date and a moment edits as a date + clock. Switching the toggle re-reads the
// same instant through the other shape, so no typing is lost either way.
function toLocalInput(iso: string | null, allDay: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return allDay ? date : `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// An all-day value is written back at local noon — the anchor the parser uses,
// chosen so the date lands on the right calendar day in every timezone. The
// precision flag travels with it, so nothing downstream has to infer that noon
// was an anchor rather than a time the user picked.
function fromLocalInput(v: string, allDay: boolean): string | null {
  if (!v) return null;
  if (!allDay) return new Date(v).toISOString();
  const [y, m, d] = v.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0).toISOString();
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
  const [allDay, setAllDay] = useState(item.datePrecision === 'day');
  const [deadline, setDeadline] = useState(toLocalInput(item.deadline, item.datePrecision === 'day'));
  const [hardness, setHardness] = useState(item.deadlineHardness ?? 'hard');
  const [cadence, setCadence] = useState<Cadence | null>(item.cadence);
  const [optionality, setOptionality] = useState(item.optionality);
  const [effort, setEffort] = useState(item.effort);
  const [eventAt, setEventAt] = useState(toLocalInput(item.eventAt, item.datePrecision === 'day'));
  const [eventEnd, setEventEnd] = useState(toLocalInput(item.eventEnd, item.datePrecision === 'day'));
  const [showOnCal, setShowOnCal] = useState(item.showOnCalendar);
  const [priority, setPriority] = useState(Math.round(item.effectivePriority * 100));
  const [priorityTouched, setPriorityTouched] = useState(false);
  const [flavourOverride, setFlavourOverride] = useState<Flavour | ''>(item.flavourOverride ?? '');
  const [themes, setThemes] = useState(item.themes.map((t) => t.name).join(', '));
  const [affects, setAffects] = useState<AffectTag[]>([...new Set((item.affects ?? []).map((a) => a.tag))]);
  const [saving, setSaving] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeDate, setSnoozeDate] = useState('');

  // Flipping the toggle re-reads whatever is already typed through the other
  // input shape rather than clearing it: dropping to a date keeps the date,
  // and adding a time starts from noon — the anchor the value already carried,
  // which the user then edits rather than being handed a surprise midnight.
  const switchAllDay = (next: boolean) => {
    if (next === allDay) return;
    const carry = (v: string) => (v ? (next ? v.slice(0, 10) : `${v.slice(0, 10)}T12:00`) : '');
    setDeadline(carry(deadline));
    setEventAt(carry(eventAt));
    setEventEnd(carry(eventEnd));
    setAllDay(next);
  };

  const allDayToggle = (
    <div className="field" style={{ maxWidth: 170 }}>
      <label>Time</label>
      <div className="seg">
        <button className={allDay ? 'on' : ''} onClick={() => switchAllDay(true)}>
          All day
        </button>
        <button className={!allDay ? 'on' : ''} onClick={() => switchAllDay(false)}>
          At a time
        </button>
      </div>
    </div>
  );

  const save = async () => {
    setSaving(true);
    try {
      const { item: fresh } = await api.editItem(item.id, {
        title,
        type,
        deadline: type === 'DO' ? fromLocalInput(deadline, allDay) : null,
        deadlineHardness: type === 'DO' && deadline ? hardness : null,
        datePrecision: allDay ? 'day' : 'time',
        cadence: type === 'KNOW' ? null : cadence,
        optionality,
        effort,
        eventAt: type === 'HAPPEN' ? fromLocalInput(eventAt, allDay) : null,
        eventEnd: type === 'HAPPEN' ? fromLocalInput(eventEnd, allDay) : null,
        showOnCalendar: showOnCal,
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

  // Snooze: park without closing — off the map and silent until the wake day,
  // still active and badged in Browse/Search. Wake days anchor at local noon
  // like every all-day date; the server compares sleep days, so the item
  // returns with the wake day's morning map.
  const snoozed = item.status === 'active' && !!item.snoozedUntil;
  const snoozeUntil = (iso: string | null) => {
    if (iso) void applyExit(api.snoozeItem(item.id, iso));
  };
  const snoozeFor = (days: number) => {
    const d = new Date();
    snoozeUntil(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 12, 0, 0, 0).toISOString());
  };

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
                <input
                  type={allDay ? 'date' : 'datetime-local'}
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                />
              </div>
              {allDayToggle}
            </div>
            {deadline && (
              <div className="field-row">
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
              </div>
            )}
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
          <>
            <div className="field-row">
              <div className="field">
                <label>When</label>
                <input
                  type={allDay ? 'date' : 'datetime-local'}
                  value={eventAt}
                  onChange={(e) => setEventAt(e.target.value)}
                />
              </div>
              {allDayToggle}
            </div>
            <div className="field-row">
              <div className="field">
                <label>Until (optional)</label>
                <input
                  type={allDay ? 'date' : 'datetime-local'}
                  value={eventEnd}
                  onChange={(e) => setEventEnd(e.target.value)}
                />
              </div>
            </div>
          </>
        )}

        {/* Recurrence-only: one-offs always paint their dates. Whether a
            rhythm earns calendar presence is the parser's guess (§6) — this
            is the override. */}
        {(type === 'DO' ? cadence : type === 'HAPPEN' ? item.cadence : null) && (
          <div className="field">
            <label>On the calendar</label>
            <div className="seg">
              <button className={showOnCal ? 'on' : ''} onClick={() => setShowOnCal(true)}>
                Show
              </button>
              <button className={!showOnCal ? 'on' : ''} onClick={() => setShowOnCal(false)}>
                Hide
              </button>
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

        {snoozed && (
          <p className="snoozed-note">
            Snoozed until {new Date(item.snoozedUntil!).toLocaleDateString([], { month: 'long', day: 'numeric' })} — off
            the map and silent until then.
          </p>
        )}
        {item.status === 'active' && !snoozed && snoozeOpen && (
          <div className="field">
            <label>Snooze — hide from the map until</label>
            <div className="seg">
              <button onClick={() => snoozeFor(7)}>A week</button>
              <button onClick={() => snoozeFor(30)}>A month</button>
              <button onClick={() => snoozeFor(90)}>3 months</button>
            </div>
            <div className="field-row" style={{ marginTop: 8, alignItems: 'flex-end' }}>
              <div className="field">
                <input type="date" value={snoozeDate} onChange={(e) => setSnoozeDate(e.target.value)} />
              </div>
              <button disabled={!snoozeDate} onClick={() => snoozeUntil(fromLocalInput(snoozeDate, true))}>
                That day
              </button>
            </div>
          </div>
        )}

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
          {/* Snooze is the softer "not now": dismiss says it stopped
              mattering; snooze says not for a while, don't lose it. */}
          {item.status === 'active' && !spentEvent && !snoozed && (
            <button onClick={() => setSnoozeOpen((o) => !o)}>{snoozeOpen ? 'Never mind' : 'Snooze…'}</button>
          )}
          {snoozed && <button onClick={() => applyExit(api.unsnoozeItem(item.id))}>Wake</button>}
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
