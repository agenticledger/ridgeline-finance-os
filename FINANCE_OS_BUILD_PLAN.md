# Ridgeline Finance OS — Build Plan

> Companion to `FINANCE_OS_SPEC.md`. Turns the spec into ordered, checkable build steps.
> Use the **Ridgeline freight accrual** use case as the forcing function — §B pressure-
> tests the plan against it and lists the gaps it surfaced.
> Owner: Ore · Last updated: 2026-06-11

**Ground truth today:** estimation engine is DONE and validated (`services/accrual/*`,
pure functions) and there is a v2 Mission-Control UI mockup (`views/mission-control.ejs`).
The engine **stays**; the build wraps it in the Process/Run/Step persistence model and
rebuilds the surfaces around the triangle (Monitor / Execute / Improve) + Setup.

Resolved spec decisions baked into this plan: sign-off **advances** the run; re-run is
**full**; Tools are **reusable global entities mapped per-process**; everything is
**versioned** and runs **pin versions**; Improve approval is **chat**; data-input lever
**out of scope**.

---

## A. Build phases & checklist

### Phase 0 — Foundations (schema + seed)
- [ ] 0.1 Prisma schema: `Organization`, `LegalEntity`, `BusinessUnit`, `Function`.
- [ ] 0.2 Prisma schema: `Process` (FKs: org req, legalEntity req, businessUnit opt,
      function opt; `frequency`; `improveTrigger` json).
- [ ] 0.3 Prisma schema: `Step` (processId, order, assignedAgentId?, skillId?, version),
      `Policy` (processId, scope, stepId?, definition, params json, version).
- [ ] 0.4 Prisma schema — Tool registry (standalone, reusable): `Skill`, `Mcp`, `Agent`,
      `Human`, `Prompt`; join `ProcessTool` (processId, toolType, toolId).
- [ ] 0.5 Prisma schema: `Run` (processId, period, mode, state, frozen, parentRunId,
      pinnedVersions json), `StepExecution` (runId, stepId, agentId?, status, input json,
      processing json, policiesApplied json, outcome json, decisionType, override json,
      timestamps).
- [ ] 0.6 Prisma schema: `ObjectVersion` (objectType, objectId, version, diff json,
      source, approvedBy, approvedAt); `Reconciliation` (runId, actuals json, variance json) — G5.
- [ ] 0.7 Migrate. Seed one Organization + LegalEntity + the **Accruals** Process with its
      Steps/Policies/Tools (see §B step list). Policy params lifted from code per G1.
- [ ] 0.8 **Local Postgres** for dev (engine currently runs DB-free); Railway later (Phase 8).

### Phase 1 — Computation layer → persistence
- [ ] 1.1 Define the **Accrual Step list** as data (see §B.1) and seed as `Step` rows.
- [ ] 1.2 Refactor `runAccrual()` into a **stepped runner**: execute steps in order,
      writing a `StepExecution` per step (input/processing/policiesApplied/outcome).
      **Reorder gate before JE-post (G4):** Estimate → Gate → (pause if escalate) → post JE.
- [ ] 1.3 Map the existing `events` ledger entries onto `StepExecution` records.
- [ ] 1.4 Externalize tunable knobs into `Policy.params` and have the engine **read
      policies from the Run's pinned versions** (not hardcoded). (See §B gap G1.)
- [ ] 1.5 Tag each decision `policy_based` vs `judgment_based` (see gap G2 for granularity).
- [ ] 1.6 Persist a `Run` per execution; implement freeze (immutability guard) + `pinnedVersions`.

### Phase 2 — Org hierarchy + navigation
- [ ] 2.1 Org-hierarchy CRUD + seed nav (Organization ▸ Legal Entity ▸ [BU] ▸ [Function]).
- [ ] 2.2 Process picker (under hierarchy) + Run selector (period · mode · ✦frozen · history).
- [ ] 2.3 Route shell: selected Process+Run drives Monitor/Execute/Improve; Setup reached
      from the process.

### Phase 3 — Monitor surface (§6)
- [ ] 3.1 Status header from `Run.state` (complete / awaiting_human / in_progress / blocked) + KPI tiles.
- [ ] 3.2 Action Items = `awaiting_human` `StepExecution`s needing review/sign-off (from overseerQueue).
- [ ] 3.3 **Sign-off action** → writes record + **advances run** (`awaiting_human` → resume) (gap G3).
- [ ] 3.4 Outcomes: Summary / Detail (carrier drill-in + gate matrix) / Judgments (policy vs judgment, linked to Policy objects).

### Phase 4 — Execute surface (§7)
- [ ] 4.1 Step list rendered from `StepExecution` (status chips, Data→Processing→Outcome).
- [ ] 4.2 Per-step panel: input → processing → policies applied → outcome; link Skill + Agent.
- [ ] 4.3 Agent↔step map (one or many agents). For R1 a single "Accrual Agent" may own all steps.
- [ ] 4.4 Pause-for-human marker at the gate/sign-off step (gap G4 — pause sits before JE post).
- [ ] 4.5 Edit a step → spawn **new Run** → **full** re-run.

### Phase 5 — Setup surface (§5)
- [ ] 5.1 Assign process to org hierarchy (org+entity required).
- [ ] 5.2 Editable Step list (R1: read/edit seeded Accruals; NL→steps generator = later).
- [ ] 5.3 Policy editor (params + scope dept/step) with versioning.
- [ ] 5.4 Tool mapping from the global registry (Skill/MCP/Agent/Human/Prompt → ProcessTool).
- [ ] 5.5 Frequency + Improve-trigger config (auto: last X runs · ad-hoc; default instructions).

### Phase 6 — Improve surface (§8)
- [ ] 6.1 Surface existing `forwardLearn()` evidence (cycles, factorSeries, mae, coverage).
- [ ] 6.2 Improvement agent (LLM + MCP) ingests N runs' steps+outcomes+policies → recommendations across 3 levers (Steps/Policies/Output).
- [ ] 6.3 **Chat approval** ("approve 1–6, do #5 differently") → agent applies via MCP.
- [ ] 6.4 Apply writes a new `ObjectVersion` (before→after diff); affects **future runs only**.
- [ ] 6.5 Clarify Improve changes **methodology/params**, not derived values (gap G6).

### Phase 7 — API + MCP layer
- [ ] 7.1 REST API over every object (CRUD: org/process/step/policy/tool/run/stepExec/version).
- [ ] 7.2 Expose the same as **MCP tools** so the Improve agent can apply changes (the spec's
      "every page/action/object has an API" requirement).
- [ ] 7.3 Reconciliation/actuals ingestion endpoint to attach post-period actuals to a Run (gap G5).

### Phase 8 — Deploy (GATED on user go-ahead)
- [ ] 8.1 Rebrand siteData Orphil → Ridgeline.
- [ ] 8.2 GitHub `agenticledger/ridgeline-finance-os` + Railway Postgres/pgvector.
- [ ] 8.3 Seed admin + demo Accruals process. Remind user to rotate any pasted tokens.

### R1 cut line (competition, due 2026-06-14)
**Must:** Phase 0–4 for Accruals (persisted runs, Monitor + Execute over real DB, sign-off
advances, freeze) + Phase 5 read/edit seeded process + Phase 6.1 evidence surfaced.
**Stretch:** full Improve agent (6.2–6.4), MCP layer (7), NL→steps generator.

---

## B. Ridgeline pressure-test — does the model hold?

### B.1 The Accrual process, expressed as Steps + Policies (from the real engine)

| # | Step (skill) | Engine source | Policies it applies | decisionType |
|---|---|---|---|---|
| 1 | Ingest | `ingest.js` | dedup rule; weight-inference (median lbs/unit) | policy_based |
| 2 | Normalize | `normalize.js` | territory/lane resolvers; out-of-territory (OOT) detection | policy_based |
| 3 | Price | `rateEngine.js`+`rateConfig.js` | rate card (PEAK/HEARTLAND/COASTAL $/mi, per-lb, floors); fuel-included rule | policy_based |
| 4 | Calibrate factor | `calibrate.js` | factor methodology: **month-level**, **median central** (mean-reverting → no recency) | judgment_based |
| 5 | Baseline | `baseline.js` | trailing-3-month average (the Denise benchmark) | policy_based |
| 6 | Estimate | `estimate.js` | inverse-variance blend; **mix-shift z>1** lift; band z-score (1.645/90%) | judgment_based |
| 7 | Exceptions | `compute.js` | severity mapping (critical/warning/info) | policy_based |
| 8 | Stage JE | `accrualService.js` | account mapping 6100 Dr / 2150 Cr; balance rule | policy_based |
| 9 | Gate | `accrualService.js` | **materiality $1,500 × max CV 15%** → auto_post/review/escalate | policy_based |
| (Improve) | Reconcile & learn | `learn.js` `forwardLearn()` | proposes param changes for 4,6,9 | — |

This maps cleanly — the spec's Step/Policy/StepExecution model **does** describe the real
process. April result (booked $103,402, band $78K–$128K, all carriers escalate, 1 critical
exception SHP-10006 Reno OOT) becomes: 9 StepExecutions, gate produces 3 `awaiting_human`
items, run state = `awaiting_human`.

### B.2 Gaps the pressure-test surfaced

**G1 — Policies are currently CODE, not DB objects.** The rate card (`rateConfig.js`) is
already config-as-data (easy to lift into `Policy.params`). But thresholds (materiality,
maxCv) are function args, and methodology choices (median factor, inverse-variance,
mix-shift z=1, band z=1.645) are baked into the math. **Decision needed:** which knobs
become versioned `Policy` objects vs. stay engine code? Proposal: **params** (thresholds,
rate card, z-cutoffs) = Policy; **algorithms** = code. Improve tunes params, not algorithms.
→ affects 1.4.

**G2 — decisionType is finer than a step.** Step 6 (Estimate) contains BOTH a judgment call
(ensemble blend) AND will feed a policy call (gate). One StepExecution can hold mixed
decision types. **Decision needed:** keep `decisionType` on StepExecution (coarse, R1-ok) or
add a `Decision` sub-record per step for Monitor's policy-vs-judgment split to be exact.
Proposal: R1 coarse (tag the dominant type), add `Decision[]` later. → affects 1.5, 6.4.

**G3 — Sign-off has nothing to resume (today the run is synchronous & complete).** Sign-off
= "go on," but `runAccrual()` already computed everything including the JE. For sign-off to
*advance* anything, the runner must **pause before an irreversible step**. → see G4.

**G4 — Pause point is mis-ordered.** Today JE is staged (step 8) *before* gating (step 9).
"Pause for human" must sit **after gate, before JE post**: Estimate → Gate → (pause if
escalate) → sign-off → post JE. **Action:** reorder so the gate gates *posting*, not just
labels. This is the concrete meaning of "deterministic by default, agentic by exception."
→ affects 1.2, 4.4.

**G5 — Reconciliation needs post-period actuals that don't exist at run time.** Improve's
reconcile (booked vs actual) needs invoiced actuals that arrive *after* the accrual period
(and after freeze). `forwardLearn()` fakes this by replaying history. In production we need
an **actuals/reconciliation ingestion** that attaches actuals to a (frozen) Run without
mutating it. → new Phase 7.3; not in the current model — **add a `Reconciliation` object**
(runId, actuals, variance) so frozen runs stay immutable while gaining a reconciliation.

**G6 — "Improve a Policy" vs "derived value."** The realization factor is **recomputed every
run from data** — Improve can't "set the factor." What it changes is the **methodology
policy** (e.g. "lower mix-shift z-threshold 1.0→0.8", "use 4-month vs 3-month baseline").
Ridgeline makes this concrete and confirms: Improve targets **Policy params**, the next run
**recomputes** derived values under the new params. Bake this framing into 6.2/6.5.

**G7 — Agents are notional in R1.** There's no per-step agent today; it's one function. R1:
seed a single "Accrual Agent" owning all 9 steps; the `assignedAgentId`/`Assignment` model
holds, multi-agent is exercised later (e.g. a separate "Reconciliation Agent" for Improve).

**G8 — StepExecution payload granularity.** 1,240 shipments × 9 steps is a lot if stored
per-shipment. **Decision:** StepExecution stores **step-level summary + per-carrier rollup**
(matches how Monitor/Execute display), with raw shipment data referenced, not embedded.

### B.3 Verdict
The Process/Run/Step/Policy/Versioning model **holds up** against the real freight accrual —
every engine stage maps to a Step, every tunable maps (or should map) to a Policy, and the
April run expresses naturally as a paused, awaiting-sign-off Run. The model needs **two
additions** (Reconciliation object G5; optional Decision sub-record G2) and **one behavioral
fix** (reorder gate-before-JE-post G4). None of these break the architecture; they make it
real. Recommend resolving G1 (which knobs are Policies) and G4 (pause ordering) first — they
gate Phases 1 and 4.

---

## C. Unblock decisions — RESOLVED (2026-06-11)
1. **G1 ✓** Policy/algorithm line confirmed: **params = Policy** (rate card, materiality,
   maxCv, z-cutoffs, baseline window), **algorithms = code**. Improve tunes params only.
2. **G4 ✓** **Reorder gate-before-JE-post**: Estimate → Gate → (pause if escalate) →
   sign-off → post JE. The gate gates *posting*, not just labeling.
3. **G5 ✓** Add a **`Reconciliation`** object (runId, actuals, variance) for post-period
   actuals; attaches to a frozen Run without mutating it.
4. **DB ✓** **Local Postgres** for dev now; Railway later (Phase 8).

All four resolved — Phase 0 is unblocked.
