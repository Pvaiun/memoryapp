import type { ItemView } from '../../shared/types';
import { isClosedStatus } from '../../shared/types';
import { describeCadence, isDoneForNow, nextAtTimeOccurrence, nextOccurrence } from '../../shared/cadence';
import { EARLY_MORNING_CUTOFF_MINUTES, sleepDayDiffLocal } from '../../shared/dates';
import { FLAVOUR_ICONS, itemColor, tzOffsetMinutes } from '../api';

export function priorityColor(p: number): string {
  if (p >= 0.65) return 'var(--danger)';
  if (p >= 0.4) return 'var(--warn)';
  return 'var(--text-faint)';
}

// Day distances are sleep-cycle days (5am boundary, same as localDay): a 1am
// deadline reads "today" through the evening before it, not as tomorrow.
function fmtDate(iso: string): string {
  const d = new Date(iso);
  const days = sleepDayDiffLocal(d.getTime(), Date.now());
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `today ${time}`;
  if (days > 0 && days < 7)
    return d.toLocaleDateString([], { weekday: 'short' }) + (iso.includes('T12:00:00') ? '' : ` ${time}`);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// The app's "today" is the sleep-cycle day (5am boundary, same as localDay):
// its start anchors the current occurrence, its end is when doneness releases.
function sleepDayStart(): Date {
  const d = new Date(Date.now() - EARLY_MORNING_CUTOFF_MINUTES * 60_000);
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + EARLY_MORNING_CUTOFF_MINUTES * 60_000);
}

// A recurring DO's next occurrence at or after `from`, anchored the same way
// the worker anchors its occurrence math (eventAt ?? createdAt).
function nextOccurrenceFrom(item: ItemView, from: Date): Date | null {
  if (!item.cadence) return null;
  const anchor = item.eventAt ?? item.createdAt;
  return item.cadence.atTime
    ? nextAtTimeOccurrence(item.cadence, anchor, from, tzOffsetMinutes())
    : nextOccurrence(item.cadence, anchor, from);
}

export default function ItemRow({
  item,
  onOpen,
  onToggleComplete,
}: {
  item: ItemView;
  onOpen: (item: ItemView) => void;
  onToggleComplete: (item: ItemView) => void;
}) {
  // Recurring DOs never reach status='completed' — their checked state is
  // doneToday, released again when the sleep-cycle day rolls (5am).
  const closed = isClosedStatus(item.status);
  const done = isDoneForNow(item);
  const doneToday = !closed && done && item.status !== 'completed';
  // A rhythm without a set time ("read 30 min/day") has no occurrence to tick
  // off — its button is a "did it" ping, rendered as a circle, not a checkbox.
  const rhythm = !!item.cadence && !item.cadence.atTime;
  // Done → the occurrence after today's; not done and time-anchored → the
  // pending occurrence ("today 9:30pm"). Both label as "next …": it names the
  // occurrence the rhythm is waiting on, never how long the checkmark lasts —
  // that always releases at the sleep-day rollover.
  const nextOcc = doneToday
    ? nextOccurrenceFrom(item, new Date(sleepDayStart().getTime() + 86_400_000))
    : null;
  const dueOcc =
    !done && item.status === 'active' && item.cadence?.atTime ? nextOccurrenceFrom(item, sleepDayStart()) : null;
  const dueLabel = dueOcc && dueOcc.getTime() >= Date.now() ? fmtDate(dueOcc.toISOString()) : null;
  const overdue =
    item.type === 'DO' && item.status === 'active' && item.deadline && new Date(item.deadline).getTime() < Date.now();

  return (
    <div className={`item-row${done || closed ? ' done' : ''}`} onClick={() => onOpen(item)}>
      {item.type === 'DO' && (item.status === 'active' || item.status === 'completed') ? (
        <button
          className={`check${done ? ' done' : ''}${rhythm ? ' ping' : ''}`}
          aria-label={
            done
              ? item.cadence
                ? 'Undo — not done today'
                : 'Mark not done'
              : rhythm
                ? 'Did it — keep the rhythm'
                : 'Mark done'
          }
          onClick={(e) => {
            e.stopPropagation();
            onToggleComplete(item);
          }}
        >
          ✓
        </button>
      ) : (
        <div
          className="check know"
          style={{ borderColor: itemColor(item), color: itemColor(item), fontSize: 11 }}
        >
          {FLAVOUR_ICONS[item.flavour]}
        </div>
      )}
      <div className="body">
        <div className="title">{item.title}</div>
        <div className="meta">
          <span>
            {FLAVOUR_ICONS[item.flavour]} {item.flavour}
          </span>
          {item.deadline && (
            <span className={overdue ? 'overdue' : ''}>
              {overdue ? 'overdue · ' : 'due '}
              {fmtDate(item.deadline)}
              {item.deadlineHardness === 'soft' ? ' (soft)' : ''}
            </span>
          )}
          {item.eventAt && (
            <span>
              {fmtDate(item.eventAt)}
              {item.eventEnd && ` – ${fmtDate(item.eventEnd)}`}
            </span>
          )}
          {item.cadence && <span>{describeCadence(item.cadence)}</span>}
          {closed && item.status !== 'completed' && <span>{item.status}</span>}
          {doneToday && (
            <span className="done-today">done today{nextOcc ? ` · next ${fmtDate(nextOcc.toISOString())}` : ''}</span>
          )}
          {dueLabel && <span>{dueLabel.startsWith('today') ? dueLabel : `next ${dueLabel}`}</span>}
          {item.cadence && item.streak > 1 && <span className="streak">{item.streak} in a row</span>}
          {item.neglected && <span className="neglected">slipping</span>}
          {item.themes.slice(0, 2).map((t) => (
            <span key={t.id} style={{ color: itemColor(item) }}>
              {t.name}
            </span>
          ))}
        </div>
      </div>
      <span
        className="priority-dot"
        style={{ background: priorityColor(item.effectivePriority), color: priorityColor(item.effectivePriority) }}
      />
    </div>
  );
}
