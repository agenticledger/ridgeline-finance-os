# Live Map → Architecture Visualization (Command Center)

**Date:** 2026-06-13
**Status:** Approved design, ready for plan

## Problem

The current Live Map (`/processes/live`) renders only four layers:
`Org → Sub-function → Process → Agent`. It stops at the agent — which hangs
off the side as a dead-end node — and never shows what a process actually *is*.

The real architecture (per `prisma/schema.prisma`) goes deeper:

```
Organization
  └─ BusinessUnit / OrgFunction
       └─ Process ── owned by ── Owner Agent
            ├─ Steps (ordered; some are gates; pauseAfter checkpoints)
            │     ├─ Policies (step-scoped, versioned, params)
            │     └─ Tools / engine source (deterministic code)
            └─ Process-level Policies & Tools
```

So today's map shows the *org chart* of processes, not the *anatomy* of a
process. The most demo-able, "this is how the machine works" layer
(Steps → Policies/Tools, typed by decision type) is entirely missing. The page
reads as a generic node graph, not a futuristic command center.

## Goal

Turn the Live Map into a true architecture visualization with two coordinated
views, connected by a fly-in zoom, navigable via a BU/Process fast-travel
dropdown — keeping the existing dark-theme, dotted-grid, particle-flow command
center aesthetic.

## Design

### Two views, one engine

Both views render from the same hand-rolled SVG engine
(`public/js/processes-live.js`, no external libs). The engine gains a
`mode: 'overview' | 'schematic'` switch driven by the payload shape.

### View 1 — Overview constellation (rework, not rebuild)

Three-layer architecture read: `Org → BU/Function → Process`.

- **Drop the agent column.** The agent runs the process; it is not a sibling of
  it. The agent moves *into* the schematic where it belongs. This removes the
  dead-end node that makes today's map confusing.
- Process nodes keep live signal color (live / needs-you / posted / idle) and
  particle flow, and show `N steps · last period`.
- **Fast-travel dropdown** (top-left HUD): `BU ▸` filters/dims the constellation
  to that BU; `Process ▸` flies straight into a schematic.
- Clicking a process node triggers a zoom-in transition into its schematic.

### View 2 — Process schematic (centerpiece)

The "command center" view — the inside of one process.

```
            ┌─────────────────┐
            │  OWNER AGENT     │  ← supervising "core" (violet glow, pulses)
            └────────┬────────┘
   policies          │ live flow         tools / engine
   ◄──────  ① Ingest shipments  ──────►  [coastal_rate_engine]
   ◄──────  ② Apply rate cards   ──────►  [peak/heartland engines]
   ◄──────  ◆ Variance gate      ──────►  (human checkpoint)
   ◄──────  ③ Post accrual       ──────►  [ledger_writer]
```

- **Owner Agent** node at top — the supervising core, distinct styling.
- **Center spine** = ordered steps (`step.order`), top→bottom, joined by the
  live flow line.
- Each step **branches**: step-scoped **Policies** to the left, **Tools / engine
  source** (`step.tool`, `stepTools`, `engineSource`) to the right.
- Steps are **typed by `decisionType`** (deterministic-engine / policy-based /
  agent-judgment) with distinct glyphs + color — this is what makes the map
  finally *say* "here's the architecture."
- **Gates** (`isGate`) render as amber diamonds; `pauseAfter` steps show a
  human-checkpoint marker.
- **Process-level** policies & tools (scope = process, no stepId) live in a side
  rail — they apply to the whole process, not one step.
- **Live status**: the latest run's `StepExecution` records light the spine —
  done steps glow posted, the current step pulses live, a gate awaiting a human
  pulses needs-you. Particles travel down the spine.
- Click a step → **detail drawer**: policy definitions + params JSON, tool
  config, `decisionType`, `engineSource`, last execution.
- **HUD bar**: breadcrumb `Org / BU / Process`, frequency, mode, current run
  status + period, and a back-to-overview control.

## Components & data flow

### Routes (`routes/financeOs.js`)

- `GET /processes/live` — overview graph, **minus agents**. Nodes: org, BU/fn,
  process. Edges: org→fn→process. Signal from latest run status (existing logic).
- `GET /processes/live/:slug` — **new**. Schematic graph for one process:
  - Nodes: owner agent, each step, each step's step-scoped policies, each step's
    tools (`step.tool` + `stepTools`); process-level policies & tools for the
    side rail.
  - Edges: agent→spine, spine ordering (step→step by `order`), step→policy and
    step→tool branches.
  - Live status from the latest `AccrualRun`'s `StepExecution`s, mapped onto step
    nodes.
  - Returns `mode: 'schematic'` plus HUD metadata (process name, BU, frequency,
    mode, run status, period).

### Template (`views/processes-live.ejs`)

One template serves both modes. It already injects `window.LM_GRAPH`; extend the
payload to carry `mode`, HUD metadata, and (schematic) the step drawer data. The
client picks the layout based on `mode`.

### Engine (`public/js/processes-live.js`)

Extend the existing layered-layout + `animateMotion` particle code:

- `mode === 'overview'`: current column layout (org / fn / process), agent column
  removed.
- `mode === 'schematic'`: vertical spine layout — agent at top, steps as a
  centered column, policies fanned left, tools fanned right, process-rail nodes
  parked in a side column. Gate/checkpoint glyphs, decision-type styling, step
  click → drawer.
- Reuse existing glow filters, dotted-grid backdrop, theme tokens, zoom/pan, and
  legend.

### Dropdown (client control)

A BU/Process selector layered on top of the map. Selecting a BU filters/dims the
overview constellation; selecting a process navigates to
`/processes/live/:slug` (fast travel into the schematic).

## Schema reference (already exists, no migration)

- `Process` → `businessUnit`, `function`, `ownerAgent`, `steps[]`, `policies[]`,
  `tools` (ProcessTool[]), `runs`.
- `Step` → `order`, `key`, `name`, `decisionType`, `engineSource`, `toolId`/`tool`,
  `isGate`, `pauseAfter`, `stepTools[]`, `policies[]`, `executions[]`.
- `Policy` → `scope` (process|step), `stepId?`, `key`, `name`, `definition`,
  `params`.
- `Tool` → `type`, `name`, `slug`, `config`.
- `StepExecution` → drives live per-step status on the spine.

No schema changes required — this is purely a read/visualization layer over the
existing model.

## Signal mapping (existing convention, reused)

- attention / needs-you: run status in `awaiting_human`, `needs_review`, `blocked`
- live: run status `processing`
- posted: run status in `approved`, `posted`, `reconciled`
- idle: otherwise

## Out of scope

- No editing of processes/steps/policies from the map (read-only visualization).
- No new persisted entities or schema migration.
- No external graph/charting libraries.

## Success criteria

- Overview reads cleanly as `Org → BU → Process` with no dead-end agent nodes.
- Clicking a process (or choosing it in the dropdown) flies into a schematic that
  shows the agent, the ordered steps (with gates/checkpoints), and each step's
  policies and tools, typed by decision type.
- Latest-run status lights the schematic spine live.
- The whole experience keeps the dark command-center aesthetic and runs on the
  existing no-deps SVG engine.
