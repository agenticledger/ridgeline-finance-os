// Overview slot-schema builder. The Overview/Monitor tab is now a single template
// (views/fos/overview.ejs) made of named slots — hero, tiles, action items, a
// table, a journal entry, and decision notes. Every process fills the SAME slots:
//
//   1. If the engine emitted its own `summary.overview` (the standard schema),
//      we pass it straight through — the agent slotted its own data in.
//   2. Else, if the run is freight-shaped (carries `summary.carriers`), we map the
//      rich freight summary onto the schema (the original bespoke dashboard).
//   3. Else, any scaffold run is mapped from its persisted step outcomes.
//
// The schema is presentation-semantic, not pre-formatted: values stay raw and each
// tile/column carries a `format`/`type` tag the template applies. This keeps the
// money/percent formatting in one place (the template) and lets new engines emit
// the same shape without importing view helpers.
//
// SCHEMA — the page is three bands. The STATUS band is fixed slots; everything
// after it is role-based: `analysis` (the working), `result` (the deliverable the
// process hands off), `details` (optional appendix/provenance). Each role holds an
// ordered list of typed BLOCKS, so a table can live in any band — the engine decides.
//
//   hero     { state, label, title, context, meta:[{label,value}],
//              figure:{ label, value, format, sub, delta:{text,tone}|null } }
//   tiles    [ { label, value, format, note } ]
//   actions  { sub, items:[ { severity, title, detail, amount, amountFormat } ] }
//   insight  { text, generatedAt, model, promptSlug } | null   (attached in buildOverview)
//   analysis [ block ]        — always rendered if non-empty
//   result   [ block ]        — always rendered; empty array shows an honest empty state
//   details  [ block ]        — optional appendix; renders nothing when empty
//
// Block kinds:
//   { kind:'table', title, sub, columns:[{key,label,type}], rows:[…] }
//   { kind:'journal', title, status, date, lines:[{account,subledger,debit,credit}], total }
//   { kind:'notes', title, sub, items:[{color,label,body}] }
//   { kind:'keyvalue', title, sub, items:[{label,value,format,note}] }
//   { kind:'links', title, items:[{label,href,ghost}] }
//
// Column types: entity (label + `_sub`), money0, money0strong, money2, signed,
//   num, num3, pct, chip ({label,cls}), code, strong, text, band (uses row
//   low/high/point/denise).  Value formats: money0, money2, signed, pct, num, text.

const fmt0 = (n) => (n == null ? '--' : '$' + Math.round(n).toLocaleString('en-US'));
const signed = (n) => (n == null ? '--' : (n >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US'));
const pct = (n) => (n == null ? '--' : (n * 100).toFixed(1) + '%');

const DEC_LABEL = { auto_post: 'Auto-post', review: 'Review', escalate: 'Escalate' };
const ST_LABEL = { posted: 'Complete', awaiting_human: 'Awaiting sign-off', needs_review: 'Needs review', reconciled: 'Reconciled', draft: 'Draft', processing: 'Running' };
const ST_CLASS = { posted: 'good', awaiting_human: 'attention', needs_review: 'attention', reconciled: 'posted', draft: 'pending', processing: 'pending' };

function heroFreight(status) {
  if (status === 'awaiting_human') return { state: 'attention', label: 'Awaiting your sign-off', title: 'Three carriers escalated. Review and sign to post the journal entry.' };
  if (status === 'needs_review') return { state: 'attention', label: 'Needs review', title: 'One or more carriers flagged for review before posting.' };
  if (status === 'posted') return { state: 'posted', label: 'Posted to the ledger', title: 'The accrual journal entry is posted.' };
  return { state: 'good', label: 'Auto-posted', title: 'This month\u2019s freight accrual is booked.' };
}

// 1 — Freight: map the rich summary onto the standard slots (faithful to the
// original bespoke dashboard, now expressed as data the template renders).
function freightOverview({ proc, run, sm }) {
  const carriers = sm.carriers || [];
  const ctrl = sm.control || {};
  const disp = ctrl.dispositions || {};
  const queue = ctrl.overseerQueue || [];
  const st = run.status;
  const h = heroFreight(st);
  const halfBand = (sm.high - sm.low) / 2;

  return {
    hero: {
      state: h.state, label: h.label, title: h.title, context: proc.description,
      meta: [
        { label: 'Period', value: sm.period },
        { label: 'Mode', value: run.mode },
        { label: 'Shipments', value: (run.lines || []).length },
      ],
      figure: {
        label: 'Booked accrual', value: sm.point, format: 'money0',
        sub: `90% band ${fmt0(sm.low)} \u2013 ${fmt0(sm.high)}`,
        delta: sm.vsDenise != null
          ? { text: `${signed(sm.vsDenise)} vs Denise\u2019s trailing-average (${fmt0(sm.denise)})`, tone: 'win' }
          : null,
      },
    },
    tiles: [
      { label: 'Contract baseline [D]', value: sm.contractual, format: 'money0', note: 'Pure rate-card math, every lane' },
      { label: 'Realization adj. [A]', value: sm.point - sm.contractual, format: 'signed', note: 'Learned factor + ensemble blend' },
      { label: 'Confidence band', value: `\u00b1${fmt0(halfBand)}`, format: 'text', note: `${pct(sm.point ? halfBand / sm.point : null)} of booked, 90% level` },
      { label: 'Gate dispositions', value: `${disp.escalate || 0}/${carriers.length}`, format: 'text', note: `escalate \u00b7 ${disp.auto_post || 0} auto-post` },
    ],
    actions: {
      sub: `${queue.length} awaiting the overseer`,
      items: queue.map((q) => ({ severity: q.severity, title: q.label, detail: q.detail, amount: q.dollar, amountFormat: 'money0' })),
    },
    // ANALYSIS — the working that justifies the number.
    analysis: [
      {
        kind: 'table',
        title: 'Outcomes by carrier', sub: 'point estimate, 90% band, gate decision',
        columns: [
          { key: 'label', label: 'Carrier', type: 'entity' },
          { key: 'contractual', label: 'Contract [D]', type: 'money0' },
          { key: 'factor', label: 'Factor', type: 'num3' },
          { key: 'point', label: 'Booked', type: 'money0strong' },
          { key: 'band', label: '90% band \u00b7 Denise', type: 'band' },
          { key: 'cv', label: 'CV', type: 'pct' },
          { key: 'decision', label: 'Gate', type: 'chip' },
          { key: 'vsDenise', label: 'vs Denise', type: 'signed' },
        ],
        rows: carriers.map((c) => ({
          label: c.label, _sub: c.region, contractual: c.contractual, factor: c.factor,
          point: c.point, low: c.low, high: c.high, denise: c.denise, cv: c.cv,
          decision: { label: DEC_LABEL[c.decision] || c.decision, cls: c.decision }, vsDenise: c.vsDenise,
        })),
      },
    ],
    // RESULT — the artifact this run hands off (the posted/staged journal entry).
    result: sm.je ? [
      {
        kind: 'journal', title: 'Journal entry',
        status: st === 'posted' ? 'posted' : 'staged', date: sm.je.date,
        lines: sm.je.lines || [], total: sm.je.total,
      },
    ] : [],
    // OTHER DETAILS — appendix / provenance.
    details: [
      {
        kind: 'keyvalue', title: 'Run provenance', sub: 'how this estimate was produced',
        items: [
          { label: 'Period', value: sm.period, format: 'text' },
          { label: 'Shipments priced', value: (run.lines || []).length, format: 'text' },
          { label: 'Confidence level', value: '90%', format: 'text' },
          { label: 'Estimation', value: 'inverse-variance ensemble + mix-shift', format: 'text' },
        ],
      },
    ],
  };
}

// 3 — Scaffold: map any generic run from its persisted step outcomes.
function scaffoldOverview({ proc, run, sm }) {
  const steps = (run.steps || []).slice().sort((a, b) => a.order - b.order);
  const done = steps.filter((s) => s.status === 'done').length;
  const engineBound = steps.filter((s) => s.processing && s.processing.engineSource && s.processing.engineSource !== 'scaffold').length;
  const st = run.status;

  return {
    hero: {
      state: ST_CLASS[st] || 'good', label: ST_LABEL[st] || st, title: `${proc.name} ran end to end.`,
      context: proc.description || 'This process runs on the generic Finance OS runner. Each step executes as a scaffold and is fully audited.',
      meta: [
        { label: 'Period', value: run.period },
        { label: 'Mode', value: run.mode },
        { label: 'Steps', value: `${done}/${steps.length}` },
      ],
      figure: {
        label: 'Steps complete', value: `${done}/${steps.length}`, format: 'text',
        sub: `generic scaffold run \u00b7 v${(sm && sm.processVersion) || 1}`, delta: null,
      },
    },
    tiles: [
      { label: 'Steps complete', value: `${done}/${steps.length}`, format: 'text', note: 'every step persisted + audited' },
      { label: 'Engine-bound steps', value: `${engineBound}/${steps.length}`, format: 'text', note: engineBound ? 'deterministic engines bound' : 'running on the generic scaffold' },
      { label: 'Package version', value: `v${(sm && sm.processVersion) || 1}`, format: 'text', note: 'snapshotted on every change' },
    ],
    actions: { sub: 'nothing awaiting you', items: [] },
    // ANALYSIS — the working: each step's persisted outcome.
    analysis: [
      {
        kind: 'table',
        title: 'Step outcomes', sub: 'each step\u2019s persisted result',
        columns: [
          { key: 'order', label: '#', type: 'num' },
          { key: 'name', label: 'Step', type: 'strong' },
          { key: 'decision', label: 'Decision', type: 'chip' },
          { key: 'engine', label: 'Engine', type: 'code' },
          { key: 'status', label: 'Status', type: 'chip' },
          { key: 'outcome', label: 'Outcome', type: 'text' },
        ],
        rows: steps.map((s) => {
          const o = s.outcome || {};
          return {
            order: s.order, name: s.name,
            decision: { label: (s.decisionType || '').replace(/_/g, ' '), cls: s.decisionType },
            engine: (s.processing && s.processing.engineSource) || 'scaffold',
            status: { label: s.status.replace(/_/g, ' '), cls: s.status === 'done' ? 'posted' : (s.status === 'awaiting_human' ? 'awaiting_human' : 'pending') },
            outcome: o.headline || '\u2014',
          };
        }),
      },
    ],
    // RESULT — a generic scaffold run posts no artifact; honest empty state.
    result: [],
    // OTHER DETAILS — drill-in links.
    details: [
      {
        kind: 'links', title: 'Drill in',
        items: [
          { label: 'View the flow \u2192', href: `/process/${proc.slug}/flow?run=${run.id}`, ghost: false },
          { label: 'Execute view', href: `/process/${proc.slug}/execute?run=${run.id}`, ghost: true },
        ],
      },
    ],
  };
}

// Build the actions slot from PERSISTED action items (first-class rows). Each item
// is individually actionable: it must be cleared (approved or marked N/A) before
// the run can be signed off. Falls back to whatever the branch produced when a run
// predates the action-item model (no rows persisted).
function actionsSlot(run, fallback) {
  const items = run.actionItems || [];
  if (!items.length) return fallback || { sub: 'nothing awaiting you', items: [], open: 0 };
  const open = items.filter((i) => i.status === 'open').length;
  const sub = open > 0
    ? `${open} of ${items.length} still need to be cleared`
    : `all ${items.length} cleared \u2014 ready to sign off`;
  return {
    sub, open, total: items.length,
    items: items.map((i) => ({
      id: i.id, severity: i.severity, title: i.title, detail: i.detail,
      amount: i.amount, amountFormat: 'money0',
      status: i.status, note: i.note, clearedBy: i.clearedBy,
    })),
  };
}

// Entry point. Returns the standard overview schema for a run, or null. The
// cached AI insight (if any) rides along on `ov.insight` for every branch.
function buildOverview({ proc, run, summary }) {
  if (!run) return null;
  const sm = summary || {};
  const ov = sm.overview                          // engine emitted its own slots
    || (sm.carriers ? freightOverview({ proc, run, sm }) : scaffoldOverview({ proc, run, sm }));
  ov.actions = actionsSlot(run, ov.actions);
  ov.insight = sm.aiInsight || null;
  return ov;
}

module.exports = { buildOverview };
