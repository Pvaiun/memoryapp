# Memory — Design Specification

*Living document, built collaboratively. Intended as the source spec a developer (e.g. a Claude Code instance) will build the first version from, then iterate on.*

---

## How to read this document

Every non-obvious decision carries a status tag, so nothing provisional is mistaken for final:

- **[SETTLED]** — decided and agreed.
- **[PROPOSED]** — recommended, awaiting an explicit yes/no.
- **[OPEN]** — not yet designed; tracked in the queue in §14.
- **[PARKED]** — deliberately deferred to a later iteration.

**Coverage so far:** this version specifies the backend entity model (including the DO parameter model, §3.1), the full presentation/taxonomy layer, the history log + user profile, the bubble model & lifecycle, and the Brain in full (§9) — run cadence, generation logic, and priority. Smart Capture's parsing half, notifications/delivery, and several smaller systems are still in the queue (§14).

---

## 1. Purpose & core idea

Memory is a personal memory-aid app for a user who needs help remembering and acting on a large volume of tasks, intentions, facts, and events. The core loop is **capture** (getting things in with near-zero friction) and **surfacing** (getting the *right* things back out at the *right* time).

The central design bet — and what distinguishes Memory from an ordinary task app or calendar: a normal browse view becomes overwhelming *precisely because* the user needs to remember so much. The very volume that makes the app necessary is the volume that makes a flat list or calendar unusable. Memory solves this by separating two primary surfaces:

- a dynamic, curated **bubble map** — the "what matters right now" view, analogous to a bestseller kiosk at the front of a densely packed bookstore; and
- a stable **browse view** — the full shelves, organized by theme.

The kiosk makes the store navigable without the user having to parse every shelf. This separation is the heart of the app.

---

## 2. Architecture: a decoupled stack

**Foundational principle:** how an item is *stored and surfaced* is fully decoupled from how it is *displayed and named*. Surfacing operates on functional structure; presentation operates on themes and a friendlier vocabulary. The same underlying item can surface for functional reasons (a deadline, neglect, contextual relevance) while being filed and labelled for the user by theme and flavour.

Four layers, from engine to surface:

1. **Backend type** — DO / KNOW / HAPPEN. Functional. Drives lifecycle and how items are surfaced. Never shown to the user and not edited directly. **[SETTLED]** (§3)
2. **Surfacing** — the rules / AI judgement deciding *when and why* an item appears, and how items cluster in the bubble map. Operates on backend type + parameters + history. **[SETTLED]** (§9.2)
3. **Presentation** — two distinct surfaces: a **dynamic** bubble map, and a **stable** browse view organized by theme and filterable by flavour. **[SETTLED]** (§6 shape; §8 bubble model; §9 Brain).
4. **Vocabulary** — **flavour** (Task / Goal / Reminder / Event / Note), the user-facing words. **[SETTLED]** — flavour is the user-facing vocabulary, derived from backend type + parameters with presentation-only user overrides (§4).

The most important consequence: the bubble map's clustering and the theme taxonomy are **two independent taxonomies with no hard-coded relationship** (§6). **[SETTLED]**

---

## 3. Backend entity model — DO / KNOW / HAPPEN  **[SETTLED]**

Every captured item is exactly one of three backend types, defined by lifecycle:

- **DO** — something the user *does*; it has a *done* state (even when completion is optional, even when it recurs). Surfaced by deadline, neglect, or priority. DO carries many parameters (deadline, cadence/recurrence, priority, optionality, etc.), and these parameters are what let a single type present to the user as a Task, a Goal, or an actionable Reminder. *Examples: "clean the house"; "read my anxiety book 30 min/day"; "water the plants."*
- **KNOW** — something the user *knows*; it never has a *done*. It is simply true, and is surfaced by contextual relevance (when its trigger is app-legible) or by rehearsal rotation (when it is not) — see §9.2. *Examples: "Sarah is allergic to nuts"; "be firm with boundaries at the Saturday check-in."*
- **HAPPEN** — something that *occurs at a time* and then is past (not "completed" — it happened). Maps to the calendar. *Examples: "doctor's appointment Tuesday 3pm"; "Sarah visits this weekend."*

**What this replaces from the original requirements doc:**

- The original **Reminder** entity is dissolved. Its content splits between (a) a *flavour* label on top of DO/KNOW, and (b) the *notification/prompting mechanism* (now settled, §11). "Reminder" is no longer a storage type.
- **Event** is now a first-class entity (= HAPPEN), distinct from a Task: a Task is something you do and complete; an Event is something that occurs.

**Optionality is a property, not a type. [SETTLED]** Must-do vs nice-to-do is a dial on an item (like priority), not a separate kind of thing. "Call the dentist" is the same item whether urgent or optional; only a parameter differs. The same logic dissolved Goal/Reminder/Task into parameter variations of DO.

### 3.1 DO parameter model  **[SETTLED]**

DO carries the parameters that let one backend type present as Task, Goal, or Reminder and that drive how it surfaces. They were named across §3, §4, and §9.2 but defined nowhere; this is their authoritative home. Each is **inferred by Smart Capture and user-overridable** — never a required field (the same light-touch principle as priority, §9.3).

- **Deadline — a nullable due-date plus a hardness flag.** A DO may have no deadline, or a due-date tagged **hard** (completion-gating — a real cutoff; missing it is a failure, e.g. "taxes due the 15th") or **soft** (an aspirational target; missing it just slips, e.g. "finish reading by month-end"). **Hardness is orthogonal to optionality** — "must-do with a soft internal target" and "optional-but-hard-external-cutoff" are both real, so hardness cannot be derived from optionality. **The default on a plainly-stated date is *hard*** (softened only by explicit low-pressure phrasing — "ideally," "sometime," "no rush"): for a memory aid the core failure is *missing* things, so erring toward surfacing fails safer, and §9.2's non-dominant-urgency design keeps a hard deadline from swamping the map. This is the distinction §4's derivation needs — a *hard* deadline → Task; loose cadence with no hard deadline → Goal.
- **Cadence / recurrence — one shared RRULE-like model**, reused across DO cadence and HAPPEN (pulled forward from the parked recurrence item, §14.1). For a DO, cadence is a **rhythm that drives neglect-nudging** — *now − last-completed* checked against it (§7.2) — **not a hard gate**: a missed occurrence resurfaces the item, it does not fail it. Exotic recurrence rules stay parked in §14.1; what lands here is the shared core model and its neglect-nudging role. (There is no GCal sync in v1, so its exception/timezone handling is moot — §13.)
- **Optionality — binary must-do / nice-to-do, orthogonal to priority.** Something can be *important but optional* (a passion project) or *trivial but mandatory* (a required form), so optionality is not a low-priority proxy. Its surfacing effect is to **dampen urgency** — an optional deadline nudges but cannot dominate the map — while priority still guarantees the item a slot (§9.2). Inferred from phrasing ("maybe," "if I get to it").
- **Effort / lead-time — a coarse magnitude** (quick / medium / large-project), not precise hours. It **widens the runway** ahead of a deadline so big tasks surface earlier — "do taxes" outranks "call grandma" at equal due date (§9.2). Inferred, overridable.
- **Priority — see §9.3.** Fully specified there (capture-inferred base + recapture boosts + time decay, editable at confirm). Listed here only for completeness; not re-specified.

**These map cleanly onto §9.2's four ranking factors:** *urgency* ← due-date × hardness × optionality; *importance* ← priority; *effort / lead-time* ← effort; *forgettability* stays a Brain-side heuristic, not a stored parameter.

---

## 4. Flavour  **[SETTLED]**

Flavour is the closed, user-facing vocabulary that names items in human terms and drives the browse view's filter. Working set: **Task, Goal, Reminder, Event, Note**.

- **[SETTLED]** Flavour is a stable, closed set, distinct from both backend type and theme. The user can filter the browse view by flavour.
- **[SETTLED] Derived, not stored.** Flavour is *derived* from backend type + parameters, never stored as its own type — so a shown flavour can never contradict the item's actual surfacing behaviour, because it *is* a view of the behaviour-driving parameters. This keeps three honest backend types while giving the user richer language. The **active v1 derivation** (first match wins):
  1. KNOW → **Note**
  2. HAPPEN → **Event**
  3. DO that Smart Capture reads as **ping-natured** — a nudge to do a small thing, not a deliverable (§10) → **Reminder**
  4. DO with a **hard** deadline → **Task**
  5. DO with recurrence/cadence and no hard deadline → **Goal**
  6. DO otherwise (no hard deadline, no cadence) → **Task** (the default DO flavour)

  **The Reminder-vs-Task boundary — inferred, not mechanical.** An alert can't distinguish them (a Task carries one too); the line is **ping vs deliverable**, and it is genuinely semantic — so **Smart Capture infers it at capture (§10)**: "remind me to take the bins out" reads as a ping (Reminder), "finish the report by Friday" as a deliverable (Task). This is the one flavour whose trigger is an inferred *character* rather than a mechanical parameter threshold, because ping-vs-deliverable is not mechanical. It is checked first (rule 3): a ping with a hard-ish deadline — "move the car by 6 pm" — is still a Reminder, and since flavour is presentation-only its deadline parameter still drives urgent surfacing regardless of the label. Always user-overridable (below).
- **[SETTLED] Override is presentation-only.** The user can override an item's flavour, but the override is a **stored display-flavour that lives in the presentation layer and *wins* over the derived value — it does *not* mutate the item's parameters.** Two reasons: a labelling choice must never silently change surfacing behaviour (the "why did this move?" friction §9.1 avoids), and a presentation-layer choice must not reach down and mutate the engine (the decoupling §2 enforces everywhere else). If the user wants different *behaviour*, they change the deadline/priority directly — relabel and re-behave stay separate. Cost is one sparse nullable field, empty for every non-overridden item (the common case), so backend types stay honest.
- **[SETTLED] Reminder, now activated.** "Reminder" began as a deliberate placeholder — kept in the vocabulary while its push mechanism (§11) was unbuilt. With §11 settled and the ping-vs-deliverable boundary now inferred by Smart Capture (rule 3), it is a live derivation. Still reachable **by override** (a user can label anything "Reminder").
- **[SETTLED] The Task/Goal deadline edge — closed.** Resolved by the **deadline-hardness** flag now defined in §3.1: only a *hard* deadline forces Task, so a loose-cadence DO with merely a *soft* target (e.g. "read 30 min/day, ideally done by month-end") correctly derives as **Goal**. A soft deadline is invisible to derivation — it only gentles how the item surfaces, it does not decide Task vs Goal.

---

## 5. Themes  **[SETTLED unless noted]**

Themes are the stable spine of the browse view — the user's filing system and the calm counterweight to the bubble map. (Called "categories" in the original requirements doc.)

- **Emergent, not predefined.** There is no seed taxonomy. Themes are created, merged, renamed, and deleted by Smart Capture acting as a "librarian," as it processes captures. The taxonomy is expected to stabilize naturally as data accumulates. **Convergence mode: emerge raw** — start from zero themes, show whatever exists, and accept (and enjoy) early messiness. No seeding, no hiding of the browse view while the taxonomy is immature.
- **Multi-theme.** An item can belong to more than one theme (e.g. "clean the house before Sarah visits" → Home *and* Relationships). Multi-theme is what keeps the browse view findable from multiple entry points rather than rigidly filed under one.
- **No-dangling invariant.** An item's theme-set is never empty. Enforced at delete/merge: the librarian may not remove a theme until any item for which it was the *last* remaining theme has been re-homed. (Cheap under multi-theme — rarely more than a few items per reorganization.)
- **Authority & override.** The librarian assigns themes; the user can override. Theme membership is user-editable.
- **[SETTLED] Restructure notes.** When the librarian reorganizes (merge / delete / rename), it records a one-line rationale (e.g. "merged Errands into Home; too few items to stand alone"), so the taxonomy's evolution stays legible to the user. This matches the app's transparency elsewhere (visible merges, §10.1; no silent moves, §9.1) and is the natural content for the deferred Reader UI (§7.4). Low-cost — one line per restructure.
- **[PARKED] Primary vs secondary themes.** Deferred until the browse view is designed in detail. Where a single representative theme is needed for display, default to most-recently-assigned. Not load-bearing for v1.

---

## 6. The surfaces & the two taxonomies  **[SETTLED]**

This is the core differentiating mechanism of the app.

**Bubble map — dynamic.** Built by the Brain. Bubbles are *situational clusters* with dynamic names and contents, frequently pulling items from *multiple* themes at once (e.g. a "Before Sarah visits" bubble mixing a Home DO, a Relationship KNOW, and an errand). Answers: *what should I attend to now?* (Bubble model & lifecycle in §8; the Brain's *generation* logic in §9.2.)

**Browse view — stable.** Organized by theme, filterable by flavour. Answers: *where does this live / let me find my X.*

**Calendar view — a third lens.** A native month/week calendar rendering the time-anchored items Memory already owns: HAPPENs on their dates, DO deadlines, and Reminders at their times. A pure *presentation lens* over the same backend (§2) — no new taxonomy, no separate store — sitting beside the map and browse as a third way to look at the same items. Answers: *what does my schedule look like?* (This replaced a planned Google Calendar integration: the goal was a calendar UI, which a native view delivers with no sync at all; two-way GCal sync is parked as an optional later add-on, §13.)

**Smart Search — the reliable find path.** A search box: the direct way to *find my X* when you know roughly what you're after. It is **hybrid** — full-text **keyword** matching for precision, plus **semantic** embedding search for gist recall ("Sarah's food thing" finds "Sarah is allergic to nuts"), because you usually remember the shape of a thing, not its exact words. The semantic half is nearly free infrastructure: it **reuses the embeddings already computed for recapture-match (§10.3)**. Search covers **raw captured text (§11) and structured fields** (theme, flavour), ranked by relevance and lightly lifted by priority/recency. Crucially it is **deterministic and always-available** — not AI-*curated* like the bubble map, it simply finds what matches — so it sits on the reliable side of the reliable-vs-advisory split (§7): a path you can trust to surface something you *know* is in there. *(Deferred: LLM query-understanding — interpreting a full conversational question — which would add a model call per search; keyword + semantic is the v1 engine.)*

**The two taxonomies are independent.** Bubble clustering (dynamic, situational, cross-theme) has **no hard-coded relationship** to the theme taxonomy (stable filing). An item's theme does not determine which bubble it appears in, and vice versa. This independence is the central feature: it lets the bubble map stay curated and un-overwhelming even while the browse view holds the full, necessarily large body of everything the user needs to remember.

**Bubble visual encoding (v1) — two channels.** A bubble shows **size = prominence** (§9.2) and **colour = theme**; nothing else. Shape and glow, considered as extra encoding channels, are cut for v1: glow would double-encode urgency (which already lives inside prominence, hence size), and a fourth visual variable is noise for an aid whose whole job is to *not* overwhelm. Both can return later if observation shows a real need.

---

## 7. History Log & User Profile  **[SETTLED]**

The app needs a memory of its own activity over time — the substrate for neglect nudging, for the eventual personalization, and (later) for notification timing. It is a layered design: a raw immutable log at the bottom, deterministic counters in the middle, and a small AI-written profile on top. The layering exists for one reason: **everything that must be reliable is computed deterministically and never depends on the AI summary.**

### 7.1 Tier-0 — the raw event log

A single append-only event stream, immutable, retained forever (trivial at this scale — see §7.5). It runs *alongside* items that hold their own current state; the app does **not** reconstruct current state by replaying events (this is not event-sourcing). The log is a record, not the source of present truth.

- **Each event is a structured record**, never an opaque string: timestamp, actor (`user` / `ai` / `system`), event type, item reference, and a before→after payload. This matters even though there is no reader UI yet (§7.4): because the log is append-only and immutable, anything not captured at write-time is lost permanently. Structured-and-reversible costs nothing now and is the whole difference between "a readable, undoable history later" and "data we wish we'd kept."
- **Typed event + open payload.** A fixed list of event types is deliberately *not* committed; adding a type later is a new type, not a schema migration. v1 logs **state changes** — created, completed, edited, re-themed, dismissed, and the like — with the explicit expectation that the set will grow. Behavioural/engagement telemetry (app opens, bubble views, snoozes) is **not** logged in v1; it is the basis for smart notification timing and can be added when that is designed. **[PARKED]**
- **Immutable correction model.** History cannot be edited or deleted. A correction *appends a compensating event* — e.g. a task marked complete in error logs a later "reverted" event. The item's own state stays mutable (you can un-complete it), but the log keeps both entries, so the record never pretends the misfire didn't happen.

### 7.2 Tier-1 — deterministic aggregates

Per-item counters maintained on every write: last-completed, completion count, current streak, last-touched, and similar. **Not AI.** Backend representation is left to the developer.

This tier is what makes the *reliable* features reliable. **Neglect is computed, never logged:** "haven't done X in two weeks" is simply *now − last-completed* checked against the item's cadence, so absence needs no event and no AI. Neglect nudging and recurrence read these counters directly and **never touch the profile** — the things that must not be wrong do not depend on a soft summary.

### 7.3 Tier-2 — the user profile

A small, freeform-prose summary of the user's patterns and habits, written by the AI for the Brain to read (e.g. "checks in mornings; reliably skips Health items; cleaning tends to spike before guests"). It is **layered on top of** the exact Tier-1 numbers, never replacing them: numbers stay precise, prose is the AI's scratchpad for nuance.

- **Advisory, not decisive.** The profile is an *add-on* that gives the Brain flavour and context. It is explicitly **not** a gate on decisions, and Memory is **not** a behaviour-prediction app. Anything that must be correct lives in Tier-1.
- **Records surfacing *and* capture nuance.** Alongside surfacing habits (check-in times, skipped themes), the profile notes capture-relevant patterns drawn from correction events (§10.4) — filing / re-theming tendencies, priority-adjustment tendencies, over/under-splitting — so Smart Capture has something to read.
- **Recompute from raw, not incremental folding.** Each refresh regenerates the profile from a trailing window of *raw* Tier-0 events; it does **not** summarize the previous profile. This is affordable at this data volume (§7.5) and avoids compounding interpretation — a bad profile self-corrects on the next run from ground truth instead of calcifying. No compaction, no incremental fold, no drift.
- **Trailing window = 30 days** for v1 (tunable). The window *is* the recency mechanism; there is no separate "recent events" tier.
- **Refresh cadence:** recomputed when the Brain fires its daily run (§9.1). It feeds the Brain and — for correction-derived parse bias — Smart Capture (§10.4); both read the current daily profile, so there is no reason to recompute more often than that daily run.
- **Known limitation, accepted for v1.** A trailing window has no long-term memory: a yearly pattern, or "always rough around the holidays," is invisible if it predates the window. This is acceptable precisely because the profile is advisory — anything that must persist lives in Tier-1 — and the window can be widened cheaply later (a full year is still well within budget at this volume).

### 7.4 Reader UI  **[SETTLED — deferred to post-v1]**

When built, a deliberately plain **reverse-chronological, read-only activity feed**: each entry is one logged event (captured / edited / completed / dismissed, §7.1) with its timestamp and a tap-through to the item, optionally filterable by item or event type. It is the natural home for the librarian's restructure notes (§5) and for undo. It is **deferred — not required for v1**, and the Tier-0 log is already captured in structured, reversible form (§7.1) precisely so this can be built later with no backfill.

### 7.5 Data-volume note (why this stays simple)

Expected input is roughly **1–4 items/day, with occasional bursts of ~10**, so a 30-day window is on the order of 60–120 events — comfortably within a single Brain call. This is why the design needs no tiered compaction, no incremental summarization, and no streaming aggregation: at this scale, recompute-from-raw is both the simplest and the least lossy option. If volume ever grew by orders of magnitude, Tier-2's recompute strategy is the part that would need revisiting; Tiers 0 and 1 scale fine regardless.

---

## 8. Bubble Model & Lifecycle  **[SETTLED]**

Bubbles are how the Brain presents *what matters now* (§6). This section fixes what a bubble **is** as an object and how its lifecycle behaves. How the Brain *generates* bubbles — the clustering and naming logic — is covered separately in §9.2.

### 8.1 Persistent object, transient feel

A bubble is technically a **persistent object with a stable ID**, so it *can* carry across refreshes, be reused by a future mid-day full rebuild, and be pointed at by the history log (§7). But to the user, bubbles should **feel transient**: persistence is something that *may* happen, never something guaranteed. The Brain is free to delete and recreate bubbles indiscriminately.

The central risk this section exists to prevent: **baked-in accidental stickiness.** An LLM handed yesterday's bubbles as "the current map" treats their existence as a default to preserve, even with no instruction to. The data structure must not bias the Brain toward keeping old bubbles. Persistence must be a capability the Brain *reaches for*, never the path of least resistance.

### 8.2 Rebuild-from-scratch is the default; carry-over is an active choice

- The morning Brain run builds the map **fresh from the items** (plus profile and recent activity), exactly as it would on day one with no prior bubbles.
- Yesterday's bubbles are supplied **separately and secondarily**, framed as *"previously shown, available to reuse only if still apt"* — never merged into the working set as "the current map."
- This framing is load-bearing, not cosmetic: it makes the model *compose from items and optionally reconcile*, rather than *edit an inherited map*. It prevents stickiness structurally instead of merely asking the Brain not to be sticky.

### 8.3 Bubbles carry zero user overrides (v1)

v1 bubbles have **no user-facing override controls**: no pin, no dismiss, no manual bubble reprioritization. The only user interactions with a bubble are **viewing** it (expanding to see contents) and **acting on the items inside** (completing them — which is item state, recorded per §7).

Rationale: the app's core bet is that the Brain surfaces the right things. Shipping overrides on day one would mask whether the Brain is good enough on its own, and rob you — as both the user and the developer — of the failure signals needed to improve it. The daily full rebuild bounds the downside: any bad bubble has a lifespan of at most one day. This leaves the bubble object carrying **no override obligation at all**, which is the cleanest possible v1 — bubbles are purely Brain-managed.

*(Item-level priority — an item's own importance value, as distinct from reprioritizing a bubble — is now settled in §9.3: inferred by Smart Capture, boosted by recapture, faded by decay, editable at confirm. What is cut here is only bubble-level override, not item priority.)*

### 8.4 Why bubbles persist at all (the non-override reasons)

The persistent object earns its place without ever requiring stickiness. **In v1 the one active reason is continuity:** the daily rebuild receives yesterday's bubbles as optional *"reuse if still apt"* input (§8.2), which requires them to persist day-to-day. A deferred mid-day full rebuild (§9.1) would lean on this same continuity — reusing earlier bubbles the same way, just more often — so it adds no new persistence requirement. One further, genuinely distinct reason activates as a deferred feature lands: a bubble's stable ID is the natural referent for history-log records of what was shown (telemetry deferred, §7.1).

### 8.5 Deferred, with known approaches

- **Pin — [PARKED].** When added: a pin **freezes a bubble's membership and lifts it out of the Brain's churn** — it becomes a static, user-owned object the Brain never sees in its working set, so no stickiness leaks into the fresh rebuild and its shape cannot drift. Item *completion state* stays live inside it (you watch progress accrue across days, which is the point); only membership is frozen. Unpin returns it to the churn. Cutting it from v1 is cheap to reverse precisely because of this quarantine design.
- **Dismiss — [PARKED].** When added: the intended meaning is **"Not Now"** — hide this grouping for today, leave the underlying items unaffected, expire at the next full daily rebuild (transient, bubble-scoped). The other readings — *"I've handled these items"* (better served by an item-level snooze) and *"this grouping is wrong"* (clustering feedback, genuinely hard) — are explicitly out of scope. Note: deferring dismiss also removes the cross-run question of how a mid-day full rebuild should treat a dismissed bubble — with no dismiss, there is no override for the rebuild to honor.

---

## 9. The Brain  **[SETTLED]**

The Brain builds the bubble map from the user's items, profile (§7.3), and recent activity. It covers **when it runs** (§9.1), **how it generates and ranks bubbles** (§9.2), and **how priority works** (§9.3).

### 9.1 Run cadence & triggers  **[SETTLED]**

**One algorithm, not two.** There is a single Brain operation: a **full rebuild** of the bubble map from the current items (plus profile and the 30-day event window, §7). The earlier plan's separate "cheap targeted incremental" pass is **dropped** — a partial "slot this new item into the existing map" update is exactly the *edit-an-inherited-map* mode §8.2 forbids (it reintroduces stickiness), and at this data volume a full rebuild is already cheap, so a second algorithm would add complexity to solve a cost problem that does not exist.

**Trigger: the first app-open of each new calendar day.** The rebuild fires on the first open of the day, not on a fixed cron — so no Brain call is spent on days the app isn't opened, and the map is built against the day the user actually arrives into.

- **A loading screen is shown while that rebuild runs.** The map is deliberately **not** shown stale-then-swapped-behind. Rationale: the core interaction is frictionless, many-times-a-day checking, and seeing information shift or self-correct even once is the friction we are avoiding — better to wait once at a loading screen than to learn to distrust the map.
- **Subsequent opens the same day are instant** — they show that morning's already-built map. No loading screen, no Brain call.
- **Within-day changes are deterministic — no Brain call.** Completing an item updates the map in place (grey / remove). New captures do **not** trigger the Brain; they land in a deterministic **"Captured Today"** bucket (the original doc's "New Today," repurposed) that shows them instantly and losslessly until the next morning's rebuild folds them into real bubbles.

**The daily run also recomputes the user profile (§7.3).** So "daily run" = full refresh including profile; in v1 there are no other Brain runs.

**Deferred experiments (try later, after observing real usage):**

1. **Mid-day Brain rebuilds for new captures.** Rather than new items waiting in the "Captured Today" bucket until tomorrow, a **debounced** full rebuild (a couple of minutes after capture activity goes quiet, so a burst becomes a single rebuild) would fold them into real bubbles the same day. Buys mid-day intelligence at the cost of several Brain calls on busy days. Worth adding **only if** observation shows the user actively reads the map *through* the day, rather than mostly capturing through the day and reading it in the morning. Cost levers if added: a per-day rebuild cap, a wider debounce, or rebuilding only for captures made while the app is open.
2. **Scheduled precompute (cron) instead of open-triggered rebuild.** If the open-triggered rebuild + loading screen proves too slow to feel frictionless, switch to precomputing the map on a schedule (e.g. early morning) so it is ready instantly on first open. The tradeoff is the one set aside here: a cron may build against a stale guess of the day and spends a call even on unopened days. Decide from observed rebuild latency and open patterns.

### 9.2 Generation logic  **[SETTLED]**

How the Brain turns a flat pile of items into a small, scannable set of named bubbles. The output target is not "good groupings" but *a good map*: few enough things to take in at a glance, each one actionable, with the most pressing surfaced hardest.

**Organizing principle: situation.** A bubble is built around a *situation or context* — the moment you would act — e.g. "Before Sarah visits," "Morning routine," "At the computer." Not primarily by time (that is just a normal task list), and **not** by theme — theme-based bubbles would mirror the browse view and collapse the two-taxonomies design that is the whole point (§6). Situational grouping is the ADHD-friendly answer to *"what do I do now?"* Time pressure is a *force that pulls items into the relevant situation and raises their prominence*, not a bubble of its own.

**Prominence, not inclusion, is the scarce resource.** There is no cap on bubbles; the map scrolls. Not every item appears, but **anything important gets a slot, even if small, regardless of how many other bubbles exist.** This demands a wide prominence range: a visitor four weeks out is a small, persistent dot; today's overdue taxes is a large, loud bubble. "Small but present" is the v1 home for everything important-but-not-urgent — the visitor example generalized.

**Prominence ranking blends four factors — described qualitatively, never as a formula.** The Brain weighs **urgency** (deadline proximity), **importance** (= priority, §9.3), **effort / lead-time** (long tasks surface earlier because they need runway — "do taxes" outranks "call grandma" at equal due date), and **forgettability**. Plus one tiebreak: when items *could* group, prefer grouping them. These are given to the Brain in plain language ("don't let a flat due-date sort bury a big important thing"), and it judges. **No hand-tuned numeric weights in v1** — a numeric scoring system is a v1.1 optimization to design *after* watching the qualitative version, not before. [PARKED]

**Naming: linguistically consistent, not logically.** Run-to-run stability comes mainly from a stable *name vocabulary*, not from frozen groupings. The Brain carries its recent situation-names forward as input (the §8.2 "reuse if apt" pattern applied to names): reuse an existing name when semantically apt ("Morning routine," never a synonym like "Morning chores" that would cause needless reshuffle), but coin a *new* name when the situation genuinely differs (don't force-fit Before-Work items into "Morning routine"). This kills the cosmetic drift — same group, renamed — that would otherwise make rebuilds feel unstable, without forcing logically-stable groupings.

**Surfacing KNOWs.** KNOWs have no deadline and no completion, so a plain urgency ranking buries them by construction — yet they are among the things ADHD users most need resurfaced. The app has **no sensor for most KNOW triggers**, so KNOWs split into two populations, handled differently:

- *Event-linked KNOWs* (minority) — the trigger is app-legible because it is *in the app* (Sarah's allergy ↔ Sarah's visit). **Contextual surfacing:** the KNOW rises when its associated situation is live. Nearly free — it is the situational engine again.
- *Life-triggered KNOWs* (majority) — the trigger is a state the app cannot sense (overwhelm, cooking, a hard conversation). Contextual surfacing is *impossible* here; there is no signal to fire on. Instead, **rehearsal rotation:** periodically resurface these at low prominence, favouring important and not-recently-seen ones, so they stay *warm* — mentally available for when the moment comes. The win condition is not "ping me at the exact moment" (unknowable) but "I've seen this enough lately that it's near top of mind." This is the same decay engine as priority (§9.3), run as resurfacing.

  *Rotation scope (settled).* Auto-rotate **all** standing KNOWs; let decay (§9.3) carry off jot-once trivia (so "carrots take 3 minutes," entered once and never reinforced, fades out of rotation) while repeatedly-touched KNOWs stay warm — so recapture is the *de facto* "keep warm" marker with no separate gesture. Rotation is deliberately **quiet**: a small, low-prominence slice, a few at a time — a memory aid that keeps showing you things you already know becomes wallpaper you stop seeing. Under-rotate rather than over-rotate.

  *Honest limit — the reactive floor.* The app is proactive exactly as far as its information reaches. Event-linked KNOWs are genuinely proactive; rehearsal is semi-proactive (reactive to *learn*, proactive to *maintain*); the true reactive floor is a one-off KNOW with no app-legible trigger that is never reinforced — it returns only via recapture or a chance rotation lift. That is the honest edge of what is knowable from inside the app, not a defect. If observation shows important things living at that floor, the first *real* proactive lever (scheduled check-ins, an explicit "keep warm" flag, a morning KNOW slot) gets added then — from data, not guessed now.

**Relevant working set.** At the expected volume (§7.5), the working set is effectively the full active-item set and rebuilds stay cheap. Because rehearsal rotation *samples* KNOWs rather than surfacing all of them each run, the ever-growing KNOW pile need not be fully considered for prominence every time — which naturally bounds its contribution. Bounding the working set further (relevance filtering, sampling) is a scale-contingency to revisit only if item count grows by orders of magnitude; not a v1 concern.

### 9.3 Priority  **[SETTLED — in v1]**

Priority is the **importance** input to prominence ranking (§9.2). It is a v1 concept — this resolves the original audit's "priority may be deferrable" flag — but it is *inferred and behavioural*, never a manual priority-setting chore. (The manual-priority-field burden we were wary of is avoided: the system proposes, the user rarely touches it.)

**Smart Capture sets priority at capture time.** Default **medium**. Smart Capture *proposes* higher or lower from the user's own phrasing — "this is really important" → high; a casual aside → low. The user can adjust it in the confirm prompt (a light, optional override — not a required field). *(These priority responsibilities are settled here; the rest of Smart Capture's parsing flow is in §10 — flow settled at §10.1, sub-parts §10.2–10.4 open.)*

**Recapture-as-boost — the behavioural-salience mechanism.** When Smart Capture judges a new input to be the same as / extremely similar to an existing item, it **raises the existing item's priority** instead of creating a duplicate. Salience becomes behavioural: the things you keep thinking about rise, with zero deliberate effort. *Example:* "Sarah only likes soy milk" (low) → later "remember Sarah likes soy milk" (medium) → "Sarah got pissed, it's really important to get soy milk" (high).

- **v1 rule: detect the match, raise priority, and *append* the new phrasing** — do **not** synthesise a merged replacement. Appending preserves the user's exact words (never silently rewrite a capture — the memory-aid cardinal rule) and leaves a visible escalation trail. Merging into a single clean phrasing is deferred until dedup detection is trusted. [PARKED]
- Recapture is also *the* observable salience signal for life-triggered KNOWs (§9.2): the app cannot sense your life, but repeated entry tells it what is live right now. So recapture-match **detection** is load-bearing for the whole KNOW story — not merely a de-duplication nicety. (The detection mechanics are in §10.3.)

**Time decay.** Priority boosts **fade** if an item is not recaptured or acted on for a while, so salience reflects what has been on your mind *lately*, not cumulatively — without decay, every item ratchets toward high and priority stops discriminating. Decay is deliberately **slow**: slow enough that a fading item is seen enough times before it loses prominence (this is what feeds rehearsal rotation, §9.2). The decay rate is a hidden parameter — start slow, tune from observation. Completing a DO also naturally clears its accumulated boost; time decay is what handles KNOWs, which never complete.

**Composition.** Displayed priority = a capture-inferred **base**, moved up by recapture **boosts** and faded by time **decay**, with a user **edit** at confirm taking precedence (mapping the earlier rule: user override > dynamic adjustment > Brain base). The Brain reads priority as the *importance* input to prominence (§9.2): priority governs *how hard* something surfaces among things eligible to surface — it does not by itself decide eligibility.

---

## 10. Smart Capture — the parsing half  **[SETTLED]**

Smart Capture turns a raw capture into confirmed, structured item(s). Several of its responsibilities are settled elsewhere: priority inference + recapture-as-boost/append (§9.3), the theme-"librarian" (§5), and raw-text-first persistence + deterministic date resolution (§12). This section is the capture → structure → confirm flow that ties them together.

### 10.1 Capture flow: optimistic capture + passive review  **[SETTLED]**

The tension is the whole app in miniature: capture must be near-zero friction (§1), yet splitting, matching, and misclassification all invite a review step — which is friction. Resolved by delivering safety through **reversibility + unconditional raw text**, never through gating:

- **Raw text is saved instantly and unconditionally** (§12) — the backstop; nothing is ever lost, even if the user never reviews.
- **Structured items are created instantly and optimistically** from the parse and land in Captured Today (§9.1) right away — the common case is "typed it, it's filed," zero friction.
- **Every AI-inferred field is reversible** — type, parameters, themes, priority, and any recapture-merge. The review surface (§10.2) edits or rejects each proposal independently, but it is **non-blocking**: available, never gating.
- **The app nudges toward review only when the parse warrants it** — a multi-item split, a low-confidence parse, or a recapture-merge that fired. A clean, confident single-item capture gets no dialog at all.
- **The one destructive op — recapture-merge — is never silent-and-invisible.** On a match it boosts + appends (§9.3) but shows a light "bumped *Sarah's soy milk* — undo?", so a *false* merge is one tap back to a fresh item. Conservative matching + reversible + visible = safe (detection, §10.3).

*Why not confirm-then-commit* (parse → review → approve → create)? It is safer only in the narrow sense of approving every structure, but it taxes *every* capture — including the rapid brain-dump moments the app exists to catch — so it breaks the frictionless bet. Optimistic capture reaches the same safety through reversibility, without the tax.

**Parser emits a coarse confidence signal. [SETTLED]** The parse returns a coarse confidence/ambiguity flag alongside the structured proposal — nearly free from the same call — so a shaky parse can surface for a glance while confident ones stay silent. This is the signal that drives "nudge or not" above; exact thresholds are tuned from observation, not fixed now.

### 10.2 Segmentation & the transactional review surface  **[SETTLED]**

Two jobs: split one input into N items, and give the user a surface to fix them. Both sit on top of optimistic capture (§10.1) — the items are already created when this runs, so review is a **non-blocking pass over what exists**, never a gate.

**Segmentation — split on distinct intent.** The parser splits by *intent / referent*, not punctuation. A single action carrying several objects stays one item ("buy milk, eggs, bread" → one shopping item); genuinely separate intents split ("call the dentist, Sarah's allergic to nuts" → a DO plus a KNOW, which may even land as different backend types and flavours). **Lean toward splitting on genuine ambiguity** — under-segmentation is the lossier failure: two intents fused into one item let completing it mark the forgotten half "done" too. A mis-split is never lossy, because raw text is always persisted (§12) and each split item can be edited or rejected below. Segmentation is upstream of recapture-match (§10.3) — each resulting item is matched separately.

**Review surface — the interactive face of Captured Today (§9.1).** Not a separate screen. Newly-captured items already land in the Captured Today bucket; the §10.1 nudge (multi-item split, low-confidence parse, or merge-fired) simply points the user there for a glance. In it, each item is:

- **independently editable** — type, parameters, themes, priority, and the flavour override (§4); and
- **independently rejectable** — reject deletes that one item, the rest untouched (the *transactional* property, free because each item is already independent under optimistic capture).

Dismissing the nudge leaves everything exactly as created — review is always optional, and a clean, confident single-item capture surfaces no nudge and needs no visit here.

**Deferred: segmentation-boundary correction. [PARKED]** v1 offers per-item **edit + reject** only — no explicit *merge two items* / *split one* gesture. Reject-and-recapture covers a rare bad boundary and edit fixes wrong contents, so a dedicated boundary gesture is UI weight the split-when-ambiguous bias already minimizes. Add it if observation shows boundary errors are common.

### 10.3 Recapture-match detection  **[SETTLED]**

The *detection* half of recapture-as-boost — deciding that a new capture refers to the **same thing** as an existing item, so the item is boosted and the new phrasing appended (the action is settled, §9.3) rather than a duplicate created. Load-bearing because recapture is the one observable salience signal for life-triggered KNOWs (§9.2): repeated entry is how the app learns what is live right now. Detection runs **per segmented item** (§10.2) — one clean candidate at a time.

**Two-stage detection.**

- **Stage 1 — retrieve.** An **embedding retrieval** narrows the existing items to a small candidate set (the nearest few). This is the bounding step: recapture-match fires on *every* capture and the item pile grows without bound (especially KNOWs, §9.2), so handing the model everything would balloon over time. Retrieval is the same "sample, don't scan the whole pile" logic §9.2 uses for rotation.
- **Stage 2 — adjudicate.** The **LLM judges *sameness*** within just that candidate set. Embeddings cannot make this call alone — they score *similarity*, and "Sarah likes soy milk" vs "Sarah hates soy milk" are near-identical vectors with opposite meaning. Sameness means *same referent / intent*, phrasing-independent: the §9.3 escalation chain ("Sarah likes soy milk" → "remember the soy milk" → "Sarah got pissed, get the soy milk") must all resolve to one item.
- **Folded into the parse call.** The same Smart Capture call that structures the item takes the candidate set and flags a match, so detection is usually not a separate call.

**Conservative bias — prefer a missed match over a false merge.** The two failure modes are not symmetric. A **false merge** conflates two genuinely different items — it violates the cardinal rule against silently losing a capture. A **missed match** merely leaves a **duplicate**, which is visible in the browse view and is often caught by the *next* recapture. So the LLM merges only on high-confidence sameness; when unsure it creates a new item. Every merge is surfaced with the "bumped *X* — undo?" nudge (§10.1) — matching is never silent.

**Timing.** Detection runs **synchronously at capture**, so the boost and its undo nudge appear immediately rather than surfacing as a surprise change later.

**Undo (false-merge recovery).** Undo reverts the priority boost **and** splits the appended phrasing back out into its own fresh item — restoring exactly the state as if no match had fired. Per the immutable-history model this is a **compensating event**, not an erasure (§7.1), so the record still shows both the merge and its reversal.

### 10.4 Corrections → profile  **[SETTLED]**

How the user's edits and rejections in the review surface (§10.2) feed the Tier-2 profile (§7.3), and back into future parses. The satisfying part: **almost none of this is new machinery.** A correction is a state change, and §7.1 already logs those (edited, re-themed, priority-changed, rejected) as Tier-0 events with a before→after payload; the daily profile recompute (§7.3) already reads the raw 30-day window. So correction patterns surface as advisory profile nuance on their own — and **fade on their own** when the user stops correcting, since recompute-from-raw with no incremental folding means nothing calcifies.

Two things it does require:

- **The profile-writer records capture-relevant nuance.** The §7.3 generation step is directed to note filing / re-theming, priority-adjustment, and over/under-splitting tendencies — drawn from the correction events now in the log — alongside the surfacing nuance it already writes. This is the *write*-side "what's relevant" decision, made once; without it, a profile describing only surfacing habits would give Smart Capture nothing to act on.
- **Smart Capture reads the profile.** It reads the **whole** current daily profile (small by design, §7.5 — no slicing) and uses it to **bias** future parses toward the user's demonstrated preferences, skipping the surfacing-only lines. This extends the profile's consumers from Brain-only to **Brain + Smart Capture** (amending §7.3).

**Guardrails.** The bias is **advisory — an overridable default, never a hard rule or silent classifier** — preserving §7's line that nothing reliable depends on the soft summary. And there is a **known lag**: a correction reaches parsing only after the next overnight recompute, so the user may re-correct the same thing once or twice before it catches up. Both are acceptable precisely because the profile is advisory and corrections are cheap.

*Scale hedge:* if the profile ever grew large enough that shipping it whole on every parse got costly, it would be split into labelled facets (parsing vs surfacing) with each consumer reading its own — the same later-move posture as §7.5 / §9.2, not a v1 concern. Per-capture cost is negligible now; flagged for the budget (§12).

---

## 11. Delivery & Notifications  **[SETTLED]**

Memory is proactive in two different registers, delivered two different ways. The daily "what matters now" overview is **in-app**: you open the app — which we can reasonably expect daily — and the freshly-rebuilt bubble map (§6, §9) *is* your brief. **Push notifications are reserved for the punctual and crucial** — a specific thing at a specific moment you would otherwise miss. Over-notifying is fatal for an ADHD aid (mute it once and it is dead), so the push channel is deliberately narrow: it interrupts only when timing genuinely matters, never with a digest the user would learn to swipe away.

### 11.1 Two registers: in-app map vs punctual push  **[SETTLED]**

The two layers map onto two delivery modes:

- **Layer-2 — the in-app map (pull).** The curated "what matters now" overview *is* the bubble map (§6), rebuilt by the Brain on first open each day (§9.1). This is the daily brief — no separate surface, no push, no recompute-after-a-push to contradict itself. The user comes to it.
- **Layer-1 — punctual push (interrupt).** A push fires only for a genuinely time-critical item at its moment: a HAPPEN event just before it, or a hard-deadline DO when its runway demands. Deterministic — computed from dates + Tier-1 (§7.2), dates resolved deterministically (§12), no AI, no map dependency. This is the reliable floor: you cannot miss a 3 pm appointment because you did not happen to open the app.

*Why this split.* Reliability is what interrupts you; curation is what waits in the app. A daily *push* digest would either duplicate the in-app map — and risk contradicting it after the morning rebuild — or simply train the user to dismiss it. So the overview stays in-app and the push stays punctual. This also keeps the Brain's first-open run model (§9.1) exactly as-is: **no morning cron**, because nothing needs the map before the user opens.

*The punctual-push mechanism gives Reminders their teeth: a Reminder (§4, rule 3) is a ping-natured DO — a nudge to do a small thing at a moment — and Layer-1 push is how that ping reaches you.*

### 11.2 The scarcity budget  **[SETTLED]**

The push channel is rationed by *construction*, not by a numeric cap: only punctual Layer-1 items ever push, and they are few by definition — an event or a hard deadline, at its moment. There is no daily digest to throttle. The anti-fatigue mechanism is simply that **a push always means "this, now"** — rare and always time-critical — so the user never learns to ignore it. For an ADHD aid that reliability of meaning is the whole game.

### 11.3 v1 stays thin on proactivity  **[SETTLED]**

Punctual Layer-1 pushes plus the in-app map are v1's entire proactive surface. The richer moves — any push *beyond* punctual alerts (a warm-KNOW nudge, a "you haven't opened in a while" prompt), and learned per-user timing — are exactly the "first real proactive lever" §9.2 said to add **from observed data, not guessed now**. They wait for real usage and for the telemetry (§11.6) that would say *when* a nudge is welcome.

### 11.4 Layer-1 push rules & lead times  **[SETTLED]**

Deterministic throughout — computed from dates + Tier-1, no AI.

- **HAPPEN events — just before.** The default lead time is a modest **just-before** (≈30–60 min): the push does what the in-app map cannot — reach you at 2:45 for a 3 pm thing when you are not looking. **Overridable per event** — Smart Capture can parse an explicit time ("remind me the night before"). **One alert per event** in v1; escalation ladders (a day-before *and* an hour-before) are a later refinement.
- **Hard-deadline DOs — effort-scaled runway.** A push fires at **the deadline minus a runway that scales with effort / lead-time (§3.1)**: a quick task pings near its due date, a large project pings well ahead, since starting late is the failure mode. The §9.2 "big things need runway" logic, applied to *when the push fires*.
- **Recurrence — per-occurrence, native.** A recurring DO or HAPPEN (§3.1's shared RRULE-like model) pushes for **each occurrence** by the rules above. It falls straight out of the recurrence model.

### 11.5 The daily overview is in-app  **[SETTLED]**

The "daily brief" is not a notification — it is the bubble map the user sees on opening the app, already fully specified as the core surface (§6) and rebuilt each day by the Brain (§9.1). This subsection exists only to record that the overview lives there *by design*, not in a push — which is what dissolves the tension between a proactive morning digest and the Brain's first-open rebuild. Nothing further to build here.

### 11.6 Timing signal & telemetry  **[PARKED]**

For any *future* proactive push beyond punctual alerts (§11.3), the open question is *when* a user is receptive — which would draw on the behavioural telemetry parked in §7.1. Deferred with the rest of the richer-proactivity work; not a v1 concern.

---

## 12. Settled engineering principles

- **Deterministic date resolution. [SETTLED]** Relative dates ("next Tuesday") are resolved by a deterministic date parser, not by AI. AI may *extract the date phrase* during capture, but converting phrase → calendar date is deterministic — cheaper and far more reliable.
- **Raw-text-first capture. [SETTLED in principle; detail OPEN]** The raw capture text is always persisted, regardless of how it is classified or whether the user accepts the structured proposals. A memory aid must never lose a capture to misclassification or rejection. (The full capture flow is specified in §10.1.)
- **Cost budget & model routing. [SETTLED]** LLM calls dominate; embeddings (§10.3, search) are negligible. Route by task: **Smart Capture parsing → a cheap/fast tier** (routine extraction), the **Brain's clustering-and-prominence → the top tier** (the value-critical, genuinely-hard reasoning). Top-tier on the Brain is high-value *and* low-risk, because the reliable-vs-advisory split puts everything that must not fail in deterministic code (Tier-1, Layer-1 alerts §11, date resolution) — a model slip is a mediocre cluster, never a missed appointment — and the Brain runs only ~once per active user per day, so the premium is small in absolute terms. Two architectural controls bound it: the **first-open trigger** (§9.1, nothing spent on unopened days) and the **bounded working set** (§9.2, rotation samples the KNOW pile so rebuild input does not grow without limit). Rough target at current pricing: **~$5 per active user per month** (top-tier Brain + cheap-tier capture), lower with prompt caching on the largely-stable daily item set. A target for principled tradeoffs, not a hard runtime gate.
---

## 14. Open questions queue

In rough dependency order (the next items to work through together). *(Resolved and folded in: the activity/history log and user profile — §7; the bubble model & lifecycle — §8; the Brain in full — §9, i.e. run cadence, generation logic, and priority; flavour derivation & override — §4; the DO parameter model — §3.1; the Smart Capture parsing half in full — §10; Delivery & Notifications — §11; and the cost budget & model routing — §12.)*

1. **Smaller, mostly settled-by-default** — cold-start/onboarding; backup/durability; and terminology cleanup for the final spec.

---

*End of current spec. Every design decision is now settled — §1–§12 specify the full product end to end. What remains is purely mechanical and left as implementation detail: onboarding/cold-start, backup/durability, and terminology cleanup (§14). The Reader UI (§7.4) and GCal sync (§13) are deliberately deferred to post-v1.*
