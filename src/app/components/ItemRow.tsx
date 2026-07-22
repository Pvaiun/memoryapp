import type { ItemView } from '../../shared/types';
import { describeCadence, isDoneForNow, nextAtTimeOccurrence, nextOccurrence } from '../../shared/cadence';
import { FLAVOUR_ICONS, itemColor, tzOffsetMinutes } from '../api';

export function priorityColor(p: number): string {
  if (p >= 0.65) return 'var(--danger)';
  if (p >= 0.4) return 'var(--warn)';
  return 'var(--text-faint)';
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.round((d.getTime() - now.getTime()) / 86_400_000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (Math.abs(days) < 1 && d.getDate() === now.getDate()) return `today ${time}`;
  if (days >= 0 && days < 7)
    return d.toLocaleDateString([], { weekday: 'short' }) + (iso.includes('T12:00:00') ? '' : ` ${time}`);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// A recurring DO's next occurrence after today's — what "done today" hands
// back to ("back Thu 9:30pm"). Anchored the same way the worker anchors its
// occurrence math (eventAt ?? createdAt).
function nextOccurrenceAfterToday(item: ItemView): Date | null {
  if (!item.cadence) return null;
  const tomorrow = new Date();
  tomorrow.setHours(24, 0, 0, 0);
  const anchor = item.eventAt ?? item.createdAt;
  return item.cadence.atTime
    ? nextAtTimeOccurrence(item.cadence, anchor, tomorrow, tzOffsetMinutes())
    : nextOccurrence(item.cadence, anchor, tomorrow);
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
  // doneToday, released again at the local-day rollover.
  const done = isDoneForNow(item);
  const doneToday = done && item.status !== 'completed';
  // A rhythm without a set time ("read 30 min/day") has no occurrence to tick
  // off — its button is a "did it" ping, rendered as a circle, not a checkbox.
  const rhythm = !!item.cadence && !item.cadence.atTime;
  const nextOcc = doneToday ? nextOccurrenceAfterToday(item) : null;
  const overdue =
    item.type === 'DO' && item.status === 'active' && item.deadline && new Date(item.deadline).getTime() < Date.now();

  return (
    <div className={`item-row${done ? ' done' : ''}`} onClick={() => onOpen(item)}>
      {item.type === 'DO' ? (
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
          {doneToday && (
            <span className="done-today">done today{nextOcc ? ` · back ${fmtDate(nextOcc.toISOString())}` : ''}</span>
          )}
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
