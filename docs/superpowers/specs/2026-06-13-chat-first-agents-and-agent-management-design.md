# Chat-first `/agents` + Admin "Agent Management"

Date: 2026-06-13
Status: Approved (design)

## Problem

Three overlapping places manage/expose agents, which confuses the mental model:

- `/agents` — a rich per-agent config editor (Profile / Knowledge / Memory / MCPs) plus an "Open chat" button that opens chat in a **new window** (`target="_blank"`).
- Admin -> **Agents** tab — a thinner agent CRUD (name/desc/instructions/model via a modal).
- Admin -> **Knowledge Base** tab — a separate place to manage an agent's documents.

The user wants one place to *chat* and one place to *configure*.

## Goals

1. `/agents` becomes the **chat** interface (open, no password), with an in-chat agent dropdown switcher (scales as agents grow). Already supported: `chat.ejs` has `#agentSelect` and `chat.js` honors `?agent=`.
2. The rich per-agent editor moves into Admin as a new **"Agent Management"** tab. The old Admin "Agents" and "Knowledge Base" tabs are deleted (their function is absorbed by the relocated editor — single source of truth).
3. "Open chat" opens in the **same window**, pointing at `/agents?agent=<slug>`.

Non-goals: no backend/data-model changes. All endpoints already exist and are admin-gated.

## Approach (chosen: relocate existing editor wholesale)

The `/agents` editor is a self-contained IIFE styled entirely with `fos.css` (which `admin.ejs` now also loads). Move it into the Admin shell with minimal rewrite rather than rebuilding inside `admin.js`.

## Changes

### Routing
- `routes/financeOs.js` `/agents` -> render `chat` (open, no gate), passing `org`, `pageTitle`, `pageDescription`. Keep `?agent=` passthrough (client reads it).
- `server.js` `/chat` -> `res.redirect('/agents' + (req.query.agent ? '?agent='+encodeURIComponent(req.query.agent) : ''))` so old links still work and there is one canonical chat URL.

### Chat view (`views/chat.ejs`)
- Replace the bespoke topbar block with the shared `partials/topbar` (`active: 'agents'`, `org`) so chat matches the rest of the app (Processes / Tools Registry / Agents / Admin / Docs / theme).

### New partial `views/partials/agentManager.ejs`
- Contains the editor **console + modal** markup (NO login gate — Admin already gates).
- Contains the editor `<script>` IIFE, modified:
  - `token` reads `sessionStorage.getItem('orphil_admin_key')` (Admin's store), fallback `localStorage.getItem('rl-admin-token')`.
  - Remove gate/login logic (`authGate`, `authForm`, `signOut`/`signedIn` DOM toggling); on 401, surface the error (no separate gate to show).
  - Expose `window.AgentManager = { open: function(){ token = <read>; loadAgents(); } }`.
  - "Open chat" link -> `/agents?agent=<slug>` with **no** `target="_blank"`.
  - "+ Register MCP server (Admin)" -> switch to the MCPs tab in place: `document.querySelector('.admin-tab[data-tab="mcp"]').click()` (no new window).

### Admin view (`views/admin.ejs`)
- Tab bar: replace `Agents` + `Knowledge Base` buttons with a single `Agent Management` button (`data-tab="agentmgmt"`). Final tabs: **Agent Management · MCPs · LLM Config · Settings**.
- Replace `#tab-agents` panel content with `<%- include('partials/agentManager') %>` inside `<div class="tab-panel active" id="tab-agentmgmt">`.
- Delete the `#tab-kb` panel.
- Delete the now-unused `#agentModal` and `#docModal` (the partial brings its own modal).

### Admin script (`public/js/admin.js`)
- `showDashboard()`: replace `loadAgents(); loadKbAgents();` with `if (window.AgentManager) window.AgentManager.open();`.
- Tab click handler: add `if (tab.dataset.tab === 'agentmgmt' && window.AgentManager) window.AgentManager.open();`.
- Remove the **Agents** section (loadAgents, populateAgentModelSelect, agent-modal save, `_adminEditAgent`, `_adminDeleteAgent`).
- Remove the **Knowledge Base** section (loadKbAgents, loadDocuments, doc add/upload handlers, `_adminDeleteDoc`, `pendingPdfFile`).
- Keep MCP Servers, LLM Config, Settings, Utilities untouched.

## Docs sync
- No REST/MCP route changes -> `docs/catalog.js` / `mcp/toolCatalog.js` untouched; 33/33 parity holds.
- CSS: no `fos.css` edits expected. If any CSS changes, bump `?v=` across views.

## Verification
- `/agents` renders chat, dropdown lists agents, `?agent=slug` preselects, no password prompt.
- `/chat?agent=x` redirects to `/agents?agent=x`.
- Admin shows only Agent Management / MCPs / LLM Config / Settings; Agent Management lists agents, opens the per-agent editor (Profile/Knowledge/Memory/MCPs), toggles + upload work, "Open chat" opens same-window to `/agents?agent=`.
- No console errors from removed-element references.
</content>
