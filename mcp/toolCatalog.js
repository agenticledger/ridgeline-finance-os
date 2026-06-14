// Documentation mirror of the MCP tools registered in mcp/server.js.
//
// views/docs/mcp.ejs renders this to produce the MCP docs page (/docs/mcp).
// Keep it in lockstep with mcp/server.js: when you add, remove, or change a tool
// there, update the matching entry here. /opappbuild_agentready_trueup checks for
// drift between the two.
//
// The surface is process-agnostic: every tool is a generic VERB that operates on
// ANY process by slug. There are no process-specific tools. Runs default to the
// freight accrual process (slug "freight-accrual") so the demo works without a
// slug, but the surface itself is not freight-specific.
//
// Tool shape:
//   { name, group, title, description, sideEffect: 'none'|'writes',
//     mapsTo: 'GET /api/fos/...' | 'in-process engine (no REST equivalent)',
//     args: [{ name, type, required, default, desc }] }

const TOOL_GROUPS = [
  {
    name: 'Runs (system of record, DB-backed)',
    blurb: 'Create and advance persisted runs \u2014 the system of record \u2014 for any process. These mirror the Finance OS REST run endpoints. The materiality gate sits before the JE post: a run pauses at awaiting_human with the JE staged until a human signs off.',
    tools: [
      {
        name: 'run_execute', group: 'runs', title: 'Execute and persist a process run', sideEffect: 'writes',
        mapsTo: 'POST /api/fos/run',
        description: 'Execute the full stepped process and persist it as the system-of-record run. For the freight accrual process this ingests, prices, calibrates, baselines, estimates, raises exceptions, applies the materiality gate, stages the JE, and reconciles. Pauses at awaiting_human if any line escalates. Returns the runId and gate disposition.',
        args: [
          { name: 'period', type: 'string', required: false, default: 'April 2026', desc: 'Run period.' },
          { name: 'mode', type: 'enum(manual|auto)', required: false, default: 'manual', desc: 'manual = overseer-triggered, auto = scheduled.' },
          { name: 'actor', type: 'string', required: false, default: 'MCP Agent', desc: 'Who triggered the run (event ledger).' },
        ],
      },
      {
        name: 'run_list', group: 'runs', title: 'List runs', sideEffect: 'none',
        mapsTo: 'GET /api/fos/runs',
        description: 'List all persisted runs for a process (newest first) with status, period, total, and frozen flag.',
        args: [
          { name: 'slug', type: 'string', required: false, default: 'freight-accrual', desc: 'Process slug.' },
        ],
      },
      {
        name: 'run_get', group: 'runs', title: 'Get a run', sideEffect: 'none',
        mapsTo: 'GET /api/fos/run/:id',
        description: 'Fetch one persisted run in full: summary, per-line outcomes, step executions, exceptions, the event ledger, and the journal entry. Omit runId to get the latest.',
        args: [
          { name: 'runId', type: 'string', required: false, default: null, desc: 'Run id (uuid). Omit for the latest.' },
        ],
      },
      {
        name: 'run_sign_off', group: 'runs', title: 'Sign off and post the JE', sideEffect: 'writes',
        mapsTo: 'POST /api/fos/run/:id/signoff',
        description: 'Human-in-the-loop approval. Advances a run that is awaiting_human or needs_review: posts the staged balanced journal entry and records the sign-off on the event ledger.',
        args: [
          { name: 'runId', type: 'string', required: true, default: null, desc: 'Run id to sign off.' },
          { name: 'actor', type: 'string', required: false, default: 'Controller', desc: 'Approver name.' },
          { name: 'note', type: 'string', required: false, default: '', desc: 'Optional sign-off note.' },
        ],
      },
      {
        name: 'run_freeze', group: 'runs', title: 'Freeze a run for close', sideEffect: 'writes',
        mapsTo: 'POST /api/fos/run/:id/freeze',
        description: 'Lock a posted run immutable for period close. After freezing it cannot be modified; a new run must be created to revise.',
        args: [
          { name: 'runId', type: 'string', required: true, default: null, desc: 'Run id to freeze.' },
          { name: 'actor', type: 'string', required: false, default: 'Controller', desc: 'Who is freezing.' },
        ],
      },
      {
        name: 'run_reconcile', group: 'runs', title: 'Reconcile a run against actuals', sideEffect: 'writes',
        mapsTo: 'POST /api/fos/run/:id/reconcile',
        description: 'Post-close reconciliation: compare a posted/frozen run\u2019s booked number to the real actuals, writing immutable per-line Reconciliation rows and a variance. If the portfolio variance breaches materiality, a true-up JE is staged. Actuals are resolved from the period\u2019s invoiced truth unless supplied.',
        args: [
          { name: 'runId', type: 'string', required: true, default: null, desc: 'The run to reconcile (must be posted or frozen).' },
          { name: 'actuals', type: 'object', required: false, default: null, desc: 'Optional actuals by line key, e.g. { "peak": 34216.86 }. Omit to use the period truth.' },
          { name: 'actor', type: 'string', required: false, default: 'Reconciliation Agent', desc: 'Who is reconciling (event ledger).' },
        ],
      },
    ],
  },
  {
    name: 'Improve (the closed loop, DB-backed)',
    blurb: 'The self-review half of the loop. Generate param-targeted proposals from a run\u2019s evidence, apply one, and read the version-audit history. Applying writes a new policy version plus an immutable ObjectVersion audit row, and affects future runs only (runs pin the version they used).',
    tools: [
      {
        name: 'improve_propose', group: 'improve', title: 'Generate improvement proposals', sideEffect: 'writes',
        mapsTo: 'POST /api/fos/proposals/generate',
        description: 'Run the self-review and persist concrete, param-targeted improvement proposals (e.g. widen band z, lower mix-shift z, extend baseline window). Each applyable proposal names the exact policy param it would change. Returns the proposals and band-coverage evidence.',
        args: [
          { name: 'slug', type: 'string', required: false, default: 'freight-accrual', desc: 'Process slug.' },
          { name: 'runId', type: 'string', required: false, default: null, desc: 'Run id to attach the proposals to.' },
        ],
      },
      {
        name: 'improve_apply', group: 'improve', title: 'Apply an improvement proposal', sideEffect: 'writes',
        mapsTo: 'POST /api/fos/proposals/:id/apply',
        description: 'Approve and apply a param-targeted proposal: tunes the policy param, bumps the policy version, and writes an immutable ObjectVersion (before to after). Affects FUTURE runs only. Advisory (methodology) proposals cannot be auto-applied.',
        args: [
          { name: 'proposalId', type: 'string', required: true, default: null, desc: 'Proposal id to apply.' },
          { name: 'approvedBy', type: 'string', required: false, default: 'Controller', desc: 'Who approved the change.' },
        ],
      },
      {
        name: 'improve_list_versions', group: 'improve', title: 'List policy version history', sideEffect: 'none',
        mapsTo: 'GET /api/fos/versions',
        description: 'Return the ObjectVersion audit trail for the process\u2019s policies, every Improve action that changed a param, with before to after diffs and who approved it.',
        args: [
          { name: 'slug', type: 'string', required: false, default: 'freight-accrual', desc: 'Process slug.' },
        ],
      },
    ],
  },
  {
    name: 'Process configuration (construct-a-process)',
    blurb: 'Define ANY process end to end \u2014 definition, steps, policies (incl. the versioned params the Improve loop tunes), and tool bindings \u2014 the exact mutations a human makes on the Setup page. These back the process automator and share services/accrual/configService.js with the REST API and UI forms, so the surface never drifts.',
    tools: [
      {
        name: 'process_list', group: 'config', title: 'List processes', sideEffect: 'none',
        mapsTo: 'GET /api/fos/processes',
        description: 'List every active process with org, function, latest run status, and counts. Discover slugs before configuring.',
        args: [],
      },
      {
        name: 'process_get_config', group: 'config', title: 'Get a process configuration', sideEffect: 'none',
        mapsTo: 'GET /api/fos/process/:slug/config',
        description: 'Read a process\u2019s full configuration: definition, ordered steps, policies, tool bindings, improve trigger. Read before editing to get current step/policy ids.',
        args: [
          { name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' },
        ],
      },
      {
        name: 'process_get_policies', group: 'config', title: 'Get versioned policies', sideEffect: 'none',
        mapsTo: 'GET /api/fos/policies',
        description: 'Return the versioned policy objects that parameterize a process (e.g. materiality gate, baseline window, estimation method, calibration method, JE accounts, improve trigger) with their params and versions. These params are what the Improve loop tunes; the algorithms stay in code.',
        args: [
          { name: 'slug', type: 'string', required: false, default: 'freight-accrual', desc: 'Process slug.' },
        ],
      },
      {
        name: 'process_set_policy', group: 'config', title: 'Tune a policy param (new version)', sideEffect: 'writes',
        mapsTo: 'in-process (writes a new policy version + ObjectVersion audit row)',
        description: 'Update one or more params on a versioned policy by its stable key, bumping its version and writing an immutable audit row. Affects FUTURE runs only. Use to act on a reconciliation proposal, e.g. tighten the materiality threshold. (To edit a policy by uuid without the audit row, use process_update_policy.)',
        args: [
          { name: 'key', type: 'string', required: true, default: null, desc: 'Policy key, e.g. "materiality_gate".' },
          { name: 'params', type: 'object', required: true, default: null, desc: 'Param fields to merge, e.g. { "materialityThreshold": 1200 }.' },
          { name: 'slug', type: 'string', required: false, default: 'freight-accrual', desc: 'Process slug.' },
          { name: 'approvedBy', type: 'string', required: false, default: 'Controller', desc: 'Who approved the change.' },
        ],
      },
      {
        name: 'process_list_tools', group: 'config', title: 'List the tool registry', sideEffect: 'none',
        mapsTo: 'GET /api/fos/tools',
        description: 'List the global tool registry (automations, skills, agents, prompts, MCP servers). Returns tool ids needed for process_map_tool.',
        args: [],
      },
      {
        name: 'process_create', group: 'config', title: 'Create a process', sideEffect: 'writes',
        mapsTo: 'POST /api/fos/process',
        description: 'Create a new process from a blank starter or by cloning the freight blueprint. Returns the new slug.',
        args: [
          { name: 'name', type: 'string', required: true, default: null, desc: 'Process name.' },
          { name: 'functionSlug', type: 'string', required: false, default: null, desc: 'Sub-function slug, e.g. "gl-close".' },
          { name: 'frequency', type: 'string', required: false, default: 'monthly', desc: 'Cadence.' },
          { name: 'mode', type: 'enum(auto|adhoc|manual)', required: false, default: 'manual', desc: 'Run mode.' },
          { name: 'description', type: 'string', required: false, default: null, desc: 'Optional description.' },
          { name: 'template', type: 'enum(blank|clone)', required: false, default: 'blank', desc: 'Blank starter or clone freight shape.' },
        ],
      },
      {
        name: 'process_update_definition', group: 'config', title: 'Update process definition', sideEffect: 'writes',
        mapsTo: 'PATCH /api/fos/process/:slug',
        description: 'Update name, description, cadence, run mode, or sub-function. Any subset of fields.',
        args: [
          { name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' },
          { name: 'name', type: 'string', required: false, default: null, desc: 'New name.' },
          { name: 'description', type: 'string', required: false, default: null, desc: 'New description.' },
          { name: 'frequency', type: 'string', required: false, default: null, desc: 'New cadence.' },
          { name: 'mode', type: 'enum(auto|adhoc|manual)', required: false, default: null, desc: 'Run mode.' },
          { name: 'functionSlug', type: 'string', required: false, default: null, desc: 'Re-home to a sub-function (empty clears).' },
        ],
      },
      {
        name: 'process_set_improve_trigger', group: 'config', title: 'Set the improvement trigger', sideEffect: 'writes',
        mapsTo: 'PUT /api/fos/process/:slug/improve',
        description: 'Configure the improvement loop: auto vs manual, and how many prior runs it ingests.',
        args: [
          { name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' },
          { name: 'mode', type: 'enum(auto|manual)', required: false, default: null, desc: 'Trigger mode.' },
          { name: 'lookbackRuns', type: 'integer', required: false, default: null, desc: 'Prior runs to ingest (min 1).' },
        ],
      },
      {
        name: 'process_add_step', group: 'config', title: 'Add a step', sideEffect: 'writes',
        mapsTo: 'POST /api/fos/process/:slug/steps',
        description: 'Append a step to the process checklist. Returns the updated config with the new step id.',
        args: [
          { name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' },
          { name: 'name', type: 'string', required: true, default: null, desc: 'Step name.' },
          { name: 'description', type: 'string', required: false, default: null, desc: 'What the step does.' },
          { name: 'decisionType', type: 'enum(policy_based|judgment_based|mixed)', required: false, default: 'policy_based', desc: 'Decision type.' },
          { name: 'engineSource', type: 'string', required: false, default: null, desc: 'Engine/service file, if bound.' },
          { name: 'toolId', type: 'string', required: false, default: null, desc: 'Tool to bind to the step.' },
          { name: 'isGate', type: 'boolean', required: false, default: false, desc: 'Is this a materiality gate?' },
          { name: 'pauseAfter', type: 'boolean', required: false, default: false, desc: 'Pause for a human after this step?' },
        ],
      },
      {
        name: 'process_update_step', group: 'config', title: 'Update a step', sideEffect: 'writes',
        mapsTo: 'PATCH /api/fos/process/:slug/steps/:stepId',
        description: 'Edit a step (any subset of fields). Bumps the step version.',
        args: [
          { name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' },
          { name: 'stepId', type: 'string', required: true, default: null, desc: 'Step id (uuid).' },
          { name: 'name', type: 'string', required: false, default: null, desc: 'New name.' },
          { name: 'description', type: 'string', required: false, default: null, desc: 'New description.' },
          { name: 'decisionType', type: 'enum(policy_based|judgment_based|mixed)', required: false, default: null, desc: 'Decision type.' },
          { name: 'engineSource', type: 'string', required: false, default: null, desc: 'Engine/service file.' },
          { name: 'toolId', type: 'string', required: false, default: null, desc: 'Bound tool id (null clears).' },
          { name: 'isGate', type: 'boolean', required: false, default: null, desc: 'Gate flag.' },
          { name: 'pauseAfter', type: 'boolean', required: false, default: null, desc: 'Pause-for-human flag.' },
        ],
      },
      {
        name: 'process_delete_step', group: 'config', title: 'Delete a step', sideEffect: 'writes',
        mapsTo: 'DELETE /api/fos/process/:slug/steps/:stepId',
        description: 'Remove a step from the process.',
        args: [
          { name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' },
          { name: 'stepId', type: 'string', required: true, default: null, desc: 'Step id (uuid).' },
        ],
      },
      {
        name: 'process_add_policy', group: 'config', title: 'Add a policy', sideEffect: 'writes',
        mapsTo: 'POST /api/fos/process/:slug/policies',
        description: 'Add a policy. params is a free-form typed object the engine reads (thresholds, accounts, windows).',
        args: [
          { name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' },
          { name: 'name', type: 'string', required: true, default: null, desc: 'Policy name.' },
          { name: 'definition', type: 'string', required: false, default: null, desc: 'Human-readable description.' },
          { name: 'params', type: 'object', required: false, default: null, desc: 'Typed key/value params.' },
          { name: 'scope', type: 'enum(process|step)', required: false, default: 'process', desc: 'Policy scope.' },
        ],
      },
      {
        name: 'process_update_policy', group: 'config', title: 'Update a policy', sideEffect: 'writes',
        mapsTo: 'PATCH /api/fos/process/:slug/policies/:policyId',
        description: 'Edit a policy\u2019s definition and/or params by its uuid. Bumps the policy version. (To tune a param by its stable key and record an Improve ObjectVersion audit, use process_set_policy.)',
        args: [
          { name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' },
          { name: 'policyId', type: 'string', required: true, default: null, desc: 'Policy id (uuid).' },
          { name: 'definition', type: 'string', required: false, default: null, desc: 'New description.' },
          { name: 'params', type: 'object', required: false, default: null, desc: 'Replacement typed params object.' },
        ],
      },
      {
        name: 'process_delete_policy', group: 'config', title: 'Delete a policy', sideEffect: 'writes',
        mapsTo: 'DELETE /api/fos/process/:slug/policies/:policyId',
        description: 'Remove a policy from the process.',
        args: [
          { name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' },
          { name: 'policyId', type: 'string', required: true, default: null, desc: 'Policy id (uuid).' },
        ],
      },
      {
        name: 'process_map_tool', group: 'config', title: 'Bind a tool to a process', sideEffect: 'writes',
        mapsTo: 'POST /api/fos/process/:slug/tools',
        description: 'Map a registry tool to the process (idempotent). Use process_list_tools for ids.',
        args: [
          { name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' },
          { name: 'toolId', type: 'string', required: true, default: null, desc: 'Tool id from the registry.' },
          { name: 'role', type: 'string', required: false, default: null, desc: 'Optional role label.' },
        ],
      },
      {
        name: 'process_unmap_tool', group: 'config', title: 'Unbind a tool from a process', sideEffect: 'writes',
        mapsTo: 'DELETE /api/fos/process/:slug/tools/:toolId',
        description: 'Remove a tool binding from the process.',
        args: [
          { name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' },
          { name: 'toolId', type: 'string', required: true, default: null, desc: 'Tool id (uuid).' },
        ],
      },
      {
        name: 'process_attach_step_tool', group: 'config', title: 'Attach a tool to a step', sideEffect: 'writes',
        mapsTo: 'POST /api/fos/process/:slug/steps/:stepId/tools',
        description: 'Attach a library tool to a single step. Use process_get_config for step ids and process_list_tools for tool ids. Mirrored into the process tool map so the registry stays accurate.',
        args: [
          { name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' },
          { name: 'stepId', type: 'string', required: true, default: null, desc: 'Step id (uuid).' },
          { name: 'toolId', type: 'string', required: true, default: null, desc: 'Tool id from the registry.' },
          { name: 'role', type: 'string', required: false, default: null, desc: 'Optional role label, e.g. "engine" for the primary automation.' },
        ],
      },
      {
        name: 'process_detach_step_tool', group: 'config', title: 'Detach a tool from a step', sideEffect: 'writes',
        mapsTo: 'DELETE /api/fos/process/:slug/steps/:stepId/tools/:stepToolId',
        description: 'Detach a tool from a step by its StepTool join id (from process_get_config). The process-level tool map entry is removed only if no other step still uses that tool.',
        args: [
          { name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' },
          { name: 'stepId', type: 'string', required: true, default: null, desc: 'Step id (uuid).' },
          { name: 'stepToolId', type: 'string', required: true, default: null, desc: 'StepTool join id (uuid).' },
        ],
      },
    ],
  },
  {
    name: 'Supervision (Process Owner Agent)',
    blurb: 'Every process is owned by exactly one Process Owner Agent — a supervisor that observes live run state, explains it, and can trigger or sign off steps on a human\u2019s instruction. It is NOT in the critical path; the deterministic engine still does the math. The supervise tick is deterministic and idempotent-by-period, so an external cron can drive proactive supervision: auto-run a period when due and nudge a run stuck awaiting a human.',
    tools: [
      {
        name: 'process_get_owner_agent', group: 'supervision', title: 'Get a process owner agent', sideEffect: 'none',
        mapsTo: 'GET /api/fos/process/:slug/agent',
        description: 'Get the Process Owner Agent (supervisor) for a process: id, name, and supervisor features. Every process is owned by exactly one such agent.',
        args: [{ name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' }],
      },
      {
        name: 'process_provision_owner_agent', group: 'supervision', title: 'Provision a process owner agent', sideEffect: 'writes',
        mapsTo: 'POST /api/fos/process/:slug/agent/provision',
        description: '(Re)provision the owner agent for a process, regenerating its supervisor system prompt from the current definition. Idempotent by agent slug.',
        args: [{ name: 'slug', type: 'string', required: true, default: null, desc: 'Process slug.' }],
      },
      {
        name: 'process_supervise', group: 'supervision', title: 'Run a supervision tick', sideEffect: 'writes',
        mapsTo: 'POST /api/fos/supervisor/:slug/tick (or POST /api/fos/supervisor/tick when slug omitted)',
        description: 'Run one proactive supervision tick: auto-run the target period if due (mode=auto, engine-bound, no run yet) and nudge a run stuck awaiting a human (throttled). Deterministic and idempotent-by-period — safe on a cron. Omit slug to tick every active process.',
        args: [{ name: 'slug', type: 'string', required: false, default: null, desc: 'Process slug. Omit to tick all active processes.' }],
      },
    ],
  },
];

function toolCount() {
  return TOOL_GROUPS.reduce((n, g) => n + g.tools.length, 0);
}

module.exports = { TOOL_GROUPS, toolCount };
