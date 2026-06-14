# Generic Runner + Generic Flow Visual — Build Plan

**Goal:** Make the run machinery and the Flow visualization work for ANY process a
user creates, not just freight-accrual. Today both are hardwired (see "Why" below).
**Hard constraint:** freight-accrual must keep working EXACTLY as-is throughout —
`node scripts/validate.js` must stay 27/27 green and the canonical April number must
not move. We add a generic path; we do not rewrite the validated freight path.

## Why this is needed (confirmed in code)
- `runService.executeRun()` is freight-only: `PROCESS_SLUG='freight-accrual'` constant,
  `loadProcessContext()` only loads that process, it calls `runAccrual()` and
  `buildStepExecutions()` hardcodes exactly 10 freight steps with freight-shaped outcome
  fields (`services/accrual/runService.js:16,22,43-136`). A new process has step metadata
  but nothing executes it.
- `views/fos/flow.ejs` hardcodes `LAYOUT`, `ORDER`, `statFor()` and `EDGES` to the 10
  freight step keys (`flow.ejs:14-25,31-47,120-134`). The render loop skips any key not in
  the hardcoded list → a new process renders ZERO nodes.
- `Step` has only `order` (linear int) — **no dependency/edge field** in
  `prisma/schema.prisma`. The DAG topology exists only as the hardcoded `EDGES` array.

## Design (lowest-risk, additive)
1. Add DAG fields to `Step` so topology is DATA, not hardcoded.
2. Add a thin generic `processRunner` that, for freight, DELEGATES to the untouched
   `runService.executeRun` (zero change to validated code); for any other process it runs a
   generic scaffold that produces a real, persisted, visualizable Run.
3. Make `flow.ejs` derive nodes/edges/layout from `proc.steps` + the new DAG fields, and
   read a per-step `outcome.headline` string (freight sets the nice stats; scaffold sets a
   generic one).
4. Make `history.ejs` degrade gracefully for non-freight runs (no vsDenise/dispositions).

---

## Phase 0 — Schema: DAG on Step
- [ ] Add to `model Step` in `prisma/schema.prisma`:
      `dependsOn String[] @default([]) @map("depends_on")` (forward data deps, acyclic) and
      `feedbackTo String? @map("feedback_to") @db.VarChar(60)` (optional improve-loop target key).
- [ ] Create + apply migration: `npx prisma migrate dev --name step_dag` (local `ridgeline` DB).
- [ ] Regenerate client (migrate dev does this) and confirm `npx prisma generate` clean.
- [ ] Update `prisma/seed.js` freight steps to encode the real DAG via `dependsOn`:
      normalize/calibrate/baseline ← [ingest]; price ← [normalize]; exceptions ← [price];
      estimate ← [price, calibrate, baseline]; gate ← [estimate, exceptions]; post_je ← [gate];
      reconcile_learn ← [post_je]. Set `reconcile_learn.feedbackTo = 'calibrate'`.
- [ ] `configService.addStep`/`updateStep` accept `dependsOn` (array of existing step keys in
      same process; validate each key exists) + `feedbackTo` (nullable, validate key exists).
      Reject self-dependency and any edge that would create a cycle (topo-sort check).
- [ ] Re-seed: `node prisma/seed.js` then `node scripts/seed-demo.js`; confirm no errors.
- [ ] **GATE:** `node scripts/validate.js` → still 27/27 green. April still $103,402.27.

## Phase 1 — Generic process runner (freight untouched)
- [ ] Create `services/runner/processRunner.js` exporting `runProcess({ processSlug, period, mode, actor })`.
- [ ] Engine registry: `ENGINES = { 'freight-accrual': (args) => require('../accrual/runService').executeRun(args) }`.
      If `ENGINES[slug]` exists → delegate (freight path 100% unchanged).
- [ ] Else → `runScaffold(process, period, mode, actor)`:
      - [ ] Load process + steps (ordered) + policies.
      - [ ] Topologically sort steps by `dependsOn` (fall back to `order` when no deps).
            Detect cycles → throw a clear error (should never happen post-validation).
      - [ ] For each step write a `StepExecution`: `status='done'`, `decisionType` from step,
            `input={fromSteps: dependsOn}`, `processing={engineSource: step.engineSource||'scaffold'}`,
            `policiesApplied=[]`, `outcome={ scaffold:true, headline: step.engineSource ? 'ran '+step.engineSource : 'step complete' }`.
            `startedAt`/`finishedAt` staggered like the freight path.
      - [ ] Gate logic: if any `isGate` step exists, run status = `posted` for scaffold (no
            escalate signal); leave the hook so a real engine can set escalate→`awaiting_human`.
      - [ ] Create `AccrualRun` with `summary={ scaffold:true, stepCount }` (NO vsDenise/dispositions).
      - [ ] Write a minimal `LedgerEvent` RUN_STARTED + GATE so the run is auditable.
      - [ ] Return `{ runId, status, autoPosted }`.
- [ ] Repoint the run trigger to the generic runner:
      - [ ] Find every caller of `runService.executeRun` (grep): route handlers in
            `routes/financeOs.js` / `routes/fosApi.js`, MCP `mcp/server.js`, scripts.
      - [ ] UI/route run actions call `runProcess({ processSlug: <current slug> })`.
            Scripts + freight-specific MCP tools may keep calling `executeRun` directly (freight).
- [ ] **GATE:** freight run via the new `runProcess({processSlug:'freight-accrual'})` produces
      the identical run as before (same point, same awaiting_human, same 10 StepExecutions).

## Phase 2 — Generic Flow visual (data-driven)
- [ ] `flow.ejs`: DELETE hardcoded `LAYOUT`, `ORDER`, `statFor()` switch, and the inline `EDGES`.
- [ ] Build `NODES` from `proc.steps` (key, name, order, decisionType, isGate, engineSource) joined
      to the run's `StepExecution` by key (status, outcome).
- [ ] Build `EDGES` from each step's `dependsOn` (`{f:dep, t:key}`) plus `feedbackTo`
      (`{f:key, t:feedbackTo, kind:'feedback', label:'proposes changes'}`).
- [ ] Stat line per node = `outcome.headline || ''` (generic; freight headlines come from engine).
- [ ] Add `outcome.headline` to the FREIGHT engine output so freight stats are preserved:
      in `runService.buildStepExecutions`, set each step's `outcome.headline` to today's strings
      (160 shipments, ×factors, contractual, gate dispositions, staged $X, band coverage %).
      (This MOVES the strings from the view into the engine — verify freight visual unchanged.)
- [ ] Auto-layout in client JS (replaces hardcoded col/row):
      - [ ] `col(node)` = longest-path depth: 0 if no `dependsOn`, else `max(col(dep))+1`
            (ignore feedback edges so the graph stays acyclic for layering).
      - [ ] Group nodes by col; within each col order by step.order; vertically CENTER each
            column's stack around a shared spine so it reads symmetric (like freight does now).
      - [ ] Apply `grid-column`/`grid-row` from computed col/row; set `--flow-cols` so the grid
            template column count matches the deepest col + 1.
- [ ] Keep `buildPaths()`/`fireWave`/`settleWave`/`play()` AS-IS — they already work off
      `EDGES`/`data-col` generically; they just consume the now-derived arrays.
- [ ] Empty/edge cases: process with 0 steps → friendly "No steps defined yet" empty state;
      linear process (no `dependsOn`) → falls back to a straight `order` chain.
- [ ] Bump `fos.css?v=` (→ v20) anywhere CSS touched, across ALL views per CLAUDE.md mandate
      (only if CSS changes; if layout is pure inline-grid no bump needed — verify).

## Phase 3 — History tab graceful degradation
- [ ] `views/fos/history.ejs`: render "vs Denise" cell only when `r.vsDenise != null`, else `—`.
- [ ] Render the gate dots only when `r.dispositions` has real totals; else neutral `—`.
- [ ] Confirm `listRunHistory(slug)` already parameterized (it is) and returns scaffold runs
      with null financial fields without throwing.

## Phase 4 — End-to-end verification (evidence required, no claims without it)
- [ ] `node scripts/validate.js` → **27/27 green** (freight math + persistence intact).
- [ ] Freight Flow: open `/process/freight-accrual/flow` → still 10 nodes / 13 edges, headlines
      present, Revisualize plays the same dependency waves (screenshot via op_devbrowser).
- [ ] Freight History: `/process/freight-accrual/history` → unchanged, vs-Denise + gate dots show.
- [ ] NEW process: create via configService/automator with ~5 steps incl. `dependsOn` + one
      `isGate` + one `feedbackTo`. Run it via `runProcess`. Then:
      - [ ] `/process/<new-slug>/flow` renders ITS DAG (correct nodes, edges, layout), Revisualize plays.
      - [ ] `/process/<new-slug>/history` lists the run with financial cells degraded to `—`.
- [ ] Grep for any remaining hardcoded freight step keys in `views/fos/flow.ejs` → none.

## Phase 5 — Docs + memory sync (CLAUDE.md mandate)
- [ ] If any `/api/fos` run-trigger endpoint changed shape → update `docs/catalog.js`.
- [ ] If any MCP run tool changed → update `mcp/toolCatalog.js`; keep server==catalog count.
- [ ] Run `/opappbuild_agentready_trueup` audit if REST/MCP touched.
- [ ] Update memory `ridgeline-finance-os.md`: Step now has `dependsOn`/`feedbackTo`; runner is
      generic via `processRunner.runProcess` (freight delegates, others scaffold); flow.ejs is
      data-driven (layout from longest-path, edges from dependsOn/feedbackTo, stat from
      outcome.headline); freight stats moved into the engine.

## Out of scope (call out, do not build now)
- Real per-step COMPUTE for arbitrary processes (a new process runs as a scaffold until an
  engine/handlers or agent+tools are registered for it). This plan delivers generic
  run + persist + visualize, not bespoke math for every process.
- Editing `dependsOn`/`feedbackTo` from the Setup UI form (service-layer support is in Phase 0;
  a Setup UI control can be a fast follow if wanted).
