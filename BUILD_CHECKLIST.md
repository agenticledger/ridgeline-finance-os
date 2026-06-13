# Ridgeline Finance OS — Build Checklist

The Finance OS, with Freight Accruals as the first Execution loop. SSR (Express + EJS), Postgres + pgvector, copied from the orphil-web multi-agent base. Futuristic but professional. Deployed to Railway.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Phase 0 — Base Setup
- [x] Copy orphil-web base into `ridgeline-finance-os` (no node_modules/.git/.env)
- [x] Write this checklist
- [ ] Rebrand: `package.json` name + description
- [ ] Rebrand `server.js` siteData (Ridgeline Foods / Finance OS), drop Orphil marketing copy
- [ ] Update `railway.json` / Procfile if needed
- [ ] Update `.env.example` with Finance OS vars
- [ ] `.gitignore` confirm `.env`, `node_modules`, `data/*.csv` policy
- [ ] `npm install` to restore deps locally

## Phase 1 — Data Layer (DATA plane, deterministic)
- [ ] Copy challenge CSVs into `data/` (shipments, 3 rate cards, invoices, denise baseline)
- [ ] Prisma models: `Shipment`, `RateCard` (versioned), `Invoice`, `DeniseBaseline`
- [ ] Prisma models: `AccrualRun`, `AccrualLine`, `Exception`, `LedgerEvent`, `Reconciliation`, `ImprovementProposal`
- [ ] Migration + `prisma generate`
- [ ] Ingestion service: parse CSVs → normalized rows
- [ ] Data-quality / contract checks (the messy-data gauntlet):
  - [ ] Dedup SHP-10033
  - [ ] Normalize 6 carrier-name variants
  - [ ] Flag 5 missing weights → estimate from historical avg by carrier+lane
  - [ ] Peak missing mileage (Pueblo, Laramie, Casper, Reno, SLC-origin) → estimate + flag
  - [ ] Reno = out-of-territory flag
  - [ ] Heartland ZIP-prefix → zone mapping (not state)
  - [ ] Service-level normalization (STD/Ground/Express → canonical)
- [ ] Seed script: load all data + parsed rate cards on first boot

## Phase 2 — Rate Engines (EXECUTION, deterministic [D])
- [ ] Peak: per-mile × weight tier + 14% fuel + $185 min + accessorials
- [ ] Heartland: ZIP→zone flat rate + QTD cumulative tier discount + accessorials (no discount on accessorials)
- [ ] Coastal: per-lb × region + $28 min + 9.5% fuel (base only) + tiered residential + accessorials
- [ ] Each returns full line-item breakdown (auditable)
- [ ] `calculate_accrual` aggregator across all carriers
- [ ] Unit-check against a few historical invoices for sanity

## Phase 3 — Estimation & Confidence (EXECUTION, agentic [A])
- [ ] Historical variance analysis per carrier (from 6mo invoices)
- [ ] Accessorial uplift model (what % of shipments get accessorials beyond logged special_handling)
- [ ] Confidence interval per carrier (point + range + %)
- [ ] Materiality × Confidence gate → auto-post vs escalate

## Phase 4 — Event Ledger & Controls (CONTROLS [D])
- [ ] Append-only `LedgerEvent` writer (every action + decision)
- [ ] JE-to-shipment traceability (drill from number → shipment → rate-card line)
- [ ] Validation checks: min-charge, tier progression, missing-data alerts, anomaly flags
- [ ] Exception queue model + surfacing

## Phase 5 — Mission Control UI (CONTROL plane, SSR, futuristic-pro)
- [ ] Re-skin theme: light, executive, futuristic (CSS variables, no hardcoded colors)
- [ ] Dashboard: total accrual by carrier, confidence bands, vs Denise
- [ ] Carrier drill-down: every shipment, line-item calc, flags
- [ ] Exception queue view (assumptions made)
- [ ] Comparison view: estimate vs Denise vs actual (historical)
- [ ] Journal Entry preview (debits/credits, account codes)
- [ ] Charts via vanilla lib (Chart.js)
- [ ] Keep existing chat + widget (overseer agent) + admin

## Phase 6 — Accrual MCP Tools (STACK)
- [ ] `calculate_shipment_cost`, `calculate_accrual`
- [ ] `analyze_historical_variance`, `estimate_accessorial_uplift`, `calculate_confidence_interval`
- [ ] `reconcile_actuals`, `generate_journal_entry`
- [ ] Register as bundled capability; overseer agent can call them

## Phase 7 — Reconciliation & Improvement (LEARN plane)
- [ ] `reconcile_actuals`: match invoices→estimate when they arrive
- [ ] Variance analysis + true-up JE if over materiality
- [ ] Improvement loop: SCORE → DIAGNOSE → PROPOSE → GOVERN → APPLY (versioned)
- [ ] `ImprovementProposal` review surface in UI

## Phase 8 — Deploy
- [ ] `git init`, first commit
- [ ] Create GitHub repo `agenticledger/ridgeline-finance-os`, push
- [ ] Railway: create project + Postgres(pgvector) service via Backboard API (project token)
- [ ] Set env vars (DATABASE_URL, ADMIN_PASSWORD, ENCRYPTION_KEY, LLM keys)
- [ ] `prisma migrate deploy` on Railway
- [ ] Smoke test: dashboard loads, accrual computes, chat works
- [ ] Rotate the pasted GitHub PAT + Railway token

## Phase 9 — Submission
- [ ] Seed demo state (April accrual computed)
- [ ] Record 3-5 min Loom
- [ ] Email build + Loom to nigel@numeric.io
