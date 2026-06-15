# Plan — Agent-editable engine code (Freight Accrual)

## Goal
Let the Freight Accrual Owner Agent edit the calculation **methodology** (engine code),
not just policy params. Running stays deterministic (`runProcess` / `runService.executeRun`).
Editing is gated: a methodology change is a *candidate* until a backtest proves it does
not regress accuracy AND a human approves in-conversation.

## Locked decisions
- **Versioning:** DB-as-truth. Full code body + backtest result + status stored in
  `EngineVersion`. The disk file is a materialized pointer to the active version.
- **Execution:** Candidate (just-authored, untrusted) engine bodies run in a
  `worker_thread` for backtesting so a bad edit cannot crash the server. The *active*
  engine, once backtested + approved, is materialized and loaded normally (the validated
  freight path stays unchanged, per repo CLAUDE.md).
- **Refactor scope:** Minimal. Only the methodology unit — `estimateAccrual()` in
  `services/accrual/estimate.js` — becomes file-bound + versioned. Run plumbing,
  persistence, rate engine, calibration, and the gate are untouched.
- **Backtest gate:** Hard gate + human override. `activate` is blocked if the candidate's
  portfolio MAE regresses beyond a threshold vs the current active engine, unless a human
  overrides in-conversation with a recorded reason.

## Why estimate.js is the right unit
`estimateAccrual(accrual, calibration, opts) -> { carriers, portfolio }` is a pure
function. It is imported by BOTH the live run (`runService.executeRun`) and the backtest
(`scripts/forward-backtest.js`). Editing this one module = editing the methodology; the
existing forward backtest already scores exactly this function vs Denise with no look-ahead.

## Build blocks
1. **EngineVersion model** (`prisma/schema.prisma`) — engineKey, version, language, body,
   status (draft|active|superseded|rolled_back), backtest JSON, authoredBy, approvedBy.
2. **engineRegistry service** — seed v1 from the current `estimate.js` body; `activate`
   materializes a version's body to `services/engines/freight-accrual/estimate.js`;
   `loadActive()` returns the active impl with a hard fallback to the built-in module
   (so numbers never break if the registry is empty/unavailable).
3. **estimate.js delegates** to `engineRegistry.loadActive()` while keeping its built-in
   implementation as both the seeded v1 body and the fallback — guarantees parity.
4. **backtestHarness service** — extract the scoring core of `forward-backtest.js` into a
   reusable function that accepts an `estimateAccrual` impl and returns
   `{ portfolioMae, deniseMae, improvementPct, bandCoverage, rows }` (no console).
   `forward-backtest.js` becomes a thin CLI wrapper. A worker runs candidate bodies.
5. **fos__ lifecycle tools** (`services/fosSupervisorTools.js`):
   - `fos__draft_engine(engineKey, code, rationale)` — write a candidate version (not live)
   - `fos__backtest_engine(engineKey, version?)` — run the harness in a worker; store result
   - `fos__engine_diff` / `fos__list_engine_versions` — reads
   - `fos__activate_engine(engineKey, version, override?, reason?)` — gated cutover
   - `fos__rollback_engine(engineKey, version)` — restore a prior body to live
6. **Prompt + verify** — surface engine-editing in `buildSupervisorPrompt`; confirm
   `node scripts/forward-backtest.js` output is byte-identical after the refactor (parity),
   then confirm the lifecycle round-trips.

## Safety invariants
- The validated freight number path must not change. Parity is proven by an unchanged
  backtest after block 3.
- No candidate becomes live without (a) a stored passing backtest on that exact version
  and (b) an explicit human approval/override recorded in the ledger + build_log.
- Every version transition writes `ObjectVersion` + the agent `build_log`.
