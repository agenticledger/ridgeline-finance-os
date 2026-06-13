// SINGLE SOURCE OF TRUTH for the REST API surface.
//
// Every REST endpoint is declared once here, and views/docs/api.ejs renders it as
// the Swagger-like API docs page (/docs/api). To add an endpoint: wire the Express
// route, then add its entry here. The MCP tool surface is documented separately in
// mcp/toolCatalog.js (the MCP server is domain-shaped, not 1:1 with REST).
// Run /opappbuild_agentready_trueup to verify drift across all four inventories.
//
// Endpoint shape:
//   { op, method, path, summary, auth: 'none'|'admin',
//     params: [{ in:'path'|'query', name, type, required, desc }],
//     body:   [{ name, type, required, desc }],
//     returns: 'short description of the data payload' }
//
// `op` is the operationId — it becomes the MCP tool name and must be unique.

const API_GROUPS = [
  {
    name: 'Finance OS',
    base: '/api/fos',
    blurb: 'The agent-facing core. Drive the freight accrual process end to end: read the process spine, list and inspect runs, execute a new run, sign off (post the JE), and freeze the period. No auth — these are the surfaces an autonomous Improve/Execute agent calls.',
    endpoints: [
      {
        op: 'fos_health', method: 'GET', path: '/api/fos/health', auth: 'none',
        summary: 'Liveness probe for the Finance OS API.',
        params: [], body: [],
        returns: '{ status: "up", ts: ISO8601 }',
      },
      {
        op: 'fos_get_process', method: 'GET', path: '/api/fos/process/:slug', auth: 'none',
        summary: 'Fetch a process with its org, legal entity, ordered steps, policies, and mapped tools.',
        params: [{ in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug, e.g. "freight-accrual".' }],
        body: [],
        returns: 'Process object incl. steps[], policies[], tools[].',
      },
      {
        op: 'fos_list_runs', method: 'GET', path: '/api/fos/runs', auth: 'none',
        summary: 'List runs for a process, newest first.',
        params: [{ in: 'query', name: 'slug', type: 'string', required: false, desc: 'Process slug. Defaults to the freight accrual process.' }],
        body: [],
        returns: 'Array of run summaries.',
      },
      {
        op: 'fos_get_run', method: 'GET', path: '/api/fos/run/:id', auth: 'none',
        summary: 'Fetch one run with its full summary, step executions, and posted amounts.',
        params: [{ in: 'path', name: 'id', type: 'string', required: true, desc: 'Run id (uuid).' }],
        body: [],
        returns: 'Run object incl. summary and step executions.',
      },
      {
        op: 'fos_execute_run', method: 'POST', path: '/api/fos/run', auth: 'none',
        summary: 'Execute a new accrual run for a period. Runs the step chain and produces an estimate that gates at the human sign-off step.',
        params: [],
        body: [
          { name: 'period', type: 'string', required: false, desc: 'Accounting period, e.g. "April 2026".' },
          { name: 'mode', type: 'string', required: false, desc: 'Run mode: auto | adhoc | manual.' },
        ],
        returns: '{ runId, status, summary } for the new run.',
      },
      {
        op: 'fos_signoff_run', method: 'POST', path: '/api/fos/run/:id/signoff', auth: 'none',
        summary: 'Sign off an awaiting_human run: posts the journal entry and advances the run.',
        params: [{ in: 'path', name: 'id', type: 'string', required: true, desc: 'Run id (uuid).' }],
        body: [
          { name: 'actor', type: 'string', required: false, desc: 'Who is signing off. Defaults to "Controller".' },
          { name: 'note', type: 'string', required: false, desc: 'Optional sign-off note for the audit trail.' },
        ],
        returns: 'Updated run after posting.',
      },
      {
        op: 'fos_freeze_run', method: 'POST', path: '/api/fos/run/:id/freeze', auth: 'none',
        summary: 'Freeze a run (period close). Locks the run from further edits.',
        params: [{ in: 'path', name: 'id', type: 'string', required: true, desc: 'Run id (uuid).' }],
        body: [{ name: 'actor', type: 'string', required: false, desc: 'Who is freezing. Defaults to "Controller".' }],
        returns: 'Updated frozen run.',
      },
      {
        op: 'fos_list_policies', method: 'GET', path: '/api/fos/policies', auth: 'none',
        summary: 'List a process\u2019s versioned policies (the Improve agent\u2019s tuning target).',
        params: [{ in: 'query', name: 'slug', type: 'string', required: false, desc: 'Process slug. Defaults to the freight accrual process.' }],
        body: [],
        returns: 'Array of policy objects with params and version.',
      },
    ],
  },

  {
    name: 'Improve',
    base: '/api/fos',
    blurb: 'The closed loop. After invoices land, reconcile the booked accrual against actuals (writes immutable per-carrier variance rows and stages a true-up JE if the portfolio breaches materiality), then generate param-targeted improvement proposals and apply them. Applying a proposal mutates a versioned policy param and writes an immutable ObjectVersion audit row; changes take effect on future runs only, never retroactively.',
    endpoints: [
      {
        op: 'fos_reconcile_run', method: 'POST', path: '/api/fos/run/:id/reconcile', auth: 'none',
        summary: 'Reconcile a posted/frozen run against actual invoiced totals. Writes per-carrier variance rows and stages a true-up JE if portfolio variance exceeds materiality.',
        params: [{ in: 'path', name: 'id', type: 'string', required: true, desc: 'Run id (uuid).' }],
        body: [
          { name: 'actuals', type: 'object', required: false, desc: 'Per-carrier actual invoiced totals { peak, heartland, coastal }. If omitted, resolved from the denise baseline for the run period.' },
          { name: 'actor', type: 'string', required: false, desc: 'Who is reconciling. Defaults to "Controller".' },
        ],
        returns: '{ period, carriers[], estTotal, actTotal, totalVariance, withinMateriality, trueUp } reconciliation.',
      },
      {
        op: 'fos_get_reconciliation', method: 'GET', path: '/api/fos/run/:id/reconciliation', auth: 'none',
        summary: 'Read the reconciliation for a run (per-carrier booked vs actual variance and any staged true-up).',
        params: [{ in: 'path', name: 'id', type: 'string', required: true, desc: 'Run id (uuid).' }],
        body: [],
        returns: 'Reconciliation object or null if not yet reconciled.',
      },
      {
        op: 'fos_list_proposals', method: 'GET', path: '/api/fos/proposals', auth: 'none',
        summary: 'List improvement proposals for a process (optionally scoped to one run).',
        params: [
          { in: 'query', name: 'slug', type: 'string', required: false, desc: 'Process slug. Defaults to the freight accrual process.' },
          { in: 'query', name: 'run', type: 'string', required: false, desc: 'Filter to proposals generated for one run id.' },
        ],
        body: [],
        returns: 'Array of proposals { lever, component, diagnosis, proposal, target, riskLevel, status }.',
      },
      {
        op: 'fos_generate_proposals', method: 'POST', path: '/api/fos/proposals/generate', auth: 'none',
        summary: 'Run forward replay diagnostics and generate param-targeted improvement proposals (clears prior pending). Each applyable proposal names a specific policy param and its proposed value.',
        params: [],
        body: [
          { name: 'slug', type: 'string', required: false, desc: 'Process slug. Defaults to the freight accrual process.' },
          { name: 'run', type: 'string', required: false, desc: 'Run id to attach the proposals to.' },
        ],
        returns: 'Array of newly persisted proposals.',
      },
      {
        op: 'fos_apply_proposal', method: 'POST', path: '/api/fos/proposals/:id/apply', auth: 'none',
        summary: 'Approve and apply a proposal: bumps the targeted policy param to a new version and writes an immutable ObjectVersion audit row. Takes effect on future runs only.',
        params: [{ in: 'path', name: 'id', type: 'string', required: true, desc: 'Proposal id (uuid).' }],
        body: [{ name: 'approvedBy', type: 'string', required: false, desc: 'Who approved the change. Defaults to "Controller".' }],
        returns: '{ proposal, version } after applying.',
      },
      {
        op: 'fos_list_versions', method: 'GET', path: '/api/fos/versions', auth: 'none',
        summary: 'List the immutable ObjectVersion audit trail for a process\u2019s policies (every Improve change, before to after).',
        params: [{ in: 'query', name: 'slug', type: 'string', required: false, desc: 'Process slug. Defaults to the freight accrual process.' }],
        body: [],
        returns: 'Array of ObjectVersion rows { policyName, diff, version, source, approvedBy, approvedAt }.',
      },
    ],
  },

  {
    name: 'Process Owner Agent & Supervision',
    base: '/api/fos',
    blurb: 'Every process is owned by exactly one Process Owner Agent — a supervisor that observes live run state, explains it, and can trigger or sign off steps on a human\u2019s instruction. It is NOT in the critical path: the deterministic engine still does the math. A scheduler (or an external cron) drives proactive supervision: auto-run a period when due and nudge a run that has been stuck awaiting a human. Owner agents are auto-provisioned when a process is created and can be (re)provisioned or backfilled here.',
    endpoints: [
      {
        op: 'fos_get_process_agent', method: 'GET', path: '/api/fos/process/:slug/agent', auth: 'none',
        summary: 'Get the Process Owner Agent for a process (so the UI can open a chat with it).',
        params: [{ in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' }],
        body: [],
        returns: 'Owner agent { id, name, slug, description, defaultModel, features } or null if none provisioned.',
      },
      {
        op: 'fos_provision_process_agent', method: 'POST', path: '/api/fos/process/:slug/agent/provision', auth: 'none',
        summary: '(Re)provision a process\u2019s owner agent, regenerating its supervisor system prompt from the current process definition. Idempotent by agent slug.',
        params: [{ in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' }],
        body: [],
        returns: 'The provisioned owner agent { id, slug, name }.',
      },
      {
        op: 'fos_backfill_agents', method: 'POST', path: '/api/fos/agents/backfill', auth: 'none',
        summary: 'Provision or refresh owner agents across all processes (used on boot). With refresh:true, regenerates every agent\u2019s prompt.',
        params: [],
        body: [{ name: 'refresh', type: 'boolean', required: false, desc: 'If true, regenerate the system prompt for existing agents too.' }],
        returns: 'Summary of provisioned/refreshed agents.',
      },
      {
        op: 'fos_supervisor_tick', method: 'POST', path: '/api/fos/supervisor/:slug/tick', auth: 'none',
        summary: 'Run one proactive supervision tick for a process: auto-run the target period if due (mode=auto, engine-bound, no run yet) and nudge a run stuck awaiting a human (throttled). Deterministic and idempotent-by-period.',
        params: [{ in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' }],
        body: [],
        returns: '{ slug, actions[], latest } describing what the tick did.',
      },
      {
        op: 'fos_supervisor_tick_all', method: 'POST', path: '/api/fos/supervisor/tick', auth: 'none',
        summary: 'Run a supervision tick for every active process (the scheduler entry point, also callable by an external cron).',
        params: [], body: [],
        returns: 'Array of per-process tick results.',
      },
    ],
  },

  {
    name: 'Process Configuration',
    base: '/api/fos',
    blurb: 'The construct-a-process surface. Everything a human can do on the Setup page is here as JSON, so an agent (or the process automator) can define a process end to end: create it, edit its definition, add/edit/remove steps and policies, bind tools, and set the improvement trigger. Backed by services/accrual/configService.js — the exact code path the UI forms use.',
    endpoints: [
      {
        op: 'fos_list_processes', method: 'GET', path: '/api/fos/processes', auth: 'none',
        summary: 'List every active process with its org, function, latest run status, and counts.',
        params: [], body: [],
        returns: 'Array of process summaries (slug, name, function, signal, runCount, stepCount, runnable).',
      },
      {
        op: 'fos_list_tools', method: 'GET', path: '/api/fos/tools', auth: 'none',
        summary: 'List the global tool registry (skills, agents, prompts, integrations) a process can bind.',
        params: [], body: [],
        returns: 'Array of tools { id, slug, name, type, description }.',
      },
      {
        op: 'fos_list_subfunctions', method: 'GET', path: '/api/fos/subfunctions', auth: 'none',
        summary: 'List the canonical finance sub-functions a process can be homed to.',
        params: [], body: [],
        returns: 'Array of { slug, name }.',
      },
      {
        op: 'fos_get_process_config', method: 'GET', path: '/api/fos/process/:slug/config', auth: 'none',
        summary: 'Read a process\u2019s full configuration: definition, ordered steps, policies, tool bindings, and improve trigger.',
        params: [{ in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' }],
        body: [],
        returns: 'Config object { name, description, frequency, mode, improveTrigger, steps[], policies[], tools[] }.',
      },
      {
        op: 'fos_create_process', method: 'POST', path: '/api/fos/process', auth: 'none',
        summary: 'Create a new process from a blank starter or by cloning the freight blueprint.',
        params: [],
        body: [
          { name: 'name', type: 'string', required: true, desc: 'Process name.' },
          { name: 'functionSlug', type: 'string', required: false, desc: 'Sub-function to home it to (see /subfunctions).' },
          { name: 'frequency', type: 'string', required: false, desc: 'Cadence, e.g. "monthly". Default monthly.' },
          { name: 'mode', type: 'string', required: false, desc: 'Run mode: auto | adhoc | manual. Default manual.' },
          { name: 'description', type: 'string', required: false, desc: 'Optional description.' },
          { name: 'template', type: 'string', required: false, desc: '"blank" (neutral starter) or "clone" (copy freight steps/policies/tools). Default blank.' },
        ],
        returns: '{ id, slug, name } of the new process.',
      },
      {
        op: 'fos_update_definition', method: 'PATCH', path: '/api/fos/process/:slug', auth: 'none',
        summary: 'Update the process definition (name, description, frequency, mode, sub-function).',
        params: [{ in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' }],
        body: [
          { name: 'name', type: 'string', required: false, desc: 'New name.' },
          { name: 'description', type: 'string', required: false, desc: 'New description.' },
          { name: 'frequency', type: 'string', required: false, desc: 'New cadence.' },
          { name: 'mode', type: 'string', required: false, desc: 'auto | adhoc | manual.' },
          { name: 'functionSlug', type: 'string', required: false, desc: 'Re-home to a sub-function (empty string to clear).' },
        ],
        returns: 'Updated full config.',
      },
      {
        op: 'fos_set_improve_trigger', method: 'PUT', path: '/api/fos/process/:slug/improve', auth: 'none',
        summary: 'Configure the improvement loop trigger (auto vs manual, how many prior runs it ingests).',
        params: [{ in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' }],
        body: [
          { name: 'mode', type: 'string', required: false, desc: 'auto | manual.' },
          { name: 'lookbackRuns', type: 'integer', required: false, desc: 'How many prior runs to ingest. Min 1.' },
        ],
        returns: 'Updated full config.',
      },
      {
        op: 'fos_add_step', method: 'POST', path: '/api/fos/process/:slug/steps', auth: 'none',
        summary: 'Append a step to the process checklist.',
        params: [{ in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' }],
        body: [
          { name: 'name', type: 'string', required: true, desc: 'Step name.' },
          { name: 'description', type: 'string', required: false, desc: 'What the step does.' },
          { name: 'decisionType', type: 'string', required: false, desc: 'policy_based | judgment_based | mixed. Default policy_based.' },
          { name: 'engineSource', type: 'string', required: false, desc: 'Engine/service file that runs this step, if bound.' },
          { name: 'toolId', type: 'string', required: false, desc: 'Tool to bind to the step (see /tools).' },
          { name: 'isGate', type: 'boolean', required: false, desc: 'Is this a materiality gate?' },
          { name: 'pauseAfter', type: 'boolean', required: false, desc: 'Pause the run for a human after this step?' },
        ],
        returns: 'Updated full config.',
      },
      {
        op: 'fos_update_step', method: 'PATCH', path: '/api/fos/process/:slug/steps/:stepId', auth: 'none',
        summary: 'Edit a step (any subset of fields). Bumps the step version.',
        params: [
          { in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' },
          { in: 'path', name: 'stepId', type: 'string', required: true, desc: 'Step id (uuid).' },
        ],
        body: [
          { name: 'name', type: 'string', required: false, desc: 'New name.' },
          { name: 'description', type: 'string', required: false, desc: 'New description.' },
          { name: 'decisionType', type: 'string', required: false, desc: 'policy_based | judgment_based | mixed.' },
          { name: 'engineSource', type: 'string', required: false, desc: 'Engine/service file.' },
          { name: 'toolId', type: 'string', required: false, desc: 'Bound tool id (null to clear).' },
          { name: 'isGate', type: 'boolean', required: false, desc: 'Gate flag.' },
          { name: 'pauseAfter', type: 'boolean', required: false, desc: 'Pause-for-human flag.' },
        ],
        returns: 'Updated full config.',
      },
      {
        op: 'fos_delete_step', method: 'DELETE', path: '/api/fos/process/:slug/steps/:stepId', auth: 'none',
        summary: 'Remove a step from the process.',
        params: [
          { in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' },
          { in: 'path', name: 'stepId', type: 'string', required: true, desc: 'Step id (uuid).' },
        ],
        body: [],
        returns: 'Updated full config.',
      },
      {
        op: 'fos_add_policy', method: 'POST', path: '/api/fos/process/:slug/policies', auth: 'none',
        summary: 'Add a policy to the process. Params are a free-form typed object the engine reads.',
        params: [{ in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' }],
        body: [
          { name: 'name', type: 'string', required: true, desc: 'Policy name.' },
          { name: 'definition', type: 'string', required: false, desc: 'Human-readable description of the policy.' },
          { name: 'params', type: 'object', required: false, desc: 'Typed key/value params (thresholds, accounts, etc).' },
          { name: 'scope', type: 'string', required: false, desc: 'process | step. Default process.' },
        ],
        returns: 'Updated full config.',
      },
      {
        op: 'fos_update_policy', method: 'PATCH', path: '/api/fos/process/:slug/policies/:policyId', auth: 'none',
        summary: 'Edit a policy\u2019s definition and/or params. Bumps the policy version.',
        params: [
          { in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' },
          { in: 'path', name: 'policyId', type: 'string', required: true, desc: 'Policy id (uuid).' },
        ],
        body: [
          { name: 'definition', type: 'string', required: false, desc: 'New description.' },
          { name: 'params', type: 'object', required: false, desc: 'Replacement typed params object.' },
        ],
        returns: 'Updated full config.',
      },
      {
        op: 'fos_delete_policy', method: 'DELETE', path: '/api/fos/process/:slug/policies/:policyId', auth: 'none',
        summary: 'Remove a policy from the process.',
        params: [
          { in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' },
          { in: 'path', name: 'policyId', type: 'string', required: true, desc: 'Policy id (uuid).' },
        ],
        body: [],
        returns: 'Updated full config.',
      },
      {
        op: 'fos_map_tool', method: 'POST', path: '/api/fos/process/:slug/tools', auth: 'none',
        summary: 'Bind a registry tool to the process (idempotent upsert).',
        params: [{ in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' }],
        body: [
          { name: 'toolId', type: 'string', required: true, desc: 'Tool id from the registry (see /tools).' },
          { name: 'role', type: 'string', required: false, desc: 'Optional role label for this binding.' },
        ],
        returns: 'Updated full config.',
      },
      {
        op: 'fos_unmap_tool', method: 'DELETE', path: '/api/fos/process/:slug/tools/:toolId', auth: 'none',
        summary: 'Unbind a tool from the process.',
        params: [
          { in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' },
          { in: 'path', name: 'toolId', type: 'string', required: true, desc: 'Tool id (uuid).' },
        ],
        body: [],
        returns: 'Updated full config.',
      },
      {
        op: 'fos_attach_step_tool', method: 'POST', path: '/api/fos/process/:slug/steps/:stepId/tools', auth: 'none',
        summary: 'Attach a library tool to a single step. Mirrors the binding into the process-level tool map so the registry stays accurate.',
        params: [
          { in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' },
          { in: 'path', name: 'stepId', type: 'string', required: true, desc: 'Step id (uuid).' },
        ],
        body: [
          { name: 'toolId', type: 'string', required: true, desc: 'Tool id from the registry (see /tools).' },
          { name: 'role', type: 'string', required: false, desc: 'Optional role label, e.g. "engine" for the primary automation.' },
        ],
        returns: 'Updated full config.',
      },
      {
        op: 'fos_detach_step_tool', method: 'DELETE', path: '/api/fos/process/:slug/steps/:stepId/tools/:stepToolId', auth: 'none',
        summary: 'Detach a tool from a step. The process-level tool map entry is removed only if no other step still uses that tool.',
        params: [
          { in: 'path', name: 'slug', type: 'string', required: true, desc: 'Process slug.' },
          { in: 'path', name: 'stepId', type: 'string', required: true, desc: 'Step id (uuid).' },
          { in: 'path', name: 'stepToolId', type: 'string', required: true, desc: 'StepTool join id (uuid).' },
        ],
        body: [],
        returns: 'Updated full config.',
      },
    ],
  },

  {
    name: 'Admin',
    base: '/api/admin',
    blurb: 'Authentication. Exchange the admin password for an HMAC session token, then send it as the X-Admin-Key header on every admin-scoped endpoint.',
    endpoints: [
      {
        op: 'admin_login', method: 'POST', path: '/api/admin/login', auth: 'none',
        summary: 'Exchange the admin password for a session token (sent as X-Admin-Key on admin routes).',
        params: [],
        body: [{ name: 'password', type: 'string', required: true, desc: 'Admin password.' }],
        returns: '{ token } \u2014 use as the X-Admin-Key header.',
      },
    ],
  },

  {
    name: 'Agents',
    base: '/api/agents',
    blurb: 'CRUD for the AI agents that run on the platform. List/read are public; create, update, and delete require the admin key.',
    endpoints: [
      {
        op: 'agents_list', method: 'GET', path: '/api/agents', auth: 'none',
        summary: 'List all active agents with KB document counts.',
        params: [], body: [],
        returns: 'Array of agent summaries.',
      },
      {
        op: 'agents_get', method: 'GET', path: '/api/agents/:id', auth: 'none',
        summary: 'Fetch one agent with instructions and counts.',
        params: [{ in: 'path', name: 'id', type: 'string', required: true, desc: 'Agent id.' }],
        body: [],
        returns: 'Agent object.',
      },
      {
        op: 'agents_create', method: 'POST', path: '/api/agents', auth: 'admin',
        summary: 'Create an agent. Slug is derived from the name.',
        params: [],
        body: [
          { name: 'name', type: 'string', required: true, desc: 'Display name (also slugified).' },
          { name: 'description', type: 'string', required: true, desc: 'Short description.' },
          { name: 'instructions', type: 'string', required: true, desc: 'System prompt / instructions.' },
          { name: 'defaultModel', type: 'string', required: false, desc: 'Model id override.' },
          { name: 'features', type: 'object', required: false, desc: 'Feature flags object.' },
        ],
        returns: 'Created agent.',
      },
      {
        op: 'agents_update', method: 'PATCH', path: '/api/agents/:id', auth: 'admin',
        summary: 'Update any subset of an agent\u2019s fields.',
        params: [{ in: 'path', name: 'id', type: 'string', required: true, desc: 'Agent id.' }],
        body: [
          { name: 'name', type: 'string', required: false, desc: 'Display name (re-slugified).' },
          { name: 'description', type: 'string', required: false, desc: 'Short description.' },
          { name: 'instructions', type: 'string', required: false, desc: 'System prompt.' },
          { name: 'defaultModel', type: 'string', required: false, desc: 'Model id override.' },
          { name: 'features', type: 'object', required: false, desc: 'Feature flags.' },
          { name: 'branding', type: 'object', required: false, desc: 'Branding object.' },
        ],
        returns: 'Updated agent.',
      },
      {
        op: 'agents_delete', method: 'DELETE', path: '/api/agents/:id', auth: 'admin',
        summary: 'Soft-delete an agent (sets isActive false).',
        params: [{ in: 'path', name: 'id', type: 'string', required: true, desc: 'Agent id.' }],
        body: [],
        returns: 'null.',
      },
    ],
  },

  {
    name: 'Chat',
    base: '/api/chat',
    blurb: 'Conversational interface to an agent: start a conversation, stream or send messages (with RAG + memory + tools), list and inspect conversations, archive them.',
    endpoints: [
      {
        op: 'chat_start', method: 'POST', path: '/api/chat/start', auth: 'none',
        summary: 'Start a conversation with an agent.',
        params: [],
        body: [{ name: 'agentId', type: 'string', required: true, desc: 'Agent to converse with.' }],
        returns: '{ conversationId, agent }.',
      },
      {
        op: 'chat_list_conversations', method: 'GET', path: '/api/chat/conversations', auth: 'none',
        summary: 'List active conversations, newest first.',
        params: [
          { in: 'query', name: 'agentId', type: 'string', required: false, desc: 'Filter by agent.' },
          { in: 'query', name: 'limit', type: 'integer', required: false, desc: 'Max rows (default 50).' },
        ],
        body: [],
        returns: 'Array of conversation summaries.',
      },
      {
        op: 'chat_get_conversation', method: 'GET', path: '/api/chat/:conversationId', auth: 'none',
        summary: 'Fetch a conversation with its full message history.',
        params: [{ in: 'path', name: 'conversationId', type: 'string', required: true, desc: 'Public conversation id.' }],
        body: [],
        returns: 'Conversation incl. messages[].',
      },
      {
        op: 'chat_stream', method: 'POST', path: '/api/chat/:conversationId/stream', auth: 'none',
        summary: 'Send a message and stream the reply over SSE (delta/tool/end events). Supports image attachments.',
        params: [{ in: 'path', name: 'conversationId', type: 'string', required: true, desc: 'Public conversation id.' }],
        body: [
          { name: 'content', type: 'string', required: true, desc: 'User message text.' },
          { name: 'images', type: 'array', required: false, desc: 'Attachments: [{ data, mimeType }].' },
        ],
        returns: 'text/event-stream (SSE).',
      },
      {
        op: 'chat_message', method: 'POST', path: '/api/chat/:conversationId/message', auth: 'none',
        summary: 'Send a message and get the full reply in one JSON response (non-streaming).',
        params: [{ in: 'path', name: 'conversationId', type: 'string', required: true, desc: 'Public conversation id.' }],
        body: [{ name: 'content', type: 'string', required: true, desc: 'User message text.' }],
        returns: '{ role, content, model }.',
      },
      {
        op: 'chat_delete', method: 'DELETE', path: '/api/chat/:conversationId', auth: 'none',
        summary: 'Archive a conversation (sets isActive false).',
        params: [{ in: 'path', name: 'conversationId', type: 'string', required: true, desc: 'Public conversation id.' }],
        body: [],
        returns: 'null.',
      },
    ],
  },

  {
    name: 'Agent Documents',
    base: '/api/agents',
    blurb: 'Per-agent knowledge base (RAG). Upload documents, list them, semantic-search them, and delete them. Admin only.',
    endpoints: [
      {
        op: 'agent_docs_list', method: 'GET', path: '/api/agents/:agentId/documents', auth: 'admin',
        summary: 'List an agent\u2019s knowledge-base documents with chunk counts.',
        params: [{ in: 'path', name: 'agentId', type: 'string', required: true, desc: 'Agent id.' }],
        body: [],
        returns: 'Array of KB documents.',
      },
      {
        op: 'agent_docs_create', method: 'POST', path: '/api/agents/:agentId/documents', auth: 'admin',
        summary: 'Add a document to an agent\u2019s KB; it is chunked and embedded if an OpenAI key is configured.',
        params: [{ in: 'path', name: 'agentId', type: 'string', required: true, desc: 'Agent id.' }],
        body: [
          { name: 'name', type: 'string', required: true, desc: 'Document name.' },
          { name: 'content', type: 'string', required: true, desc: 'Full text content.' },
          { name: 'sourceType', type: 'string', required: false, desc: 'Source type (default "text").' },
          { name: 'metadata', type: 'object', required: false, desc: 'Arbitrary metadata.' },
        ],
        returns: '{ id, name, sourceType, ingested }.',
      },
      {
        op: 'agent_docs_delete', method: 'DELETE', path: '/api/agents/:agentId/documents/:docId', auth: 'admin',
        summary: 'Delete a KB document and its chunks.',
        params: [
          { in: 'path', name: 'agentId', type: 'string', required: true, desc: 'Agent id.' },
          { in: 'path', name: 'docId', type: 'string', required: true, desc: 'Document id.' },
        ],
        body: [],
        returns: 'null.',
      },
      {
        op: 'agent_docs_search', method: 'GET', path: '/api/agents/:agentId/documents/search', auth: 'admin',
        summary: 'Semantic search across an agent\u2019s KB (requires an OpenAI key for embeddings).',
        params: [
          { in: 'path', name: 'agentId', type: 'string', required: true, desc: 'Agent id.' },
          { in: 'query', name: 'q', type: 'string', required: true, desc: 'Search query.' },
        ],
        body: [],
        returns: 'Ranked chunk matches.',
      },
    ],
  },

  {
    name: 'Agent Memory',
    base: '/api/agents',
    blurb: 'Per-agent structured memory documents keyed by docKey. List, read, upsert, and delete. Admin only.',
    endpoints: [
      {
        op: 'agent_memory_list', method: 'GET', path: '/api/agents/:agentId/memory', auth: 'admin',
        summary: 'List an agent\u2019s memory documents (with content previews).',
        params: [{ in: 'path', name: 'agentId', type: 'string', required: true, desc: 'Agent id.' }],
        body: [],
        returns: 'Array of memory docs.',
      },
      {
        op: 'agent_memory_get', method: 'GET', path: '/api/agents/:agentId/memory/:docKey', auth: 'admin',
        summary: 'Read one memory document in full.',
        params: [
          { in: 'path', name: 'agentId', type: 'string', required: true, desc: 'Agent id.' },
          { in: 'path', name: 'docKey', type: 'string', required: true, desc: 'Memory document key.' },
        ],
        body: [],
        returns: 'Memory document.',
      },
      {
        op: 'agent_memory_put', method: 'PUT', path: '/api/agents/:agentId/memory/:docKey', auth: 'admin',
        summary: 'Upsert a memory document by key.',
        params: [
          { in: 'path', name: 'agentId', type: 'string', required: true, desc: 'Agent id.' },
          { in: 'path', name: 'docKey', type: 'string', required: true, desc: 'Memory document key.' },
        ],
        body: [
          { name: 'content', type: 'string', required: true, desc: 'Document content.' },
          { name: 'docType', type: 'string', required: false, desc: 'Document type (default "memory").' },
        ],
        returns: 'Upserted memory document.',
      },
      {
        op: 'agent_memory_delete', method: 'DELETE', path: '/api/agents/:agentId/memory/:docKey', auth: 'admin',
        summary: 'Delete a memory document and its embeddings.',
        params: [
          { in: 'path', name: 'agentId', type: 'string', required: true, desc: 'Agent id.' },
          { in: 'path', name: 'docKey', type: 'string', required: true, desc: 'Memory document key.' },
        ],
        body: [],
        returns: 'null.',
      },
    ],
  },

  {
    name: 'Agent Capabilities',
    base: '/api/agents',
    blurb: 'Bind shared capabilities (e.g. external MCP servers) to a specific agent. Admin only.',
    endpoints: [
      {
        op: 'agent_caps_list', method: 'GET', path: '/api/agents/:agentId/capabilities', auth: 'admin',
        summary: 'List the capabilities bound to an agent.',
        params: [{ in: 'path', name: 'agentId', type: 'string', required: true, desc: 'Agent id.' }],
        body: [],
        returns: 'Array of bound capabilities.',
      },
      {
        op: 'agent_caps_put', method: 'PUT', path: '/api/agents/:agentId/capabilities/:capId', auth: 'admin',
        summary: 'Bind (or update the config of) a capability for an agent.',
        params: [
          { in: 'path', name: 'agentId', type: 'string', required: true, desc: 'Agent id.' },
          { in: 'path', name: 'capId', type: 'string', required: true, desc: 'Capability id.' },
        ],
        body: [{ name: 'config', type: 'object', required: false, desc: 'Per-binding config (e.g. bearerToken).' }],
        returns: 'The agent-capability binding.',
      },
      {
        op: 'agent_caps_delete', method: 'DELETE', path: '/api/agents/:agentId/capabilities/:capId', auth: 'admin',
        summary: 'Unbind a capability from an agent.',
        params: [
          { in: 'path', name: 'agentId', type: 'string', required: true, desc: 'Agent id.' },
          { in: 'path', name: 'capId', type: 'string', required: true, desc: 'Capability id.' },
        ],
        body: [],
        returns: 'null.',
      },
    ],
  },

  {
    name: 'Capabilities',
    base: '/api/capabilities',
    blurb: 'The shared capability library (external MCP servers and tools any agent can draw from). CRUD plus connectivity tests. Admin only.',
    endpoints: [
      {
        op: 'caps_list', method: 'GET', path: '/api/capabilities', auth: 'admin',
        summary: 'List active capabilities and which agents use them.',
        params: [], body: [],
        returns: 'Array of capabilities.',
      },
      {
        op: 'caps_create', method: 'POST', path: '/api/capabilities', auth: 'admin',
        summary: 'Create a capability (slug derived from name).',
        params: [],
        body: [
          { name: 'name', type: 'string', required: true, desc: 'Display name.' },
          { name: 'description', type: 'string', required: false, desc: 'Description.' },
          { name: 'type', type: 'string', required: false, desc: 'Type (default "external").' },
          { name: 'serverUrl', type: 'string', required: false, desc: 'MCP server URL.' },
          { name: 'config', type: 'object', required: false, desc: 'Config (e.g. bearerToken).' },
        ],
        returns: 'Created capability.',
      },
      {
        op: 'caps_update', method: 'PATCH', path: '/api/capabilities/:id', auth: 'admin',
        summary: 'Update a capability.',
        params: [{ in: 'path', name: 'id', type: 'string', required: true, desc: 'Capability id.' }],
        body: [
          { name: 'name', type: 'string', required: false, desc: 'Display name (re-slugified).' },
          { name: 'description', type: 'string', required: false, desc: 'Description.' },
          { name: 'serverUrl', type: 'string', required: false, desc: 'MCP server URL.' },
          { name: 'config', type: 'object', required: false, desc: 'Config.' },
          { name: 'isActive', type: 'boolean', required: false, desc: 'Active flag.' },
        ],
        returns: 'Updated capability.',
      },
      {
        op: 'caps_delete', method: 'DELETE', path: '/api/capabilities/:id', auth: 'admin',
        summary: 'Soft-delete a capability.',
        params: [{ in: 'path', name: 'id', type: 'string', required: true, desc: 'Capability id.' }],
        body: [],
        returns: 'null.',
      },
      {
        op: 'caps_test', method: 'POST', path: '/api/capabilities/:id/test', auth: 'admin',
        summary: 'Test connectivity to a saved capability\u2019s MCP server and list its tools.',
        params: [{ in: 'path', name: 'id', type: 'string', required: true, desc: 'Capability id.' }],
        body: [{ name: 'bearerToken', type: 'string', required: false, desc: 'Override bearer token for the test.' }],
        returns: '{ reachable, toolCount, tools[] }.',
      },
      {
        op: 'caps_test_url', method: 'POST', path: '/api/capabilities/test-url', auth: 'admin',
        summary: 'Test an unsaved MCP server URL and list its tools.',
        params: [],
        body: [
          { name: 'serverUrl', type: 'string', required: true, desc: 'MCP server URL to probe.' },
          { name: 'bearerToken', type: 'string', required: false, desc: 'Optional bearer token.' },
        ],
        returns: '{ reachable, toolCount, tools[] }.',
      },
    ],
  },

  {
    name: 'LLM Config',
    base: '/api/llm-config',
    blurb: 'Platform LLM provider/model selection and encrypted API-key storage. Admin only.',
    endpoints: [
      {
        op: 'llm_get_config', method: 'GET', path: '/api/llm-config', auth: 'admin',
        summary: 'Get the current provider, model, and whether a key is set.',
        params: [], body: [],
        returns: '{ provider, model, hasApiKey, keyPrefix }.',
      },
      {
        op: 'llm_list_providers', method: 'GET', path: '/api/llm-config/providers', auth: 'admin',
        summary: 'List supported providers, their models, and key status.',
        params: [], body: [],
        returns: 'Array of providers with models.',
      },
      {
        op: 'llm_set_config', method: 'PUT', path: '/api/llm-config', auth: 'admin',
        summary: 'Set the active provider and model.',
        params: [],
        body: [
          { name: 'provider', type: 'string', required: true, desc: 'openai | anthropic | google.' },
          { name: 'model', type: 'string', required: true, desc: 'Model id for the provider.' },
        ],
        returns: '{ provider, model }.',
      },
      {
        op: 'llm_set_api_key', method: 'PUT', path: '/api/llm-config/api-key', auth: 'admin',
        summary: 'Store (encrypted) an API key for a provider.',
        params: [],
        body: [
          { name: 'provider', type: 'string', required: true, desc: 'Provider id.' },
          { name: 'apiKey', type: 'string', required: true, desc: 'The secret key (stored encrypted).' },
        ],
        returns: '{ provider, keyPrefix }.',
      },
      {
        op: 'llm_delete_api_key', method: 'DELETE', path: '/api/llm-config/api-key/:provider', auth: 'admin',
        summary: 'Remove a stored API key for a provider.',
        params: [{ in: 'path', name: 'provider', type: 'string', required: true, desc: 'Provider id.' }],
        body: [],
        returns: 'null.',
      },
    ],
  },

  {
    name: 'Settings',
    base: '/api/settings',
    blurb: 'Encrypted platform secrets (Resend, Brave Search, etc.). Admin only.',
    endpoints: [
      {
        op: 'settings_list', method: 'GET', path: '/api/settings', auth: 'admin',
        summary: 'List known settings, their source (db/env), and configured status.',
        params: [], body: [],
        returns: 'Array of settings (no secret values).',
      },
      {
        op: 'settings_put', method: 'PUT', path: '/api/settings/:key', auth: 'admin',
        summary: 'Set (encrypt) a setting value by key.',
        params: [{ in: 'path', name: 'key', type: 'string', required: true, desc: 'Setting key, e.g. RESEND_API_KEY.' }],
        body: [{ name: 'value', type: 'string', required: true, desc: 'Secret value (stored encrypted).' }],
        returns: '{ key, keyPrefix, configured }.',
      },
      {
        op: 'settings_delete', method: 'DELETE', path: '/api/settings/:key', auth: 'admin',
        summary: 'Delete a stored setting.',
        params: [{ in: 'path', name: 'key', type: 'string', required: true, desc: 'Setting key.' }],
        body: [],
        returns: '{ key, deleted }.',
      },
    ],
  },

  {
    name: 'Process Automator',
    base: '/api/automator',
    blurb: 'The AI process builder. Describe a finance process (and attach source documents) and the model drafts a full blueprint: definition, steps, policies, tools, and improve trigger. Propose is conversational (ask, refine); apply persists the blueprint through the same configService the forms and config API use, so an AI-built process is identical to a hand-built one.',
    endpoints: [
      {
        op: 'automator_propose', method: 'POST', path: '/api/automator/propose', auth: 'none',
        summary: 'Draft or refine a process blueprint from a chat transcript. Returns clarifying questions (ready=false) or a sanitized blueprint (ready=true).',
        params: [],
        body: [
          { name: 'messages', type: 'array', required: true, desc: 'Running chat as [{ role: "user"|"assistant", content }].' },
          { name: 'scope', type: 'string', required: false, desc: 'whole | definition | steps | policies | tools. Default whole.' },
          { name: 'attachments', type: 'array', required: false, desc: 'Source docs as [{ name, text }], folded into the latest user turn.' },
        ],
        returns: '{ ready, message, blueprint, scope } \u2014 blueprint is null until ready is true.',
      },
      {
        op: 'automator_apply', method: 'POST', path: '/api/automator/apply', auth: 'none',
        summary: 'Persist a blueprint. With no slug, creates a fresh process; with a slug, the sections present in the blueprint replace the existing ones on that process.',
        params: [],
        body: [
          { name: 'blueprint', type: 'object', required: true, desc: 'The blueprint to apply { definition, steps, policies, tools, improve }.' },
          { name: 'slug', type: 'string', required: false, desc: 'Target process slug. Omit to create a new process from definition.name.' },
        ],
        returns: '{ slug, created, config } \u2014 the full process config after applying.',
      },
    ],
  },
];

function endpointCount() {
  return API_GROUPS.reduce((n, g) => n + g.endpoints.length, 0);
}

module.exports = { API_GROUPS, endpointCount };
