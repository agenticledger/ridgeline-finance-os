# Agent Config: RAG, MCPs, Admin Access & Document Upload — Design

**Date:** 2026-06-13
**Status:** Approved (Option A; Text+PDF uploads; items 1–5 now, #6 fast-follow)

## Problem

The agent platform's RAG and MCP engines are fully built and wired into chat, but
unusable in practice:

- **Admin is unreachable** — `/admin` exists (password-gated) but is not linked in
  any header, so the user cannot reach the LLM-config / MCP / KB tabs.
- **No per-agent toggles** — `contextBuilder.js` gates RAG on `features.ragEnabled`
  and memory on `features.memoryEnabled`, but no UI sets these, so they are always
  off. Documents get stored but never retrieved.
- **Embeddings have no key** — only an `anthropic` key is stored; RAG embeddings
  require an OpenAI key. OpenAI is already a provider in `routes/llmConfig.js`, so
  the key just needs to be pasted in Admin → LLM Config.
- **"Capabilities" is opaque** — the agent tab only toggles platform capabilities;
  MCP server creation lives (fully built) on Admin → MCP Servers, undiscoverable.
- **"Add document" can't attach files** — the modal is name + paste-text only.
- **Registry ↔ Agents mismatch** — Tools Registry lists `tool` rows where
  `type='agent'` (catalog entries, no link to the real `Agent` table); the Agents
  tab lists real `Agent` rows. They drift. (Deferred to #6.)

## Scope (items 1–5)

1. **Admin link in header.** Add an `Admin` link to `views/partials/topbar.ejs`
   pointing to `/admin`. No backend change (already password-gated).

2. **Embeddings key clarity.** In Admin LLM Config, label the OpenAI key row to
   note it powers embeddings (RAG). No backend change.

3. **Per-agent RAG + Memory toggles.** On the agent detail page:
   - Knowledge tab: a **RAG enabled** toggle.
   - Memory tab: a **Memory enabled** toggle.
   Each reads `GET /api/agents/:id` features, flips `ragEnabled` / `memoryEnabled`,
   and `PATCH`es the merged `features` object. `contextBuilder.js` already consumes
   these flags — no backend change.

4. **Capabilities → MCPs.** Rename the agent tab `Capabilities` → **MCPs**; list
   registered MCP servers (capabilities with a `serverUrl`) with a per-agent
   on/off toggle (existing `agentCapability` PUT/DELETE). Empty state links to
   Admin → MCPs. Relabel the admin tab to **MCPs**. Model = Option A: register once
   in Admin, toggle per agent.

5. **Document file upload.** Add a file picker to the Add-document modal (agent
   Knowledge tab + admin KB tab):
   - `.txt/.md/.csv/.json/.html` → read in-browser (FileReader), fill content.
   - `.pdf` → POST multipart to a new `POST /api/agents/:id/documents/upload`
     that parses with `pdf-parse`, then ingests via the existing RAG pipeline.
   - Paste-text remains a fallback.
   - New deps: `pdf-parse`, `multer`.

## Out of scope (deferred to #6, fast-follow spec)

Registry ↔ Agents reconciliation. Making the registry's "Agents" come from the real
`Agent` table touches `Tool(type=agent)` rows that are wired into process/step
plumbing (`ProcessTool`/`StepTool`) and needs a migration. Separate spec.

## Affected files

- `views/partials/topbar.ejs` — Admin link.
- `views/agents.ejs` — toggles, MCPs tab rename, file picker in doc modal.
- `views/admin.ejs` + `public/js/admin.js` — MCPs label, file picker, embeddings caption.
- `routes/agentDocuments.js` — new `/upload` multipart endpoint (pdf-parse).
- `package.json` — `pdf-parse`, `multer`.
- `docs/catalog.js` — document the new upload route (REST/MCP count parity rule).

## Testing / verification

- Restart `PORT=3070 node --watch server.js`; all pages 200.
- Header shows Admin on every page; `/admin` reachable.
- Toggle RAG on an agent → `features.ragEnabled` persists (DB check).
- MCPs tab renders registered servers + toggles; empty state links to Admin.
- Upload a `.txt` and a `.pdf` → document row + chunks created (needs OpenAI key).
- Browser screenshots via op_devbrowser.
