import { nextAtTimeOccurrence, nextOccurrence } from '../shared/cadence';
import type { Effort } from '../shared/types';
import type { Env } from './env';
import { getTzOffset, listItems, logEvent, newId, nowIso } from './db';
import { sendPush, type PushSubscriptionRecord, type VapidKeys } from './webpush';

// Layer-1 punctual push (§11): deterministic throughout — computed from dates +
// Tier-1, no AI, no map dependency. The reliable floor. Rationed by construction:
// only an event just-before or a hard deadline at its runway ever pushes.

// Effort-scaled runway for hard-deadline DOs (§11.4): a quick task pings near
// its due date, a large project pings well ahead — starting late is the failure.
const RUNWAY_MINUTES: Record<Effort, number> = {
  quick: 120,
  medium: 24 * 60,
  large: 5 * 24 * 60,
};

const DEFAULT_EVENT_LEAD_MINUTES = 45; // "just before" (≈30–60 min)

export interface DueAlert {
  itemId: string;
  occurrenceKey: string; // ISO of the occurrence this alert covers (idempotency)
  title: string;
  body: string;
}

// Pure and testable: which alerts are due at `now`?
export function computeDueAlerts(
  items: {
    id: string;
    type: string;
    status: string;
    title: string;
    eventAt: string | null;
    deadline: string | null;
    deadlineHardness: string | null;
    effort: Effort;
    alertLeadMinutes: number | null;
    cadence: import('../shared/types').Cadence | null;
    createdAt: string;
  }[],
  now: Date,
  tzOffsetMinutes = 0,
): DueAlert[] {
  const fmtTime = (d: Date) => {
    const local = new Date(d.getTime() + tzOffsetMinutes * 60_000);
    const h = local.getUTCHours();
    const m = String(local.getUTCMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'pm' : 'am';
    return `${((h + 11) % 12) + 1}:${m}${ampm}`;
  };
  const alerts: DueAlert[] = [];
  const nowMs = now.getTime();

  for (const item of items) {
    if (item.status !== 'active') continue;

    // HAPPEN events — just before (§11.4), one alert per occurrence.
    if (item.type === 'HAPPEN' && item.eventAt) {
      const leadMs = (item.alertLeadMinutes ?? DEFAULT_EVENT_LEAD_MINUTES) * 60_000;
      const occurrence = item.cadence
        ? nextOccurrence(item.cadence, item.eventAt, now)
        : new Date(item.eventAt);
      const occMs = occurrence.getTime();
      if (nowMs >= occMs - leadMs && nowMs < occMs) {
        alerts.push({
          itemId: item.id,
          occurrenceKey: occurrence.toISOString(),
          title: item.title,
          body: `Coming up at ${fmtTime(occurrence)}`,
        });
      }
    }

    // Hard-deadline DOs — effort-scaled runway (§11.4).
    if (item.type === 'DO' && item.deadline && item.deadlineHardness === 'hard') {
      const runwayMs = RUNWAY_MINUTES[item.effort] * 60_000;
      const dueMs = new Date(item.deadline).getTime();
      if (nowMs >= dueMs - runwayMs && nowMs < dueMs) {
        const hoursLeft = Math.max(1, Math.round((dueMs - nowMs) / 3_600_000));
        alerts.push({
          itemId: item.id,
          occurrenceKey: item.deadline,
          title: item.title,
          body:
            hoursLeft >= 48
              ? `Due in ${Math.round(hoursLeft / 24)} days — needs runway`
              : hoursLeft > 4
                ? `Due in about ${hoursLeft} hours`
                : `Due soon — ${fmtTime(new Date(dueMs))}`,
        });
      }
    }

    // Recurring DOs anchored to a time of day — per occurrence, native (§11.4).
    // atTime is user-local; the occurrence walk runs in the user's frame.
    if (item.type === 'DO' && !item.deadline && item.cadence?.atTime) {
      const occurrence = nextAtTimeOccurrence(item.cadence, item.createdAt, new Date(nowMs - 10 * 60_000), tzOffsetMinutes);
      const occMs = occurrence.getTime();
      if (nowMs >= occMs && nowMs < occMs + 10 * 60_000) {
        alerts.push({
          itemId: item.id,
          occurrenceKey: occurrence.toISOString(),
          title: item.title,
          body: 'Time for this now',
        });
      }
    }
  }
  return alerts;
}

export async function runPushScan(env: Env): Promise<{ sent: number; skipped: number }> {
  const db = env.DB;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { sent: 0, skipped: 0 };

  const subs = await db
    .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions')
    .all<{ id: string; endpoint: string; p256dh: string; auth: string }>();
  if (!subs.results.length) return { sent: 0, skipped: 0 };

  const items = await listItems(db, { statuses: ['active'] });
  const tz = await getTzOffset(db);
  const due = computeDueAlerts(items, new Date(), tz);
  if (!due.length) return { sent: 0, skipped: 0 };

  const vapid: VapidKeys = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT ?? 'mailto:memory@example.com',
  };

  let sent = 0;
  let skipped = 0;
  for (const alert of due) {
    // Idempotency: one alert per item-occurrence, ever (§11.4).
    const already = await db
      .prepare('SELECT 1 FROM sent_alerts WHERE item_id = ? AND occurrence_key = ?')
      .bind(alert.itemId, alert.occurrenceKey)
      .first();
    if (already) {
      skipped++;
      continue;
    }
    await db
      .prepare('INSERT INTO sent_alerts (item_id, occurrence_key, sent_at) VALUES (?,?,?)')
      .bind(alert.itemId, alert.occurrenceKey, nowIso())
      .run();

    const payload = JSON.stringify({ title: alert.title, body: alert.body, itemId: alert.itemId });
    for (const s of subs.results) {
      const rec: PushSubscriptionRecord = { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth };
      try {
        const res = await sendPush(rec, payload, vapid);
        if (res.gone) {
          await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(s.id).run();
        } else if (res.ok) {
          sent++;
        }
      } catch (err) {
        console.error('push send failed', err);
      }
    }
    await logEvent(db, 'system', 'push_sent', {
      itemId: alert.itemId,
      payload: { occurrenceKey: alert.occurrenceKey, body: alert.body },
    });
  }
  return { sent, skipped };
}

export async function saveSubscription(
  env: Env,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    )
    .bind(newId(), sub.endpoint, sub.keys.p256dh, sub.keys.auth, nowIso())
    .run();
}
