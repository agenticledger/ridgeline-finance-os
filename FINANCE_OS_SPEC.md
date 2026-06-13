# Ridgeline Finance OS — Master Spec

> Status: SPEC — design locked enough to build from. We are building this for real;
> the current app is treated as a **mockup** to be replaced where needed.
> Owner: Ore · Last updated: 2026-06-11
> Supersedes: `INITIATE_SPEC.md` (folded into §6 here).

---

## 1. Thesis — Finance is a library of Processes

Finance runs on **processes** (Accruals, Revenue, Close, Reconciliations, …). They
all share the same shape. Build the shape once, then **multiply it** across every
finance process. Accruals is our first instance.

**Every Process has:**
- **Steps** — an explicit, ordered list of what must happen.
- **Policies** — the rules that govern decisions (dept-wide or bound to a step).
- **Tools** — what executes the work, in five kinds:
  - **Skills** — a named combination of steps (the "how-to"; what an agent follows).
  - **MCPs** — external apps/systems we connect to (data sources, ERPs, APIs).
  - **Agents** — the bots that execute the skills/steps.
  - **Humans** — people in the loop (review, sign-off, judgment).
  - **Prompts** — reusable instruction units the agents use.
- **Frequency** — cadence (our case: monthly; could be weekly).

**Processes are:**
- Executed by **combinations of humans and agents**.
- **Run multiple times** for the same period (test → live).
- Subject to **freezing** — one run is chosen as the official financial record.

**Process is king. Setup is NOT above it — Setup is a side item *of* every process**
(each process must be set up: its steps, policies, tools, frequency). What sits *above*
a process is the **organizational hierarchy** a process is assigned into:

```
Organization (required)
  └─ Legal Entity (required)
       └─ Business Unit (optional)
            └─ Function (optional)
                 └─ PROCESS  ← king; has Setup as a side item
                      └─ Run (per period)
```

Every process **must be assigned** to an **Organization (required)** → **Legal Entity
(required)** → **Business Unit (optional)** → **Function (optional)**. This is how the
same process template scales across a real org structure.

The three live surfaces form a **triangle** over a selected run:

```
            MONITOR        ← top  (human oversight; §6)
           /        \
      EXECUTE      IMPROVE  ← legs (§7 agent run · §8 learning)
```

Everything but Setup is a *view into a Run of a Process.* The same scaffolding serves
Accruals, Revenue, and beyond.

---

## 2. Domain model (persistence)

Stack: Express + TypeScript + Prisma + PostgreSQL (existing `prisma/`). The objects
below become first-class DB models. The current synchronous `runAccrual()` and its
in-memory `control/pipeline/learning` structures become a **computation layer that
writes into these records**, not the source of truth.

```
Organization ─< LegalEntity ─< BusinessUnit ─< Function ─< Process
   (req)           (req)         (optional)    (optional)

Process ─┬─ organizationId    (REQUIRED)
         ├─ legalEntityId     (REQUIRED)
         ├─ businessUnitId    (optional)
         ├─ functionId        (optional)
         ├─< Step          (ordered checklist items; the skill, as data)
         ├─< Policy         (dept-level OR step-scoped)
         ├─< ProcessTool    (link to Skill | MCP | Agent | Human | Prompt)
         ├─< Assignment      (Step → Agent + Skill: who executes what)
         ├─  setup           (side item: steps/policies/tools/frequency — §5)
         ├─  frequency       (monthly | weekly | …)
         └─< Run            (one execution for one period)

Step ─┬─ order
      ├─ assignedAgentId    (which Agent executes it — one process can use many)
      ├─ skillId            (which Skill/step-bundle it runs)
      └─ version            (every object is versioned — see Versioning)

Run ─┬─  period              (e.g. "April 2026")
     ├─  mode                (test | live)
     ├─  state               (queued | in_progress | awaiting_human | complete | blocked)
     ├─  frozen              (bool — immutable financial record once true)
     ├─  parentRunId         (set when created by editing a prior run's step → new run)
     ├─  pinnedVersions      (snapshot: Policy v9, Skill v2, Step v4 … per object)
     └─< StepExecution       (one per Step per Run — the documented work)

StepExecution ─┬─ stepId
               ├─ agentId         (the Agent that ran it)
               ├─ status          (pending | running | awaiting_human | done | skipped | error)
               ├─ input            (what went in)
               ├─ processing       (what it did)
               ├─ policiesApplied  (which Policy objects+versions, and how)
               ├─ outcome          (what came out)
               ├─ decisionType     (policy_based | judgment_based)
               ├─ override         (human edit applied at this step, if any)
               └─ timestamps

Policy ─┬─ scope               (department | step)
        ├─ stepId?             (when step-scoped)
        ├─ definition          (human-readable rule)
        ├─ params              (e.g. materialityThreshold, maxCv)
        └─ version             (versioned object)

ObjectVersion (cross-cutting) ─┬─ objectType   (Step | Policy | Skill | Prompt | …)
                               ├─ objectId
                               ├─ version
                               ├─ diff          (before → after)
                               ├─ source        (improvement_run | manual | setup)
                               └─ approvedBy / approvedAt
```

**Key model decisions (confirmed):**
- **Edit-then-rerun creates a NEW Run** (with `parentRunId`), never mutates in place.
  Frozen runs are always immutable.
- **Steps live in the DB**, generated from a natural-language process description in
  Setup, and **marked off each run** via their `StepExecution` records. The agent uses
  this checklist to **self-verify it did everything.**
- **Policies are DB objects**, referenced by `StepExecution.policiesApplied`. This is
  what powers Monitor's policy-vs-judgment split (§6.4) with real linkage.
- **Everything is versioned.** Step, Policy, Skill, Prompt (etc.) each carry a `version`
  and a full `ObjectVersion` history (diff + who approved). A **Run pins the exact
  versions it used** (`pinnedVersions`) — so a run can legitimately use **Policy v9 with
  Skill v2**. This is how frozen runs stay reproducible and auditable while the
  definitions keep evolving. (Resolves §11 Q3.)
- **Agents are assignable per step.** A Process can be executed by **one or many agents**;
  each Step maps to an Agent + Skill via `Assignment`. Execution renders this mapping
  (§7), and `StepExecution.agentId` records who actually ran each step.
- **Tools are reusable entities.** Skill/MCP/Agent/Human/Prompt live in a **global
  registry** as standalone objects and are **mapped per-process** via `ProcessTool`. The
  same Skill or Agent can be reused across many processes (Accruals, Revenue, …).
- The existing **event ledger** (`buildEventLedger`, tagged by plane) is the precursor
  to `StepExecution` — it already records "every material thing the OS did this cycle."
  Formalize it into per-step records.

---

## 3. Information architecture / navigation

You navigate **down the org hierarchy** to a Process, then pick a Run:

```
┌─ ORG HIERARCHY (above Process) ─────────────────────────────────┐
│  Organization ▸ Legal Entity ▸ [Business Unit] ▸ [Function]      │
└─────────────────────────────────────────────────────────────────┘
        │
┌─ PROCESS (king) ────────────────────────────────────────────────┐
│  Pick PROCESS → [ Accruals ]   ( Revenue, Close, … later )      │
│  Pick RUN     → [ April 2026 · live · ✦frozen ]                 │
│                 ( test runs, prior periods, history )            │
│  · SETUP (side item of THIS process) ──────────── §5            │
└─────────────────────────────────────────────────────────────────┘
        │
        │   the triangle over the selected Run:
        │
        │            MONITOR  (human oversight)        §6
        │           /        \
        │      EXECUTE        IMPROVE                  §7 · §8
        │   (agent run)      (learning)
```

- **MONITOR** (top) — was "Initiate." Human oversight of the selected run.
- **EXECUTE** (left leg) — live step-by-step of the run, agent-facing.
- **IMPROVE** (right leg) — cross-run learning loop.
- **SETUP** is a **side item of the process** (not a separate top-level above it). Reach
  it from the process. Process is king.
- **Prior runs / prior periods** belong to the **Run selector**, NOT inside Execution.
  Monitor/Execute/Improve always reflect the *currently selected Run.*
- Run badges: `test` / `live` / `✦ frozen`.

---

## 4. Run lifecycle

```
queued ─► in_progress ─►(may pause)─► awaiting_human ─►(signed off)─► complete
                                  └─► blocked (hard error / missing data)

complete (live) ──► chosen ──► FROZEN  (immutable, the financial record)

any run ──► edit a StepExecution ──► spawn NEW Run (parentRunId) ──► re-run
```

- **Test vs live** is a mode on the Run. I can run many times, tweak the checklist or a
  step outcome, re-run.
- **Awaiting-human** is a real state: a run can stop at a step that needs a person. That
  pause is exactly what surfaces in Monitor as an Action Item (§6.1).
- **Sign-off = "go on."** Signing off in Monitor writes a record and **resumes the run**
  from `awaiting_human` (the human re-initiates execution).
- **Re-run runs the full thing** — editing any step spawns a NEW Run that executes end to
  end (no partial/downstream-only replay).
- **Freeze** locks one run as gospel for financial reporting.

---

## 5. Surface — Setup (side item of a Process)

**Job:** Define a Process once so it can be run forever. **Setup is a side item OF the
process** (reached from the process, not a top-level area above it — process is king).
Every process must be set up. This is the control plane for *what the agent is and what
it's allowed/instructed to do,* and where the process is **assigned into the org
hierarchy** (Organization required → Legal Entity required → Business Unit optional →
Function optional). It exists because there will be **multiple agents and multiple
skills** across **multiple processes.**

**Setup flow (agentic authoring):**
1. **Assign to org hierarchy** — Organization (required) → Legal Entity (required) →
   Business Unit (optional) → Function (optional).
2. **Describe the process** in natural language ("Here's how we do freight accruals…").
3. System **turns the description into an explicit ordered Step list**, stored in the DB.
4. Attach **Policies** (dept-wide and/or step-scoped) with their params.
5. Wire up **Tools**: which Skills (step bundles), MCPs (external apps/data), Agents
   (executors), Humans (where sign-off is required), Prompts. Assign Steps → Agent+Skill.
6. Set **Frequency** (monthly/weekly) and **Improve** trigger (auto/ad-hoc, §8.2).
7. On the next run the agent **re-applies** the current config; changing config and
   re-running yields a new Run with different results.

**Why it matters:** the Step list is the agent's self-check ("did I do everything?"),
and it's the spine Execution renders. Editing here is how a human "redesigns the skill"
and the agent adopts it. Same authoring framework serves every future process.

**R1 note:** Setup can ship with a **read/edit view over a seeded Accruals process**
(steps/policies/tools already defined) before the full natural-language → steps
generator is built. The generator is the vision; the DB-backed editable checklist is
the R1 must-have.

---

## 6. Surface — Monitor (human oversight) · top of the triangle

> Formerly "Initiate." This is the **MONITOR** apex above Execute (left leg) and Improve
> (right leg).

**For:** the human-in-the-loop. They arrive *after* the run (or while it's paused) to
review what the machine did, clear what it flagged, and sign off. Three sections:
**Status → Action Items → Outcomes.**

### 6.0 Current Status
One sentence + KPI tiles. State derived from the Run:
- `complete` — "April 2026 — complete. Nothing needs you."
- `awaiting_human` — "April 2026 — ran, waiting on you · N need sign-off."
- `in_progress` — "April 2026 — mid-run · 1,180/1,240 priced."
- `blocked` — "April 2026 — blocked · missing rate card for Carrier X."

Tiles (existing fields): Booked `portfolio.point` · 90% band `portfolio.low–high` ·
vs Denise `portfolio.vsDenise` · Coverage `learning.coverage.pct` · Needs-a-human
`control.overseerQueue.length`. Policy line: materiality `materialityThreshold` ·
max CV `maxCv`.

### 6.1 Action Items For Me
The to-do list — the reason to open the page. Empty by design when nothing's needed.

| Verb | Source | Meaning |
|---|---|---|
| **Review X** | `carriers` where `decision === 'review'` | Borderline; eyeball |
| **Sign off Z** | `carriers` where `decision === 'escalate'` + critical `exceptions` | Approve before it posts |

Backed today by `control.overseerQueue` (each item: `kind`, `severity`, `label`,
`detail`, `dollar`). Sort critical→warning, then `dollar` desc.

> **Scope decision:** Monitor is **within-run review/sign-off only.** Structural
> "improve the process" changes (policy/step/output proposals) live in **Improve** (§8),
> NOT here — they are distinct queues. (Leaning further: Monitor may not surface
> proposals at all.)

### 6.2 Outcomes — Summary
Booked + band, vs Denise, disposition counts (`dispositions.auto_post/review/escalate`),
posture split `[D]` `posture.deterministic` vs `[A]` `posture.realizationAdjustment`,
`exceptions.length`.

### 6.3 Outcomes — Detail (drill-in)
Per-carrier rows (`d.carriers`): point, band, contractual, factor, vsDenise, decision,
engineWeight, mixShift. Gate matrix (`control.gateMatrix`) demoted to here as the
visual of where each carrier landed on materiality × confidence. (This is today's
Execution "work product," reachable as a drill-in.)

### 6.4 Outcomes — Judgments & Decisions
The trust/audit core. Every consequential decision, split by **why**, each row linking
the **Policy DB objects** it used:

- **Explicit Policy-Based** — "did what the policy said." `decisionType = policy_based`.
  - Gate auto-post (under materiality AND inside CV limit: `material=false`/`confident=true`)
  - JE auto-balance (`je.lines`), dedup / weight inference (`dataQuality`)
  - Materiality / max-CV thresholds applied as configured
- **Reasonable Judgment-Based** — "made a defensible call." `decisionType = judgment_based`.
  - Realization factor learned from actuals (`carrier.factor`)
  - Ensemble blend engine vs baseline (`carrier.engineWeight`)
  - Mix-shift lift (`carrier.mixShift`), band widening (`halfBand`)
  - Aggregate = `posture.realizationAdjustment` `[A]`

Judgment-based rows are the challengeable ones; the most material feed §6.1's queue.

---

## 7. Surface — Execution (live run)

**For:** primarily the **agent** (humans rarely visit, ~1/10). It's the **live drill-in
of Monitor's Status** — what's actually been done, step by step. It's the **skill file
executing, made visible**: each DB Step renders as a row with live state.

For fast processes (like Accruals) we usually see the finished run; the live-monitor
framing matters for future multi-day processes — but the design is identical, and the
**paused-for-human** case applies even to fast runs.

**Execution is also the agent↔step map.** It renders *which steps are performed by which
agent, using which skill.* A Process can run on **one agent or many** — Execution makes
that assignment legible (Step → Agent + Skill, from `Assignment`; actual executor from
`StepExecution.agentId`). A multi-agent process shows different steps owned by different
agents.

### 7.1 Overview
Which phase, overall progress, where it's at right now. The live step visualization:
*gathering data? processing? which step? which agent?* — incl. an **awaiting-human**
indicator that ties back to Monitor Action Items.

### 7.2 Data Detail
Ingest & normalize (`ingestion`, `dataQuality`): shipments parsed, duplicates removed,
weights inferred, invoices loaded for calibration.

### 7.3 Processing Detail — explicit steps
The heart. The **ordered Step list executing**, each rendered from its `StepExecution`.
For **every step**, document:
- **Input** — what went in
- **Processing** — what it did
- **Policies used + how applied** — links to Policy objects
- **Outcome** — what came out

Steps reference the **Skill file** they came from (e.g. "Processing · `02-calibrate`").
Because each step persists input/processing/policies/outcome, a human can open
**stage N**, add data or tweak a decision, and **re-run → spawns a NEW Run** with
changed downstream results (§4). This is the audit + what-if engine.

### 7.4 Outcome Detail
Book & gate: staged JE (`je.lines`), disposition counts, exceptions raised.

### 7.5 Visualization
A step tracker showing position in the pipeline (Data → Processing → Outcome), per-step
status chips (pending/running/awaiting-human/done/error), and a clear pause marker.

---

## 8. Surface — Improve (continuous improvement)

**What it is:** Improve takes **the steps AND the documented outcome of each step**
(`StepExecution`), **in concert with the policies and everything else**, across **a
number of runs**, reviews it all **holistically**, and proposes **specific
recommendations** to make things better. It then **stops for human approval**, and once
approved, **executes the change by updating the objects in the database.**

It is, concretely, **an agent with an MCP running** — it ingests a large amount of
run/step/policy/outcome data, reasons over it, and proposes targeted improvements.

### 8.1 The levers it can improve
1. **The Steps themselves** — reorder, add, remove, refine a step / its skill.
2. **The Policies themselves** — thresholds, rules, scope (e.g. materiality, max CV,
   factor methodology).
3. **The Output** — how results are computed / booked / presented.

> Out of scope for now: improving the **data inputs** themselves (source values).
> Deferred — not supported in this version.

### 8.2 Trigger & configuration (lives in Setup/Config §5)
Improve is configured per Process, with **default instructions** plus two run modes:
- **Auto** — runs on its own over the **last X runs** (X configurable per process).
- **Ad-hoc** — manually triggered; you **pick exactly which runs** to learn from and can
  **enter words to shape what you're looking for**.

In both modes there are **default instructions**; ad-hoc lets you **override or add to**
them. (This is the prompt/scope for the underlying improvement agent.)

### 8.3 The loop
```
trigger (auto: last X runs · ad-hoc: chosen runs + shaping instructions)
   → LLM agent reasons holistically over steps + outcomes + policies
   → proposes specific, scoped recommendations (each targets a concrete object)
   → STOP · human approval via CHAT (conversational, see §8.4)
   → on approve: agent EXECUTES the change via MCP → writes a new ObjectVersion
   → next run picks up the new version (Run.pinnedVersions)
   → NEVER touches frozen/existing runs retroactively — future runs only
```

### 8.4 Approval is conversational (chat)
Approval is **not** a row of Approve/Reject buttons — it's a **chat**. You can say
things like *"approve 1–6, but for #5 do it this way instead,"* and the agent adjusts
that recommendation before applying. Natural-language, batch-and-amend in one breath.

### 8.5 The agent actually makes the changes
Every page, action, submit, and object in the app is backed by an **API**, exposed as
**MCP tools**. So an approved recommendation isn't just advice — the **agent applies it
directly** (e.g. update Policy params, edit a Step). For each change it:
- shows a **before → after** diff,
- **logs the change to the object** as a new **`ObjectVersion`** (who/when/source),
- giving full **version history** per object.

Because runs **pin versions**, history stays coherent: a run can use **Policy v9 + Skill
v2**, and an older frozen run still resolves to the exact versions it ran on. Applied
changes affect **future runs only**.

### 8.6 Surface layout
- **Recommendations** — each proposal: which lever (step/policy/output), target object +
  proposed new version, rationale, expected effect, before→after diff. Acted on via the
  **chat** approval (§8.4). (Richer successor to today's `learning.proposals`.)
- **Evidence panel** — the cross-run data each recommendation is grounded in (reconcile
  booked vs actual, factor/baseline drift, exception patterns). Seed: existing
  `forwardLearn()` → `{cycles, factorSeries, maeByCarrier, coverage, …}`.
- **Change history** — `ObjectVersion` log across steps/policies/skills.

Approved changes flow back into **Setup/Config** (§5) as new object versions; the next
Run adopts them. This closes the loop: Setup → Execute → Monitor → **Improve** → Setup.

---

## 9. How it all ties together

The **Steps** are the spine:
**Setup authors them → Execute runs & documents them (StepExecution) → Monitor
reviews outcomes and routes human-needed items to Action Items → Improve learns and
proposes step/policy changes → back to Setup.**
**Policies** are referenced at steps and rolled up in Monitor's judgment split.
**Runs** are replayable until **frozen**, then immutable. The whole scaffold is
**process-agnostic** — Accruals today, Revenue/Close/Recs next, same objects.

---

## 10. R1 (now) vs Vision (later)

| Piece | R1 — build now | Vision — later |
|---|---|---|
| Domain model | Process/Run/Step/StepExecution/Policy in Prisma | multi-process catalog at scale |
| Setup | edit view over a seeded Accruals process | NL-description → auto-generated steps |
| Run selector | pick Accruals + period/run, freeze | many processes, rich history/search |
| Monitor | Status / Action Items / Outcomes (policy vs judgment) | real sign-off persistence + audit trail |
| Org hierarchy | Org+Legal Entity (req), Business Unit+Function (opt) on Process | full multi-entity rollups/consolidation |
| Execution | step list from DB, per-step input/processing/policy/outcome, replay→new run | true live streaming of multi-day runs |
| Run state | derive from queue / StepExecution status | async job runner with real progress |
| Tools/Config | Skills + Policies as objects; MCP/Agent/Human/Prompt links; Step→Agent assignment | full multi-agent orchestration |
| Versioning | `version` + `ObjectVersion` on Step/Policy/Skill; Run pins versions | rich branching/compare across versions |
| Improve | agent+MCP over `forwardLearn()`; auto/ad-hoc trigger; chat approval; before→after diffs; apply→ObjectVersion | autonomous closed-loop (apply without human) |

---

## 11. Open questions

**Resolved**
- ~~Policy versioning~~ — all objects versioned; Run pins versions; frozen runs reproduce exactly (§2).
- ~~Improve trigger~~ — Config-controlled: **Auto** (last X runs) or **Ad-hoc** (chosen runs + shaping instructions), over default instructions (§8.2).
- ~~Approval granularity~~ — **conversational/chat** ("approve 1–6, but do #5 differently") (§8.4).
- ~~Improve retroactivity~~ — never touches frozen/existing runs; **future runs only** (§8.5).
- ~~Improve vs Monitor "Update Y"~~ — **distinct**; proposals live in Improve, not Monitor (§6.1).
- ~~Data-input improvement lever~~ — **out of scope** for now (§8.1).

- ~~Sign-off persistence~~ — **signing off = "go on."** It writes a record AND **advances
  the run** (resumes from `awaiting_human`). Sign-off is the human re-initiating execution.
- ~~Step replay granularity~~ — keep it simple: **re-run runs the full thing** (no partial
  downstream replay). Edit → new Run → full run.
- ~~Tool reuse/scope~~ — Tools (Skill/MCP/Agent/Human/Prompt) are **standalone reusable
  entities** in a global registry; **mapped per-process** via `ProcessTool`. One entity
  can be reused across many processes.

**Still open**
- (none blocking — see Build Plan `FINANCE_OS_BUILD_PLAN.md`)
```
