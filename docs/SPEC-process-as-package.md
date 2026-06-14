# Process-as-Package Architecture Spec

**Status:** Decisions locked — ready to build
**Date:** 2026-06-13
**Author:** Ridgeline (AI Architect Agent)
**Repo:** `ridgeline-finance-os` (Express + EJS SSR, hand-written CSS, Prisma 6.8, local Postgres `ridgeline`, dev on :3070)

> **Grounded in the REAL schema.** An earlier draft of this spec was mistakenly written
> against a different codebase (the aigym-platform) and claimed this repo had "no
> Process/Step/Engine/Policy/Run models." That was wrong. Ridgeline Finance OS **already has**
> the full org→process→step→policy→tool→run→execution model *and* a Process Owner Agent
> supervisor. This spec is now an **evolution of what exists**, not a greenfield build. See §2.

> **Prototype intent.** This is a fully-working prototype, NOT production. The decisions in
> §14 deliberately skip production concerns (sandboxing, multitenancy, cost tracking, file-sync).
> We keep the *structure* future-friendly so those layer in later without re-architecting. The
> existing Finance OS visuals (the `fos.ejs` command center + `flow.ejs` Flow diagram) are the
> target look — we are re-architecting **how it works underneath**, not the visual language.

---

## 1. Executive Summary

Every process becomes a **self-contained package**: a `Process` plus its `Step`s, the engine
code each step runs, its `Policy`s, its `Tool` attachments, its `Run`s, and a dedicated
**owner-agent**. The agent **engineers** the package (writes engines, defines steps, sets
policies), **supervises** its runs, and **modifies** it agentically when change is needed.

Crucially, this is an evolution of three things already in the repo:
1. The **Process model layer** (`Organization`→`Process`→`Step`/`Policy`/`Tool`→`AccrualRun`→`StepExecution`) added in the `finance_os_process_model` migration.
2. The **Process Owner Agent** supervisor (auto-provisioned, `fos__` tools, chat dock) added in `process_owner_agent`.
3. The **generic-runner gap**: today `runService.executeRun` is freight-hardcoded and `flow.ejs` hardcodes the 10 freight steps (tracked in `GENERIC_RUNNER_PLAN.md`). Making the runner + Flow data-driven is the backbone of "any process is a package."

**Key principles**
- **Agentic creation** — the owner-agent builds the package; no manual step/engine authoring.
- **Deterministic execution** — the built engine runs as code; the agent is NOT in the critical path (matches today's supervisor design).
- **Agentic modification** — changes flow through the owner-agent and are versioned via `ObjectVersion`.
- **Package isolation** — each process is a complete unit scoped to one `Organization`.

---

## 2. Current State (REAL — what already exists in this repo)

### 2.1 The Process model layer (already built)

`prisma/schema.prisma` already defines the generalized layer. The freight accrual is just the
**first** process loaded onto it.

| Model | Role | Key fields |
|-------|------|-----------|
| `Organization` | **Tenant boundary** | `slug` unique; has `legalEntities`, `processes` |
| `LegalEntity` / `BusinessUnit` / `OrgFunction` | Org hierarchy | Process can hang off any of these |
| `Process` | The package root (already **org-scoped**) | `orgId`, `legalEntityId`, `businessUnitId?`, `functionId?`, **`agentId?` (owner agent)**, `slug` (`@@unique([orgId, slug])`), `frequency`, `mode`, `improveTrigger`, `isActive` |
| `Step` | Ordered operation | `order`, `key` (`@@unique([processId,key])`), `decisionType`, **`engineSource`** (the "engine" pointer), `toolId`, `isGate`, `pauseAfter`, `version` |
| `Policy` | Rule/guardrail | `scope` (`org`/`function`/`process`/`step`), `key`, `definition`, `params`, `version` |
| `Tool` | Global tool registry | `type` (`skill`/`mcp`/`agent`/`human`/`prompt`/`automation`), `slug`, `config` |
| `StepTool` / `ProcessTool` | m2m tool attachment | a step/process draws many tools |
| `AccrualRun` | **The generic Run** | `processId`, `period`, `mode`, `status` (`RunStatus`), `frozen`, `parentRunId`, `pinnedVersions`, `totalAccrual`, `summary` |
| `StepExecution` | **The audit spine** (per-step run record) | `runId`, `stepId?`, `order`, `key`, `status` (`StepStatus`), `decisionType`, `input`, `processing`, `policiesApplied`, `outcome`, `override`, timestamps |
| `AccrualLine` / `Exception` / `LedgerEvent` / `Reconciliation` | Run detail, controls, audit, learn | per-line math, exception queue, append-only event ledger, actuals reconciliation |
| `ImprovementProposal` | Recursive self-improvement | `lever`, `component`, `diagnosis`, `proposal`, `riskLevel`, `status`, `target`, `appliedVersionId` |
| `ObjectVersion` | **Versioning ledger** | `objectType`, `objectId`, `version`, `diff`, `source`, `approvedBy`, `approvedAt` |

Enums already present: `RunStatus` (draft/processing/awaiting_human/needs_review/approved/posted/reconciled/blocked), `RunMode` (auto/adhoc/manual), `DecisionType` (policy_based/judgment_based/mixed), `StepStatus` (pending/running/done/awaiting_human/skipped/error), `ToolType`, `PolicyScope`, `ExceptionSeverity`.

### 2.2 The Process Owner Agent (already built)

Every process is already owned by exactly one **Process Owner Agent** — a supervisor that
observes live run state, explains it, and can trigger/sign-off steps on a human's instruction.
It is **NOT in the critical path** (the deterministic engine does the math). Auto-provisioned
when a process is created.

- `services/accrual/processAgentService.js` — `provisionOwnerAgent`, `backfillOwnerAgents`; builds the process-aware supervisor system prompt.
- `services/fosSupervisorTools.js` — the `fos__` LLM tool surface: `run_status`, `list_runs`, `run_detail`, `trigger_run`, `sign_off`, `freeze`, `improvements`, `explain_variance`. Wired in `routes/chat.js` when `agent.features.processSupervisor`.
- `services/contextBuilder.js` — injects live run state into the prompt each turn.
- `services/accrual/supervisorService.js` — proactive `tick(slug)` + `startScheduler()` (every 15m, booted in `server.js`).
- UI: the **"Supervised by [agent]"** pill in `views/fos.ejs` + the floating **chat dock**.

The `Agent` model already carries `ownedProcesses Process[] @relation("ProcessOwnerAgent")`, and `AgentDocument` (docTypes: `soul`/`memory`/`context`/`daily`), embeddings, capabilities, etc.

### 2.3 The gap this spec closes

1. **Runner is freight-hardcoded.** `runService.executeRun` constants `PROCESS_SLUG='freight-accrual'`, calls `runAccrual()`, and `buildStepExecutions()` hardcodes the 10 freight steps. A new process has step metadata but nothing executes it. (Tracked in `GENERIC_RUNNER_PLAN.md`.)
2. **Flow visual is freight-hardcoded.** `views/fos/flow.ejs` hardcodes `LAYOUT`/`ORDER`/`statFor()`/`EDGES` to the 10 freight keys; a new process renders zero nodes.
3. **No step-level DAG.** `Step` has only `order` (linear int) — no dependency/edge field. Topology lives only in the hardcoded `EDGES` array.
4. **No agentic BUILD path.** The owner-agent today only *supervises*. It cannot yet *create/modify* steps, engines, and policies from a conversation. The `engineSource` is hand-written in `services/accrual`, not agent-authored.
5. **No engine-file convention.** Engines are bespoke code under `services/accrual`. We need a per-process engine-file convention so any agent-built process has runnable code.

---

## 3. The Package — mapped to EXISTING models

We do **not** add a parallel `Process/ProcessStep/ProcessEngine/...` family. We use what exists
and make small additive changes. Mapping:

| Package concept | Existing model | Change needed |
|-----------------|----------------|---------------|
| Definition | `Process` | none (already org-scoped + owner agent) |
| Steps | `Step` | **add DAG: `dependsOn String[]`, `feedbackTo String?`** (from `GENERIC_RUNNER_PLAN`) |
| Engines | `Step.engineSource` + `Tool` registry | **convention: `engineSource` = path to an agent-written engine file**; register an `automation`-type `Tool` per engine |
| Policies | `Policy` | none (scope enum already supports org/function/process/step) |
| Runs | `AccrualRun` + `StepExecution` | none (already generic; `summary`/`outcome` JSON degrade for non-freight) |
| Package version | `ObjectVersion` | **add `objectType='process_package'` snapshots** for package-level versioning |
| Engine/step/policy version | `Step.version` / `Policy.version` + `ObjectVersion` | none (already per-object versioned) |
| Tenant | `Organization` | none (Process already `@@unique([orgId, slug])`) |
| Owner agent | `Agent` + `Process.agentId` | **extend supervisor → also gains BUILD tools** |
| Secrets | *(none today)* | **add `ProcessSecret`** (optional, see §3.2) |
| **Skills** | `Tool` (`type='skill'`) + `StepTool`/`ProcessTool` | none — agent registers a skill as a `Tool` and attaches it to steps/process |
| **Context & Memory** (build log, design decisions, institutional knowledge, "why") | `Agent.instructions` + `AgentDocument` + `AgentMemoryEmbedding` (pgvector) | **extend `AgentDocType` enum: add `build_log`, `run_summary`** (§4.4) |
| **Historic Runs** (outcomes, logs, artifacts) | `AccrualRun` + `StepExecution` + `LedgerEvent` | none (already the full audit trail) |

### 3.1 Additive schema change — Step DAG

```prisma
model Step {
  // ... existing fields ...
  dependsOn  String[] @default([]) @map("depends_on")        // forward data deps (acyclic), references sibling Step.key
  feedbackTo String?  @map("feedback_to") @db.VarChar(60)    // optional improve-loop target Step.key
}
```

Edges become **data**, not a hardcoded array. The freight DAG is encoded in `prisma/seed.js`
(normalize/calibrate/baseline ← ingest; price ← normalize; estimate ← price,calibrate,baseline;
gate ← estimate,exceptions; post_je ← gate; reconcile_learn ← post_je; `reconcile_learn.feedbackTo = 'calibrate'`).

### 3.2 Additive schema change — package versioning + secrets

Package-level versioning reuses the existing `ObjectVersion` ledger with a new `objectType`:

```
ObjectVersion { objectType: 'process_package', objectId: <processId>, version, diff: <full package snapshot>, source, approvedBy }
```

`Process` gains a lightweight `version Int @default(1)` counter so the live package and its runs
can cite the version they ran against. Engine- and policy-level versioning already exist
(`Step.version`, `Policy.version`) — we keep **both levels** (decision §14.3b).

Optional `ProcessSecret` (only if a built process needs credentials; mirrors `PlatformSetting`):

```prisma
model ProcessSecret {
  id             String  @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  processId      String  @map("process_id") @db.Uuid
  key            String  @db.VarChar(100)
  encryptedValue String  @map("encrypted_value") @db.Text
  process        Process @relation(fields: [processId], references: [id], onDelete: Cascade)
  @@unique([processId, key])
  @@map("process_secrets")
}
```

---

## 4. Agent–Process Binding (extend the existing supervisor)

### 4.1 One agent owns the whole package

`Process.agentId` → `Agent` (relation `ProcessOwnerAgent`) already gives us 1:1 ownership. The
owner-agent owns the **entire** package, including every `Step`, its `engineSource`, `Policy`s,
and any nested `subProcess`-type steps. For now there is **no per-subprocess agent and no
agent-to-agent delegation** (decision §14.2) — one agent is responsible for the whole tree.

### 4.2 Two hats: Supervisor (exists) + Builder (new)

Today the owner-agent is a **Supervisor** (`fos__` tools, not in critical path). We add a
**Builder** capability so the same agent can engineer/modify the package from chat:

| Hat | Status | Tools |
|-----|--------|-------|
| Supervisor | ✅ exists | `fos__run_status`, `list_runs`, `run_detail`, `trigger_run`, `sign_off`, `freeze`, `improvements`, `explain_variance` |
| Builder | 🆕 new | `fos__create_step`, `update_step`, `reorder_steps`, `set_engine`, `create_policy`, `update_policy`, `attach_tool`, `snapshot_package` |

The Builder tools write through the existing service layer and emit `ObjectVersion` rows (and a
`build_log`-style `AgentDocument`) so every change is versioned and auditable — reusing the
`ImprovementProposal`/`ObjectVersion` machinery that already powers self-improvement.

### 4.3 Agent knowledge scope

The owner-agent reads, scoped to its `processId` (and `orgId`): the `Process`, `Step`s,
`engineSource` files, `Policy`s, `Tool` attachments, `AccrualRun`+`StepExecution` history,
`Exception`/`LedgerEvent`/`Reconciliation`/`ImprovementProposal`, plus its own `AgentDocument`
memory/context. `contextBuilder.js` already injects live run state each turn. **Scoping is
read AND write, and is enforced on every query** by `processId`/`orgId` — an owner-agent can
never touch another process's data.

### 4.4 Agent anatomy & knowledge representation (the "Data Storage Consideration")

The MyAIforOne agent paradigm uses a file-based folder per agent (`CLAUDE.md`, `memory/*.md`,
`vectors.json`, `goals/`, `tasks.json`, `FileStorage/`). The open question raised was: **for a
Postgres + pgvector platform, do we store that agent knowledge as flat files, as DB fields, or a
hybrid?**

**Decision (§14.7): hybrid, DB-as-truth.** This repo already implements exactly the hybrid we
want — markdown content lives in Postgres text fields, semantic memory in pgvector. No flat agent
files. The **only** thing written as real files is engine *code* (§7.2). Mapping the full agent
folder anatomy onto the existing schema:

| Folder artifact | Purpose | ridgeline-finance-os representation | Status |
|-----------------|---------|-------------------------------------|--------|
| `CLAUDE.md` | system prompt / identity / instructions | `Agent.instructions` (text) | ✅ exists |
| `memory/context.md` | persistent context (full package awareness) | `AgentDocument(docType=context)` | ✅ |
| `memory/learned.md` | wiki / facts learned from runs | `AgentDocument(docType=memory)` | ✅ |
| build log — how/why it was built, design decisions | institutional knowledge | `AgentDocument(docType=build_log)` | 🆕 add enum value |
| run summaries — aggregated outcomes/patterns | reporting memory | `AgentDocument(docType=run_summary)` | 🆕 add enum value |
| `memory/daily/*.md` | daily journals | `AgentDocument(docType=daily)` | ✅ |
| secrets / credentials | institutional secrets | `ProcessSecret` (§3.2) | 🆕 (optional) |
| `memory/conversation_log.jsonl` | chat history | `Conversation` + `Message` | ✅ |
| `memory/vectors.json` | semantic memory embeddings | `AgentMemoryEmbedding` (pgvector 1536) | ✅ |
| `memory/session.json` | session state | `Conversation.sessionToken` + `lastMessageAt` | ✅ |
| `memory/tool_calls.jsonl` | tool invocation log | `Message.metadata` (tool calls already recorded there) | ⚠ partial — sufficient for prototype |
| `goals/log-*.jsonl` | scheduled-run logs | handled by `supervisorService` scheduler + `LedgerEvent` ledger | ↔ different mechanism |
| `tasks.json` | pending tasks | not modeled | ⏭ future (not needed for prototype) |
| `FileStorage/Permanent/` | agent artifacts (reports, exports) | not modeled — run artifacts live in `StepExecution.outcome` / `AccrualLine`; `KBDocument` available if needed | ⏭ future |

**Net new schema for agent knowledge:** just two `AgentDocType` enum values — `build_log` and
`run_summary`. Everything else the agent paradigm needs already exists. `tasks.json` and a
generic `FileStorage` are explicitly deferred (not required for the prototype).

---

## 5. Creation Flow

1. **User starts a new process** (chat-first; metadata = name, org/entity/BU/function, frequency, description).
2. **Process + owner-agent are born together** — reuse `provisionOwnerAgent`; set `Process.isActive`.
3. **Builder conversation** — the agent proposes the canonical package (steps + engines + policies + tool attachments) and, on approval, uses Builder tools to create them.
4. **Engines written as files** — for each engine step the agent writes a real file (see §7.2) and points `Step.engineSource` at it; registers an `automation` `Tool`.
5. **Finalize** — cut a `process_package` `ObjectVersion` v1, set the process active, seed the agent's `context`/`build_log` documents.
6. **Visual confirmation** — the standard tab set (§9: Overview/Execute/Flow/Improve/History) renders the package immediately.

---

## 6. Modification Flow

All structural change flows through the owner-agent's Builder tools (no form-based step/engine
editing). Each change:
- writes through the service layer,
- bumps `Step.version` / `Policy.version` as appropriate,
- emits an `ObjectVersion` row (`source='agent'`),
- on a meaningful batch, cuts a new `process_package` snapshot + bumps `Process.version`,
- logs a `build_log` `AgentDocument` entry.

This is the same lever the existing `ImprovementProposal` flow already uses (`appliedVersionId`
points at the `ObjectVersion` that applied a proposal) — we generalize it from "policy bump" to
"any package edit." **Versioning is two-level** (decision §14.3b): per-object (`Step`/`Policy`)
and per-package (`process_package` `ObjectVersion` + `Process.version`, with rollback).

---

## 7. Execution Flow

### 7.1 Deterministic runtime (generic runner)

Replace the freight-only `runService.executeRun` with a generic `processRunner.runProcess({ processSlug, period, mode, actor })` (per `GENERIC_RUNNER_PLAN.md`):
- **Engine registry**: `{ 'freight-accrual': executeRun }` — freight **delegates to the untouched validated path** (must stay 27/27 green, April still $103,402.27).
- **Any other process**: topologically sort `Step`s by `dependsOn`, run each step's `engineSource`, write a `StepExecution` per step, honor `isGate`/`pauseAfter` (→ `awaiting_human`), create the `AccrualRun` + `LedgerEvent`s. The agent is NOT in the critical path.

### 7.2 Execution environment (NO sandboxing — prototype)

Decision §14.1: **engines are not sandboxed.**
- Engine source is stored both in the codebase as a real file — convention `services/engines/{process-slug}/{engine-slug}.js` (or `.py`) — and referenced by `Step.engineSource`. Adding engine files directly to the repo is intentional and accepted for the prototype.
- JS engines run in-process; Python engines run via a plain `python` subprocess. No import allow-lists, no resource limits, no isolation.
- Each engine receives its step `config` + upstream `StepExecution.outcome`s as input; output is written to `StepExecution.outcome` (and should match a declared shape, validated not security-enforced).
- `ProcessSecret` values (if any) are passed as env vars at runtime.

> Production hardening (sandboxing/containers/limits) is explicitly out of scope; designed later.

### 7.3 Triggers

Manual (UI "Run"), cron (existing `supervisorService` scheduler), API (`POST /api/fos/.../run`),
agent (`fos__trigger_run`), or chained (`subProcess` step) — all route through `runProcess`.

---

## 8. Agent Tools (extend the `fos__` surface)

Add the Builder tools alongside the existing supervisor tools in `services/fosSupervisorTools.js`,
keeping the `fos__` prefix and the per-`processId` scoping that's already enforced:

```
// Build (new)
fos__create_step(key, name, order, decisionType, dependsOn?, engineSource?, isGate?, pauseAfter?)
fos__update_step(stepId, updates)            // bumps Step.version + ObjectVersion
fos__reorder_steps(stepKeys[])
fos__set_engine(stepKey, language, sourceCode)   // writes the engine file + sets engineSource
fos__create_policy(key, name, scope, params, stepKey?)
fos__update_policy(policyId, updates)         // bumps Policy.version + ObjectVersion
fos__attach_tool(stepKey|process, toolSlug, role?)
fos__snapshot_package(reason)                 // cuts process_package ObjectVersion + bumps Process.version
```

> **Docs mandate (CLAUDE.md):** every new REST route → update `docs/catalog.js`; every new MCP
> tool in `mcp/server.js` → update `mcp/toolCatalog.js` (server == catalog count); run
> `/opappbuild_agentready_trueup` after REST/MCP changes.

---

## 9. UI — the canonical template + standard tab set

### 9.0 The ONE canonical template (decision §14.3)

Every process-agent builds to exactly one template — **Process → Steps → Engines → Policies** —
and **every process exposes the same standard tab set during execution**, the tabs the platform
already renders today via `views/fos/worknav.ejs`. The agent does not invent its own per-process
navigation; it populates these standard tabs from package data:

| Tab | View file | Design freedom | What it shows |
|-----|-----------|----------------|---------------|
| **Overview** | `monitor.ejs` | **Flexible** — the agent may present this differently per process (KPI cards, headline numbers, the shape that best explains *this* process) | At-a-glance health: status, recent runs, headline number(s), gate/policy state, "Supervised by [agent]" pill + chat dock |
| **Execute** | `execute.ejs` | **Standard** | The run trigger + live step-by-step execution state (the standard run experience) |
| **Flow** | `flow.ejs` | **Standard** | The step DAG, replayable ("Revisualize" waves) — **data-driven** from `Step.dependsOn`/`feedbackTo` (no hardcoded freight `EDGES`) |
| **Improve** | `improve.ejs` | **Standard** | Self-improvement: `ImprovementProposal`s + immutable `ObjectVersion` policy/version history |
| **History** | `history.ejs` | **Standard** | Past runs, outcomes, audit; degrades gracefully for non-freight runs |
| **Setup** | `setup.ejs` | Standard (read-only inspection post-§14.8) | Definition, steps, policies, tools — inspection only; edits go through the agent |

**Rule:** the *Overview* tab is where a process gets visual flexibility (it can be designed to
present its own story); **Execute, Flow, Improve, and History are standardized** so every process
behaves the same way at run time. More templates may come later — for now this is the single
template, and every process conforms. **We keep the existing visual language; we re-architect the
mechanics underneath.**

### 9.1 Data-driven Flow (the key view change)

`flow.ejs`: delete the hardcoded `LAYOUT`/`ORDER`/`statFor()`/`EDGES`; derive `NODES` from
`proc.steps` joined to the run's `StepExecution`s, and `EDGES` from each step's `dependsOn`
(+ `feedbackTo` as a labeled feedback edge). Auto-layout by longest-path depth. Per-node stat =
`outcome.headline` (freight engine sets the nice strings; scaffold sets a generic one). Empty/linear
processes degrade gracefully. Bump `fos.css?v=` if CSS changes (per CLAUDE.md).

### 9.2 Process list / detail

Reuse the existing `routes/financeOs.js` `buildView` (already loads the owner agent). A
`/processes` list (org-scoped) + the existing process detail pages, with the chat dock as the
primary modification interface.

---

## 10. API (extend existing `/api/fos`)

Build on the current routes (`routes/financeOs.js`, `routes/fosApi.js`, `mcp/server.js`) rather
than a new surface. Run trigger repoints to `runProcess`. Add agent-only Builder endpoints
mirroring the Builder tools (§8), all scoped by `orgId` + `processId`. Keep `docs/catalog.js` and
`mcp/toolCatalog.js` in lockstep (CLAUDE.md mandate).

---

## 11. Migration Plan (additive only — protect freight)

**Hard constraint:** `node scripts/validate.js` stays **27/27 green** and April stays
**$103,402.27** at every gate. We add a generic path; we never rewrite the validated freight path.

1. `step_dag` migration — add `Step.dependsOn String[]`, `Step.feedbackTo String?`; add `Process.version Int @default(1)`.
2. `agent_doc_types` migration — extend `AgentDocType` enum with `build_log` and `run_summary` (§4.4).
3. (optional) `process_secret` migration — add `ProcessSecret`.
4. No new Run/Step/Policy/Engine/Skill tables — they exist (skills are `Tool(type='skill')`).
5. `prisma/seed.js` — encode the freight DAG via `dependsOn`/`feedbackTo`; re-seed; re-run `scripts/seed-demo.js`.
6. **GATE:** `node scripts/validate.js` → 27/27; April unchanged.

---

## 12. What changes / what's preserved

**Removed — manual paths go away (decision §14.8; agentic-only creation AND modification)**
- Manual **process creation** UI/endpoints — a process can ONLY be created via the builder agent.
- Manual **step/engine/policy creation** (e.g. `configService.addStep`/`updateStep` form paths) — replaced by the agent's Builder tools.
- Manual **editing** of steps/engines/policies through forms — modifications go through the owner-agent, which then re-renders the package visually. (Read-only inspection of step/engine/policy detail stays.)

**Changed**
- `Step` gains `dependsOn`/`feedbackTo`; `Process` gains `version`; `AgentDocType` gains `build_log`/`run_summary`.
- `runService.executeRun` → wrapped by generic `processRunner.runProcess` (freight delegates, untouched).
- `flow.ejs` becomes data-driven.
- Owner-agent gains Builder tools (the `fos__` surface grows) on top of its existing Supervisor tools.
- Engine code convention: per-process engine files under `services/engines/{slug}/`.

**Preserved (do not touch)**
- The validated freight engine/math and `scripts/validate.js` (27/27).
- The Process Owner Agent supervisor, `contextBuilder`, `supervisorService` scheduler, chat dock.
- `ObjectVersion`/`ImprovementProposal` versioning + self-improvement loop.
- The existing visual language (`fos.ejs`, `flow.ejs`, hand-written CSS).
- The Agent/AgentDocument/Capability/Conversation infrastructure.

---

## 13. Implementation Phases

### Phase 0 — Schema: Step DAG + package version + agent doc types (additive)
- [x] Add `Step.dependsOn`/`feedbackTo` + `Process.version`; migrate (`step_dag`) against local `ridgeline` DB.
- [x] Extend `AgentDocType` enum with `build_log`, `run_summary`; migrate (`agent_doc_types`).
- [x] (optional) Add `ProcessSecret`; migrate (`process_secret`).
- [x] Encode freight DAG in `prisma/seed.js`; re-seed + `scripts/seed-demo.js`.
- [x] **GATE:** `node scripts/validate.js` → 27/27; April still $103,402.27.

### Phase 1 — Generic runner (freight delegates, untouched)
- [x] `services/runner/processRunner.js` with engine registry; freight → `executeRun`.
- [x] Scaffold path for any other process: topo-sort by `dependsOn`, write `StepExecution`s, gate handling, create `AccrualRun` + `LedgerEvent`s.
- [x] Repoint run triggers (routes + MCP) to `runProcess`.
- [x] **GATE:** freight via `runProcess({processSlug:'freight-accrual'})` produces the identical run.

### Phase 2 — Data-driven Flow + Monitor (keep the look)
- [x] `flow.ejs`: derive `NODES`/`EDGES`/layout from `Step`s + `dependsOn`/`feedbackTo`; per-node `outcome.headline`.
- [x] Move freight stat strings into the freight engine's `outcome.headline` (visual unchanged).
- [x] Monitor/dashboard degrades gracefully for non-freight runs (vsDenise/dispositions → `—`).
- [x] **GATE:** freight Flow still 10 nodes/13 edges; new process renders its own DAG.

### Phase 3 — Builder tools (agent engineers the package)
- [x] Add `fos__create_step/update_step/reorder_steps/set_engine/create_policy/update_policy/attach_tool/snapshot_package` to `fosSupervisorTools.js`.
- [x] `set_engine` writes the engine file under `services/engines/{slug}/` (no sandbox) + sets `engineSource`.
- [x] Every Builder edit emits `ObjectVersion` (`source='agent'`) + `build_log` AgentDocument.
- [x] Update `docs/catalog.js` + `mcp/toolCatalog.js`; run `/opappbuild_agentready_trueup`.

### Phase 4 — Creation flow + remove manual paths + package versioning
- [x] Chat-first new-process creation; reuse `provisionOwnerAgent`; builder system prompt enforcing the canonical template (§9.0).
- [x] On finalize, seed the owner-agent's `AgentDocument` `context` + `build_log` docs from the built package.
- [x] `snapshot_package` → `process_package` `ObjectVersion` v1 on finalize; `Process.version` bump + rollback on later changes.
- [x] **Remove manual paths (§12/§14.8):** delete/disable manual process-create UI/endpoints and `configService` step/policy create+edit form paths; keep read-only inspection. Modifications now route through the owner-agent.

### Phase 5 — End-to-end verification (evidence required)
- [x] `node scripts/validate.js` → 27/27.
- [x] Freight Flow + Monitor unchanged (screenshot via op_devbrowser).
- [x] NEW ~5-step process (incl. `dependsOn`, one `isGate`, one `feedbackTo`) built by the agent, run via `runProcess`, renders its DAG + lists its run with financial cells degraded to `—`.
- [x] No hardcoded freight keys remain in `flow.ejs`.

---

## 14. Decisions (locked 2026-06-13)

1. **Engine sandboxing — NO.** Prototype only. Engines run unsandboxed; source committed as real files under `services/engines/{slug}/`, referenced by `Step.engineSource`. Production hardening deferred. (§7.2)
2. **Agent-to-agent — NO (future).** One owner-agent owns the entire process tree incl. `subProcess` steps; no delegation now. (§4.1)
3. **Templates — ONE canonical template, enforced.** Process → Steps → Engines → Policies, with the standard tab set (Overview/Execute/Flow/Improve/History) modeled on today's `worknav.ejs`. Overview is flexible per process; Execute/Flow/Improve/History are standardized. Agents can't invent their own navigation. (§9.0)
3b. **Versioning — BOTH levels.** Per-object (`Step.version`/`Policy.version` + `ObjectVersion`) AND package-level (`process_package` `ObjectVersion` + `Process.version`, with rollback). Runs cite the version they ran against. (§3.2, §6)
4. **Tenancy — Organization is the boundary.** Already in schema (`Process @@unique([orgId, slug])`). Different orgs are fully separate. Single org for now; no full multitenancy build yet, but the boundary stands. (§2.1)
5. **File-based sync — NO (future).** The database is the source of truth; engine files live in the repo. No MyAIforOne folder sync now (structure kept compatible for later).
6. **Cost tracking — NO (future).** Not added to `AccrualRun`/`StepExecution` now.
7. **Agent knowledge storage — hybrid, DB-as-truth.** Markdown in Postgres text fields
   (`Agent.instructions`, `AgentDocument`), semantic memory in pgvector (`AgentMemoryEmbedding`),
   runtime artifacts in DB JSON. No flat agent files; the only files written are engine *code*.
   Add `AgentDocType` values `build_log` + `run_summary`. `tasks.json` + generic `FileStorage`
   deferred. (§4.4)
8. **Manual creation/editing — REMOVED.** Processes, steps, engines, and policies can ONLY be
   created and modified through the owner-agent. Manual create/edit forms go away; read-only
   inspection stays. (§12)

---

## 15. Summary

Ridgeline Finance OS already has the bones of process-as-package: an org-scoped `Process` model,
`Step`/`Policy`/`Tool`, a generic `AccrualRun`+`StepExecution` run spine, `ObjectVersion`
versioning, and a Process Owner Agent supervisor. This spec **evolves** that — it makes the runner
and Flow generic (data-driven DAG), gives the owner-agent **Builder** tools so it can engineer and
modify the package agentically (versioned via `ObjectVersion`), and standardizes every process onto
one template with the standard tab set (Overview/Execute/Flow/Improve/History) using the existing visual language. Freight
stays exactly as-is (27/27, $103,402.27) throughout; we add a generic path, we don't rewrite the
validated one.

```
User describes → Owner-agent builds (Builder tools) → Package exists (org-scoped)
                                  ↑                              │
                                  └── Agent modifies (versioned) ┘   runs deterministically via processRunner
```
