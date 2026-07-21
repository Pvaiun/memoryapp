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
    affects: [],
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

const theme = (name: string) => [{ id: `th-${name}`, name }];

// The card-specimen day: every construction and brick — a woven card with
// chips and a span rail, a batch with pips, a nudge with its ledge, a
// deadline notch, a rotation frame, a settled card, and the same-p tie
// cluster. Sentences are written in the card grammar against item ids.
const defs: {
  name: string;
  p: number;
  sentence: (ids: string[]) => string;
  firstStep?: string;
  kind?: Bubble['kind'];
  items: ItemView[];
}[] = [
  {
    name: "Sarah & Deidra's visit",
    p: 0.95,
    items: [
      mkItem({ title: 'Clean the litter boxes', themes: theme('Home-Visitors') }),
      mkItem({ title: 'Make up the guest room', themes: theme('Home-Visitors') }),
      mkItem({
        title: 'Sarah & Deidra staying',
        type: 'HAPPEN',
        eventAt: iso(now - 2 * 3600e3),
        eventEnd: iso(now + 4 * DAY_MS),
        themes: theme('Home-Visitors'),
      }),
    ],
    sentence: (ids) =>
      `**Sarah & Deidra** arrive **today** through the **25th**, vegetarian this year — the [litter boxes](${ids[0]}) by noon, and the [guest room](${ids[1]}) before they land.`,
  },
  {
    name: 'Renew passport',
    p: 0.66,
    items: [
      mkItem({ title: 'Submit renewal form', deadline: iso(now + 5 * DAY_MS), deadlineHardness: 'hard', themes: theme('Admin') }),
    ],
    sentence: (ids) => `The [renewal form](${ids[0]}) still needs photos — the window closes **Friday**.`,
  },
  {
    name: 'New address',
    p: 0.45,
    items: [
      mkItem({ title: 'Bank', themes: theme('Move') }),
      mkItem({ title: 'Electoral roll', themes: theme('Move') }),
      mkItem({ title: 'Dentist', themes: theme('Move'), status: 'completed', lastCompletedAt: iso(now - 3600e3), completionCount: 1 }),
      mkItem({ title: 'Payroll', themes: theme('Move') }),
      mkItem({ title: 'Insurance', themes: theme('Move') }),
    ],
    sentence: (ids) =>
      `Five **address updates**, one sitting — the [bank](${ids[0]}), the [electoral roll](${ids[1]}), the [dentist](${ids[2]}), [payroll](${ids[3]}), and [insurance](${ids[4]}).`,
  },
  {
    name: 'Make my will',
    p: 0.42,
    items: [mkItem({ title: 'Sort out the will', effort: 'large', themes: theme('Life-Admin') })],
    sentence: () => `**The will** is still waiting on its **first step** — no date, nothing started.`,
    firstStep: 'Name the first ten minutes — what would you start with?',
  },
  {
    name: 'Gym rhythm',
    p: 0.4,
    items: [
      mkItem({ title: 'Gym session', cadence: { freq: 'weekly', interval: 1 }, neglected: true, themes: theme('Health') }),
    ],
    sentence: (ids) => `The twice-a-week rhythm slipped in the move — a [gym session](${ids[0]}) today would restart it.`,
  },
  {
    name: 'Birthday gift for Mum',
    p: 0.38,
    items: [
      mkItem({ title: 'Choose and order the gift', deadline: iso(now + 9 * DAY_MS), themes: theme('Family') }),
    ],
    sentence: (ids) => `**Mum's birthday** is **Aug 2** and posting takes three days — [choose the gift](${ids[0]}) this week.`,
  },
  {
    name: 'Get driving sorted',
    p: 0.3,
    items: [mkItem({ title: 'Theory test', eventAt: iso(now + 8 * DAY_MS), type: 'HAPPEN', themes: theme('Driving') })],
    sentence: () => `The **theory test** is booked for the **28th** — revision fits in the evenings.`,
  },
  // three EXACT-tie prominences — the same-p cluster case (gauge dots fan
  // around the shared value; ledger rows spread with hairline ties)
  {
    name: 'Call the doctor',
    p: 0.2,
    items: [
      mkItem({ title: 'Book the appointment', deadline: iso(now + 4 * DAY_MS), deadlineHardness: 'hard', themes: theme('Health') }),
    ],
    sentence: (ids) => `Two-minute [call to the doctor](${ids[0]}) — the referral expires **Friday**.`,
  },
  {
    name: 'Play Pragmata',
    p: 0.2,
    items: [
      mkItem({ title: 'Finish the campaign', status: 'completed', lastCompletedAt: iso(now - DAY_MS), completionCount: 1, themes: theme('Fun') }),
    ],
    sentence: () => `**Pragmata** — the campaign wraps up tonight.`,
  },
  {
    name: 'Read Piranesi',
    p: 0.2,
    items: [mkItem({ title: 'Read a chapter', type: 'KNOW', themes: theme('Reading') })],
    sentence: () => `A chapter of **Piranesi** before bed keeps it moving.`,
  },
  {
    name: 'Keep in mind',
    p: 0.15,
    kind: 'rotation',
    items: [mkItem({ title: 'Bike lock code moved to notes', type: 'KNOW', themes: theme('Home') })],
    sentence: () => `Worth a glance: the **bike lock code** moved to **notes**.`,
  },
];

const items: Record<string, ItemView> = {};
const bubbles: Bubble[] = defs.map((d, i) => {
  for (const it of d.items) items[it.id] = it;
  const ids = d.items.map((it) => it.id);
  const sentence = d.sentence(ids);
  return {
    id: `bub${i}`,
    day: new Date(now).toISOString().slice(0, 10),
    name: d.name,
    kind: d.kind ?? 'situation',
    prominence: d.p,
    reason: sentence.replace(/\*\*|\[|\]\([^)]*\)/g, ''),
    sentence,
    firstStep: d.firstStep ?? null,
    itemIds: ids,
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
