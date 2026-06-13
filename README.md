# Ridgeline Finance OS — Freight Accrual Engine

**Finance Engineer Cup, Round 1.** An auditable, gated freight-accrual estimation engine for Ridgeline Foods, built as the first process inside a generalized finance command center.

It estimates April 2026 freight expense from shipment data plus three carrier rate cards, and it beats the predecessor's trailing-3-month average.

| | |
|---|---|
| **Booked accrual (April 2026)** | **$103,402** |
| 90% confidence band | $78,301 to $128,504 |
| Denise's trailing-3mo average | $95,273 |
| Improvement vs baseline | engine lands inside the band every backtested month; Denise missed by $5K to $13K |
| Carriers | Peak Logistics, Heartland Freight, Coastal Express |
| Shipments priced | 161 (deduped, missing weights inferred) |

---

## What it is

The screen you land on is not a report. It is a command center for a process that, in the target state, runs itself. A human drops in to **review and sign**, not to do the math. The work is **deterministic by default, agentic by exception**: rate math is pure code, the realization factor and confidence band are statistical, and only the exceptions reach a person.

Three operational surfaces plus a configuration tab, all driven by one persisted Process model:

- **Monitor** — the overseer's check-in. Hero number, 90% band, per-carrier outcomes, the materiality gate queue, the staged journal entry, and the sign-off button.
- **Execute** — the agent's surface. Every step of the run (ingest, price, calibrate, baseline, estimate, exceptions, gate, post JE, reconcile) shown as Data in, Processing, Outcome.
- **Improve** — the self-review loop. Forward-replay backtest of this engine vs Denise, mean absolute error by carrier, 90% band coverage, and concrete policy-tuning proposals.
- **Setup** — the process definition: steps, versioned policies, the tool registry, and the improvement trigger.

The materiality gate sits **before** the JE posts. If any carrier escalates, the run pauses at `awaiting_human` with the JE staged but not posted until someone signs off.

---

## The accrual approach (why it beats the average)

1. **Deterministic pricing [D].** Every shipment is priced against the correct carrier model: Peak per-mile by weight tier with mileage resolution and a $185 floor; Heartland flat zone rate by ZIP prefix with the quarterly volume discount that resets April 1 (Q2 month 1, Tier 1, 0%); Coastal per-pound by region with tiered residential surcharge, 9.5% fuel, and a $32 floor. This produces the **contract baseline**.
2. **Realization factor [A].** Six months of historical invoices teach a per-carrier factor (median of actual-to-contract) that captures what invoices actually land at versus the contract: Peak 1.032, Heartland 1.048, Coastal 1.004.
3. **Regime-aware ensemble [A].** An inverse-variance blend of the engine estimate and the trailing baseline, with engine weight lifted when a volume or mix shift is detected (this is exactly the Heartland-tier-reset trap that cost Denise $7,133 in January).
4. **Confidence band + gate.** A 90% band from the calibration spread. A carrier auto-posts only if its half-band is under the materiality threshold ($1,500) and its CV is under the max (0.15); otherwise it escalates to a human.

Every parameter in steps 2 to 4 is a **versioned Policy object**, not a magic number in code. The algorithm stays in code; the knobs are data the Improve loop can tune.

---

## Stack

- **Engine** — pure Node, no DB dependency, runs live from the CSV data files (`services/accrual/*`). This is the validated deterministic core.
- **Persistence** — Prisma + PostgreSQL. Generalized model: `Process -> Step / Policy / Tool -> AccrualRun -> StepExecution`, plus an append-only `LedgerEvent` system of record and `ObjectVersion` for policy versioning.
- **Web** — Express + EJS, server-side rendered, light mode, CFO-ready.
- **MCP** — a Model Context Protocol server (`mcp/server.js`) exposing the whole pipeline as 10 reusable tools so any agent can drive the loop.

---

## Setup

**Prerequisites:** Node 18+, PostgreSQL 14+ running locally.

```bash
# 1. Install
npm install

# 2. Configure the database URL
cp .env.example .env
#    edit .env so DATABASE_URL points at your Postgres, e.g.
#    DATABASE_URL=postgresql://<you>@localhost:5432/ridgeline

# 3. Create the database (once)
createdb ridgeline

# 4. Apply schema + seed the process, policies, tools, and load the CSV data
npx prisma migrate deploy        # or: npx prisma db push
npm run seed

# 5. Produce the April run (creates the system-of-record run)
npm run run-accrual

# 6. Start the web app
npm start
#    open http://localhost:3000   (set PORT to change)
```

You land on the Monitor surface with the April run staged at `awaiting_human`. Sign off in the UI to post the journal entry.

---

## MCP server

The pipeline is exposed as MCP tools so it is reusable from Claude Desktop or any agent.

```bash
npm run mcp        # stdio transport
```

Register it with an MCP client using `mcp/claude_desktop_config.example.json` (update `cwd` and `DATABASE_URL`).

**Tools:**

| Tool | What it does | Side effects |
|------|--------------|--------------|
| `freight_estimate` | Point estimate, 90% band, per-carrier, vs Denise | none (reads data files) |
| `freight_price_shipment` | Price one shipment against the right rate card | none |
| `freight_run_accrual` | Run and persist the stepped accrual | creates a run |
| `freight_list_runs` | List persisted runs | none |
| `freight_get_run` | Full run detail, the audit trail | none |
| `freight_sign_off` | Post the staged JE (human approval) | posts JE |
| `freight_freeze_run` | Lock a run for period close | freezes |
| `freight_reconcile` | Backtest accuracy vs Denise, proposals | none |
| `freight_get_policies` | The versioned policy params (Improve target) | none |
| `freight_set_policy` | Apply a tuning proposal as a new policy version | bumps version |

The deterministic tools (`freight_estimate`, `freight_price_shipment`) need no database. The stateful tools need `DATABASE_URL`.

A REST mirror of the same surface lives at `/api/fos/*`.

---

## Messy-data handling

- **Carrier name variants** normalized (6 raw forms to 3 canonical).
- **Duplicate shipments** deduped by id.
- **Missing weights** inferred from per-carrier median lbs/unit.
- **Heartland zones are ZIP-prefix based, not state** (Kansas City KS 661xx is Zone 1, the rest of KS is Zone 2).
- **Peak missing mileage** flagged; out-of-territory destinations (for example Reno) raised as critical exceptions.
- **Heartland Q2 reset** handled by quarter-to-date cumulative volume tiering.

Each data issue is logged as an Exception with a severity and surfaces in the overseer queue.

---

## Controls and auditability

- 90% confidence band on every carrier and the portfolio.
- Materiality times confidence gate decides auto-post vs escalate.
- Critical anomaly flags (out-of-territory, unknown carrier, missing weight).
- Append-only event ledger: every material action with actor and timestamp.
- Runs pin the policy versions they used, so a past run is exactly reproducible.
- Sign-off and freeze produce an immutable system of record.

---

## What I would improve next

- Per-shipment accessorial prediction from invoice history instead of the per-carrier accessorial rate, to tighten the band further.
- Wire the Improve loop's `freight_set_policy` proposals to an in-UI approve action so tuning is one click.
- Add a second process (for example a rebate or commission accrual) to prove the model generalizes beyond freight.
- Replace the seeded historical backtest with a rolling monthly close cadence on real invoice arrivals.

---

## Repo map

```
services/accrual/      validated deterministic engine (ingest, rate engine, calibrate, estimate, learn)
services/accrual/runService.js   stepped runner + persistence (gate-before-post)
routes/financeOs.js    SSR surfaces + run actions
routes/fosApi.js       REST API mirror
mcp/server.js          MCP server (10 tools)
views/fos/             Monitor / Execute / Improve / Setup
prisma/schema.prisma   generalized Process model
prisma/seed.js         seeds the process, policies, tools, loads CSV data
data/                  the challenge data files
scripts/run-once.js    produce a run from the CLI
```
