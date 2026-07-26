import { nextAtTimeOccurrence, nextOccurrence } from '../shared/cadence';
import { sleepDayOf } from '../shared/dates';
import type { DatePrecision, Effort } from '../shared/types';
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

// All-day items have no moment, so the punctual path has nothing true to
// measure from — run against a noon anchor it produced "Due soon — 12:00pm"
// at 10am for a time the user never said, then went silent for the rest of
// the day. They get one sweep instead, at an hour the user is awake.
//
// Deliberately NOT the sleep-day boundary. A day-precision item becomes late
// at 5am, and that is the right answer for STATE — the map rebuilds then and
// composes the miss into its prose. It is the wrong answer for SPEECH: a
// stack of notifications at 4am is no use to anybody. The boundary governs
// what is true; this hour governs when we say anything.
const DAY_SWEEP_HOUR = 21; // 9pm user-local
const DAY_SWEEP_WINDOW_MS = 10 * 60_000;

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
    datePrecision?: DatePrecision;
    effort: Effort;
    alertLeadMinutes: number | null;
    cadence: import('../shared/types').Cadence | null;
    createdAt: string;
    lastCompletedAt?: string | null;
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
  const today = sleepDayOf(nowMs, tzOffsetMinutes);
  // Minutes into the user's local wall-clock day — the sweep is scheduled by
  // the hour the user sees, not by the sleep-day offset.
  const local = new Date(nowMs + tzOffsetMinutes * 60_000);
  const sweepDueMs = (local.getUTCHours() * 60 + local.getUTCMinutes() - DAY_SWEEP_HOUR * 60) * 60_000;
  const inSweepWindow = sweepDueMs >= 0 && sweepDueMs < DAY_SWEEP_WINDOW_MS;
  const openAllDay: string[] = [];

  for (const item of items) {
    if (item.status !== 'active') continue;

    // All-day items due TODAY and still open, gathered for the evening sweep.
    // Nothing punctual fires for them; the runway path below skips them too.
    //
    // Today only, deliberately. Something all-day that went overdue days ago
    // is the map's to carry — the morning build composes it into the card's
    // prose, where it can be said once and in context. Re-pushing it every
    // evening would be the same nagging the punctual path was doing, just on
    // a slower clock.
    if (
      item.type === 'DO' &&
      item.datePrecision === 'day' &&
      item.deadline &&
      sleepDayOf(new Date(item.deadline).getTime(), tzOffsetMinutes) === today &&
      sleepDayOf(new Date(item.lastCompletedAt ?? 0).getTime(), tzOffsetMinutes) !== today
    ) {
      openAllDay.push(item.title);
    }

    // HAPPEN events — just before (§11.4), one alert per occurrence.
    // An all-day event has no moment to be just-before, and nothing to tick
    // off either, so it gets no punctual alert and no sweep — the morning map
    // is where "Gabe comes over today" belongs.
    if (item.type === 'HAPPEN' && item.eventAt && item.datePrecision !== 'day') {
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

    // Hard-deadline DOs — effort-scaled runway (§11.4). Timed deadlines only:
    // a runway measured back from an all-day item's noon anchor lands at an
    // arbitrary hour and speaks a due time the user never gave.
    if (item.type === 'DO' && item.deadline && item.deadlineHardness === 'hard' && item.datePrecision !== 'day') {
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

  // One evening sweep for everything all-day still open, as a single push —
  // not one per item, which is what made the punctual path wrong for these in
  // the first place. Keyed on the sleep day so it can only fire once, and
  // attributed to the first open item so tapping it opens something real.
  if (inSweepWindow && openAllDay.length) {
    alerts.push({
      itemId: DAY_SWEEP_ITEM_ID,
      occurrenceKey: `day-sweep:${today}`,
      title: openAllDay.length === 1 ? openAllDay[0] : `${openAllDay.length} still open today`,
      body: openAllDay.length === 1 ? 'Still open today' : openAllDay.slice(0, 3).join(' · '),
    });
  }
  return alerts;
}

// The evening sweep is about the day, not one item, so it has no item to
// point at. Push delivery treats a non-uuid id as "just open the app".
export const DAY_SWEEP_ITEM_ID = '__day-sweep__';

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
