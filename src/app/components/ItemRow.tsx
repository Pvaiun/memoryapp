import type { ItemView } from '../../shared/types';
import { describeCadence } from '../../shared/cadence';
import { FLAVOUR_ICONS, itemColor } from '../api';

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

export default function ItemRow({
  item,
  onOpen,
  onToggleComplete,
}: {
  item: ItemView;
  onOpen: (item: ItemView) => void;
  onToggleComplete: (item: ItemView) => void;
}) {
  const done = item.status === 'completed';
  const overdue =
    item.type === 'DO' && item.status === 'active' && item.deadline && new Date(item.deadline).getTime() < Date.now();

  return (
    <div className={`item-row${done ? ' done' : ''}`} onClick={() => onOpen(item)}>
      {item.type === 'DO' ? (
        <button
          className={`check${done ? ' done' : ''}`}
          aria-label={done ? 'Mark not done' : 'Mark done'}
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
