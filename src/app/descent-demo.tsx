// Dev-only harness: the Descent instrument fed with the visual spec's sample
// day, no backend needed. Serve with `npx vite dev`, open /descent-demo.html.
// This file is only reachable from descent-demo.html, which is not a build
// input — it never ships.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Bubble, ItemView, MapPayload } from '../shared/types';
import MapView from './views/MapView';
import './styles.css';

const DAY_MS = 86_400_000;
const now = Date.now();
const iso = (t: number) => new Date(t).toISOString();

let itemSeq = 0;
function mkItem(over: Partial<ItemView>): ItemView {
  const id = `it${itemSeq++}`;
  return {
    id,
    type: 'DO',
    title: over.title ?? id,
    rawTexts: [],
    status: 'active',
    deadline: null,
    deadlineHardness: null,
    cadence: null,
    optionality: 'must',
    effort: 'medium',
    pingNatured: false,
    eventAt: null,
    eventEnd: null,
    alertLeadMinutes: null,
    priorityBase: 0.5,
    priorityBoost: 0,
    boostUpdatedAt: null,
    userPriority: null,
    flavourOverride: null,
    createdAt: iso(now - 7 * DAY_MS),
    updatedAt: iso(now),
    lastTouchedAt: iso(now),
    lastCompletedAt: null,
    completionCount: 0,
    streak: 0,
    lastSurfacedAt: null,
    parseConfidence: 1,
    themes: [],
    flavour: 'Task',
    effectivePriority: 0.5,
    neglected: false,
    ...over,
  };
}

// The spec's sample day: cliff after the first card, mid-weight shelf, quiet tail.
const defs: { name: string; p: number; reason: string; kind?: Bubble['kind']; items: ItemView[] }[] = [
  {
    name: "Sarah & Deidra's visit",
    p: 0.95,
    reason: 'They arrive today — the flat needs to be ready before the afternoon.',
    items: [
      mkItem({ title: 'Make up the spare bed', status: 'completed', lastCompletedAt: iso(now - 3600e3), completionCount: 1 }),
      mkItem({ title: 'Buy breakfast things', eventAt: iso(now + 30 * 60e3), type: 'HAPPEN' }),
    ],
  },
  {
    name: 'Renew passport',
    p: 0.66,
    reason: 'The renewal window closes soon and the form still needs photos.',
    items: [mkItem({ title: 'Submit renewal form', deadline: iso(now + 5 * DAY_MS), deadlineHardness: 'hard' })],
  },
  {
    name: "Water Jo's plants",
    p: 0.58,
    reason: "Jo's away until Sunday — the balcony pots dry out fast in July.",
    items: [mkItem({ title: 'Water the balcony pots', deadline: iso(now + 2 * DAY_MS) })],
  },
  {
    name: 'Call the doctor',
    p: 0.55,
    reason: 'Repeat prescription runs out at the end of the week.',
    items: [mkItem({ title: 'Book the appointment', deadline: iso(now + 6 * DAY_MS) })],
  },
  {
    name: 'New address',
    p: 0.45,
    reason: 'Five services still point at the old flat.',
    items: [
      mkItem({ title: 'Bank' }),
      mkItem({ title: 'Electoral roll' }),
      mkItem({ title: 'Dentist' }),
      mkItem({ title: 'Payroll' }),
      mkItem({ title: 'Insurance' }),
    ],
  },
  {
    name: 'Gym rhythm',
    p: 0.42,
    reason: 'Twice-a-week rhythm slipped during the move.',
    items: [mkItem({ title: 'Gym session', cadence: { freq: 'weekly', interval: 1 }, neglected: true })],
  },
  {
    name: 'Birthday gift for Mum',
    p: 0.38,
    reason: 'Her birthday is Aug 2 — posting takes three days.',
    items: [mkItem({ title: 'Choose and order the gift', eventAt: iso(now + 13 * DAY_MS), type: 'HAPPEN' })],
  },
  {
    name: 'Get driving sorted',
    p: 0.3,
    reason: 'Theory test is booked for the 28th.',
    items: [mkItem({ title: 'Theory test', eventAt: iso(now + 8 * DAY_MS), type: 'HAPPEN' })],
  },
  // three EXACT-tie prominences — the same-p cluster case (gauge dots fan
  // around the shared value; ledger rows spread with hairline ties)
  {
    name: 'Make my will',
    p: 0.2,
    reason: 'Started the questionnaire; the draft is waiting.',
    items: [mkItem({ title: 'Finish the questionnaire' })],
  },
  {
    name: 'Play Pragmata',
    p: 0.2,
    reason: 'Finished — settled.',
    items: [mkItem({ title: 'Finish the campaign', status: 'completed', lastCompletedAt: iso(now - DAY_MS), completionCount: 1 })],
  },
  {
    name: 'Read Piranesi',
    p: 0.2,
    reason: 'A chapter before bed keeps it moving.',
    items: [mkItem({ title: 'Read a chapter', type: 'KNOW' })],
  },
  {
    name: 'Rotation',
    p: 0.15,
    kind: 'rotation',
    reason: 'Two quiet things worth a glance today.',
    items: [mkItem({ title: 'Remember: bike lock code moved to notes', type: 'KNOW' })],
  },
];

const items: Record<string, ItemView> = {};
const bubbles: Bubble[] = defs.map((d, i) => {
  for (const it of d.items) items[it.id] = it;
  return {
    id: `bub${i}`,
    day: new Date(now).toISOString().slice(0, 10),
    name: d.name,
    kind: d.kind ?? 'situation',
    prominence: d.p,
    reason: d.reason,
    itemIds: d.items.map((it) => it.id),
  };
});

const map: MapPayload = {
  day: new Date(now).toISOString().slice(0, 10),
  builtAt: iso(now),
  stale: false,
  bubbles,
  capturedToday: [],
  items,
};

function Demo() {
  const [payload, setPayload] = useState(map);
  const toggle = (item: ItemView) => {
    const flipped: ItemView = {
      ...item,
      status: item.status === 'completed' ? 'active' : 'completed',
      lastCompletedAt: item.status === 'completed' ? item.lastCompletedAt : iso(Date.now()),
    };
    setPayload((p) => ({ ...p, items: { ...p.items, [item.id]: flipped } }));
  };
  return (
    <div className="app">
      <main className="view view-descent">
        <MapView
          map={payload}
          nowView="descent"
          onOpenItem={() => {}}
          onToggleComplete={toggle}
          onOrganizeNow={() => {}}
        />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
