# Memory

A personal memory-aid PWA for capturing everything and seeing the right things at the right time. Built from [`memory-design-spec.md`](./memory-design-spec.md) — an ADHD companion app whose core bet is separating a curated, dynamic **bubble map** ("what matters now") from a stable, theme-organized **browse view** (the full shelves).

## What's implemented (v1, full spec coverage)

- **Smart Capture (§10)** — one text box captures anything. Raw text is saved unconditionally first; a cheap-tier LLM call segments by intent, classifies into DO / KNOW / HAPPEN, extracts date *phrases* (resolved deterministically with chrono-node, §12), infers deadline hardness / optionality / effort / ping-nature / priority, assigns themes as the emergent-taxonomy "librarian" (§5), and adjudicates recapture-matches against embedding-retrieved candidates (§10.3). Items are created optimistically; nudges (split / low-confidence / merge) surface only when warranted.
- **Recapture-as-boost (§9.3)** — re-entering the same thing boosts the existing item's priority and appends the new phrasing (never rewrites). Visible "Bumped X — Undo" toast; undo reverts the boost and splits the phrasing back out as a compensating event. Priority = base + boosts with slow (21-day half-life) decay; user edit wins.
- **The Brain (§8–9)** — full map rebuild on the first open of each calendar day, behind a loading screen. Items go in fresh; yesterday's bubbles are passed separately as "reuse only if apt" (anti-stickiness, §8.2); situation-name vocabulary carries forward for linguistic stability. Top-tier LLM call clusters by *situation*, ranks prominence qualitatively (urgency, importance, effort/runway, forgettability), rotates life-triggered KNOWs quietly, and event-linked KNOWs ride their situations. Same-day captures land in a deterministic **Captured Today** bucket; completions update the map in place with no Brain call.
- **Tier-0/1/2 history (§7)** — append-only structured event log with compensating corrections; deterministic per-item aggregates (neglect is *computed*, never logged); daily AI-written user profile from the raw 30-day window, read by both the Brain and Smart Capture (§10.4). Librarian restructures record one-line notes.
- **Browse / Calendar / Search (§6)** — themes × flavour filter; a native calendar lens (HAPPENs, DO deadlines, recurrence occurrences); hybrid keyword (FTS5) + semantic (embedding) search, lightly lifted by priority/recency.
- **Flavour (§4)** — Task / Goal / Reminder / Event / Note derived from type + parameters (never stored), with a presentation-only override that never touches behaviour.
- **Layer-1 punctual push (§11)** — deterministic 5-minute cron scan: HAPPENs just-before (default 45 min, per-event override), hard-deadline DOs at effort-scaled runway (quick 2h / medium 1d / large 5d), per-occurrence for recurrences, idempotent per item-occurrence. Web Push (VAPID + RFC 8291 aes128gcm) implemented on raw WebCrypto — no Node dependencies.

Everything the spec marks reliable is deterministic code; the LLM only curates. **With no API key configured, the app still fully works** on a heuristic parser and a deterministic fallback map — that's also the local-dev experience.

## Stack

- **Cloudflare Worker** (Hono) serving both the API and the built PWA (static assets)
- **D1 (SQLite)** — items, captures, event log, themes, bubbles, profiles, push subscriptions, FTS5 index
- **Anthropic API** — Smart Capture on a cheap/fast tier, the Brain on the top tier (§12 model routing); models set in `wrangler.jsonc` vars
- **Workers AI** (`bge-base-en-v1.5`) for embeddings, stored as Float32 blobs in D1 with brute-force cosine — at the spec's expected volume (§7.5, 1–4 items/day) a vector DB is unnecessary; swap in Vectorize if item count ever grows by orders of magnitude
- **React + Vite** PWA: bubble map (SVG, deterministic spiral layout — size = prominence, colour = theme), browse, calendar, search, item edit sheet, service worker for offline shell + push

## Local development

```sh
npm install
npm run db:migrate:local
npm run dev          # builds the app, starts wrangler dev on :8787
```

Open http://localhost:8787. Without secrets you get the deterministic fallback parser/map. To exercise the real AI paths locally:

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .dev.vars
```

For frontend iteration with hot reload, run `npm run dev:app` (Vite on :5173, proxying `/api` to :8787) alongside `npx wrangler dev`.

```sh
npm test             # unit tests (flavour, priority decay, cadence, dates, push rules, parsing)
npm run check        # typecheck
```

## Deploy to Cloudflare

```sh
npx wrangler d1 create memory-db        # put the returned id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put ANTHROPIC_API_KEY

# Web Push (optional but recommended):
node scripts/generate-vapid-keys.mjs
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT   # e.g. mailto:you@example.com

npm run deploy
```

Then open the deployed URL, "Add to Home Screen", and tap the bell to enable alerts.

**Note:** the app is single-user by design (one DB = one person's memory). Put it behind Cloudflare Access (zero-trust) or deploy per-user; there is no auth layer in v1.

## Repo layout

```
migrations/          D1 schema
src/shared/          pure logic + types (flavour, priority, cadence, dates, heuristic parser) — unit-tested
src/worker/          Hono API: capture pipeline, Brain, items/browse/calendar/search, push, webpush crypto
src/app/             React PWA: views, bubble layout, edit sheet, capture bar
public/              manifest, service worker, icons
scripts/             VAPID keygen, icon rendering, UI smoke test
```

## Post-v1 (deliberately deferred by the spec)

Reader UI for the activity feed (§7.4), bubble pin/dismiss (§8.5), mid-day debounced rebuilds and scheduled precompute (§9.1), behavioural telemetry & learned notification timing (§11.6), numeric prominence weights (§9.2), Google Calendar sync (§13).
