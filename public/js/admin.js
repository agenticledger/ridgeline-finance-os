// ─── Orphil Admin Panel ──────────────────────────────────────────────
(function () {
  const API = '/api';
  let adminKey = null;
  let providers = [];

  const $loginScreen = document.getElementById('loginScreen');
  const $dashboard = document.getElementById('dashboardScreen');
  const $password = document.getElementById('adminPassword');
  const $loginError = document.getElementById('loginError');
  const $btnLogin = document.getElementById('btnLogin');

  // ─── Auth ──────────────────────────────────────────────────────────

  // Authenticated fetch — auto-logout on 401
  async function adminFetch(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
        'X-Admin-Key': adminKey,
      },
    });

    if (res.status === 401) {
      sessionStorage.removeItem('orphil_admin_key');
      adminKey = null;
      $dashboard.style.display = 'none';
      $loginScreen.style.display = 'block';
      $loginError.textContent = 'Session expired — please sign in again.';
      $loginError.style.display = 'block';
      const err = new Error('Unauthorized');
      err.isAuthError = true;
      throw err;
    }

    return res;
  }

  async function login() {
    const pw = $password.value.trim();
    if (!pw) return;

    $btnLogin.disabled = true;
    $loginError.style.display = 'none';

    try {
      const res = await fetch(`${API}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      const json = await res.json();

      if (json.ok) {
        adminKey = json.data.token;
        sessionStorage.setItem('orphil_admin_key', adminKey);
        showDashboard();
      } else {
        $loginError.textContent = json.error || 'Invalid password';
        $loginError.style.display = 'block';
      }
    } catch {
      $loginError.textContent = 'Connection error';
      $loginError.style.display = 'block';
    }

    $btnLogin.disabled = false;
  }

  function showDashboard() {
    $loginScreen.style.display = 'none';
    $dashboard.style.display = 'block';
    loadAgents();
    loadKbAgents();
    loadLlmConfig();
    loadSettings();
  }

  // Verify saved session before showing dashboard
  const savedKey = sessionStorage.getItem('orphil_admin_key');
  if (savedKey) {
    adminKey = savedKey;
    // Quick auth check — if 401 the adminFetch wrapper will force re-login
    adminFetch(`${API}/agents`)
      .then(res => res.json())
      .then(() => showDashboard())
      .catch(err => {
        if (!err.isAuthError) showDashboard(); // network error, show dashboard anyway
      });
  }

  $btnLogin.addEventListener('click', login);
  $password.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });

  // ─── Tabs ──────────────────────────────────────────────────────────
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');

      // Lazy-load MCP tab on first click
      if (tab.dataset.tab === 'mcp') loadMcpServers();
    });
  });

  // ─── Agents ────────────────────────────────────────────────────────
  const $agentList = document.getElementById('agentList');
  const $agentModal = document.getElementById('agentModal');

  async function loadAgents() {
    try {
      const res = await adminFetch(`${API}/agents`);
      const json = await res.json();

      if (!json.ok || json.data.length === 0) {
        $agentList.innerHTML = '<p class="empty-state">No agents yet. Create one to get started.</p>';
        return;
      }

      $agentList.innerHTML = json.data.map(a => `
        <div class="agent-card">
          <div class="agent-card-info">
            <h4>${escapeHtml(a.name)}</h4>
            <p>${escapeHtml(a.description)} &middot; ${a.kbDocumentCount || 0} docs</p>
          </div>
          <div class="agent-card-actions">
            <button class="btn-sm" onclick="window._adminEditAgent('${a.id}')">Edit</button>
            <button class="btn-sm danger" onclick="window._adminDeleteAgent('${a.id}', '${escapeHtml(a.name)}')">Delete</button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      if (err.isAuthError) return;
      $agentList.innerHTML = '<p class="empty-state">Failed to load agents</p>';
    }
  }

  // Populate the model <select> in the agent modal
  // If providers not yet loaded, fetch them first
  async function populateAgentModelSelect(currentValue) {
    if (providers.length === 0) {
      try {
        const res = await adminFetch(`${API}/llm-config/providers`);
        const json = await res.json();
        if (json.ok) providers = json.data;
      } catch {
        // silently fail — show empty dropdown
      }
    }

    const $sel = document.getElementById('agentModelInput');
    $sel.innerHTML = '<option value="">Use platform default</option>';
    providers.forEach(p => {
      const grp = document.createElement('optgroup');
      grp.label = p.name;
      p.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        grp.appendChild(opt);
      });
      $sel.appendChild(grp);
    });
    if (currentValue) $sel.value = currentValue;
  }

  document.getElementById('btnCreateAgent').addEventListener('click', async () => {
    document.getElementById('agentModalTitle').textContent = 'Create Agent';
    document.getElementById('agentEditId').value = '';
    document.getElementById('agentNameInput').value = '';
    document.getElementById('agentDescInput').value = '';
    document.getElementById('agentInstructionsInput').value = '';
    await populateAgentModelSelect('');
    $agentModal.classList.remove('hidden');
  });

  document.getElementById('btnCancelAgent').addEventListener('click', () => {
    $agentModal.classList.add('hidden');
  });

  document.getElementById('btnSaveAgent').addEventListener('click', async () => {
    const editId = document.getElementById('agentEditId').value;
    const payload = {
      name: document.getElementById('agentNameInput').value.trim(),
      description: document.getElementById('agentDescInput').value.trim(),
      instructions: document.getElementById('agentInstructionsInput').value.trim(),
      defaultModel: document.getElementById('agentModelInput').value.trim() || null,
    };

    if (!payload.name || !payload.description || !payload.instructions) {
      toast('Name, description, and instructions are required', 'error');
      return;
    }

    try {
      const url = editId ? `${API}/agents/${editId}` : `${API}/agents`;
      const method = editId ? 'PATCH' : 'POST';

      const res = await adminFetch(url, { method, body: JSON.stringify(payload) });
      const json = await res.json();

      if (json.ok) {
        $agentModal.classList.add('hidden');
        toast(editId ? 'Agent updated' : 'Agent created', 'success');
        loadAgents();
        loadKbAgents();
      } else {
        toast(json.error || 'Failed to save', 'error');
      }
    } catch (err) {
      if (!err.isAuthError) toast('Connection error', 'error');
    }
  });

  window._adminEditAgent = async function (id) {
    try {
      const res = await adminFetch(`${API}/agents/${id}`);
      const json = await res.json();
      if (!json.ok) return;

      const a = json.data;
      document.getElementById('agentModalTitle').textContent = 'Edit Agent';
      document.getElementById('agentEditId').value = id;
      document.getElementById('agentNameInput').value = a.name;
      document.getElementById('agentDescInput').value = a.description;
      document.getElementById('agentInstructionsInput').value = a.instructions;
      await populateAgentModelSelect(a.defaultModel || '');
      $agentModal.classList.remove('hidden');
    } catch (err) {
      if (!err.isAuthError) toast('Failed to load agent', 'error');
    }
  };

  window._adminDeleteAgent = async function (id, name) {
    if (!confirm(`Delete agent "${name}"? This cannot be undone.`)) return;

    try {
      const res = await adminFetch(`${API}/agents/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.ok) {
        toast('Agent deleted', 'success');
        loadAgents();
      } else {
        toast(json.error || 'Failed to delete', 'error');
      }
    } catch (err) {
      if (!err.isAuthError) toast('Connection error', 'error');
    }
  };

  // ─── Knowledge Base ────────────────────────────────────────────────
  const $kbAgentSelect = document.getElementById('kbAgentSelect');
  const $kbDocPanel = document.getElementById('kbDocPanel');
  const $docList = document.getElementById('docList');
  const $docModal = document.getElementById('docModal');
  let currentKbAgentId = null;

  async function loadKbAgents() {
    try {
      const res = await adminFetch(`${API}/agents`);
      const json = await res.json();
      if (json.ok && json.data.length > 0) {
        $kbAgentSelect.innerHTML = '<option value="">Select an agent to manage its documents...</option>' +
          json.data.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
      } else {
        $kbAgentSelect.innerHTML = '<option value="">No agents yet — create one in the Agents tab first</option>';
      }
    } catch {
      // silently fail
    }
  }

  $kbAgentSelect.addEventListener('change', () => {
    currentKbAgentId = $kbAgentSelect.value || null;
    if (currentKbAgentId) {
      $kbDocPanel.style.display = 'block';
      loadDocuments();
    } else {
      $kbDocPanel.style.display = 'none';
    }
  });

  async function loadDocuments() {
    if (!currentKbAgentId) return;
    $docList.innerHTML = '<p class="empty-state">Loading...</p>';
    try {
      const res = await adminFetch(`${API}/agents/${currentKbAgentId}/documents`);
      const json = await res.json();
      if (!json.ok || json.data.length === 0) {
        $docList.innerHTML = '<p class="empty-state">No documents yet. Click "+ Add Document" to give this agent knowledge.</p>';
        return;
      }
      $docList.innerHTML = json.data.map(d => `
        <div class="agent-card">
          <div class="agent-card-info">
            <h4>${escapeHtml(d.name)}</h4>
            <p>${escapeHtml(d.sourceType)} &middot; ${d.chunkCount || 0} chunks &middot; ${new Date(d.createdAt).toLocaleDateString()}</p>
          </div>
          <div class="agent-card-actions">
            <button class="btn-sm danger" onclick="window._adminDeleteDoc('${d.id}')">Delete</button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      if (!err.isAuthError) $docList.innerHTML = '<p class="empty-state">Failed to load documents</p>';
    }
  }

  document.getElementById('btnAddDoc').addEventListener('click', () => {
    document.getElementById('docNameInput').value = '';
    document.getElementById('docContentInput').value = '';
    $docModal.classList.remove('hidden');
  });

  document.getElementById('btnCancelDoc').addEventListener('click', () => {
    $docModal.classList.add('hidden');
  });

  document.getElementById('btnSaveDoc').addEventListener('click', async () => {
    const name = document.getElementById('docNameInput').value.trim();
    const content = document.getElementById('docContentInput').value.trim();

    if (!name || !content) {
      toast('Name and content are required', 'error');
      return;
    }

    const btn = document.getElementById('btnSaveDoc');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
      const res = await adminFetch(`${API}/agents/${currentKbAgentId}/documents`, {
        method: 'POST',
        body: JSON.stringify({ name, content, sourceType: 'text' }),
      });
      const json = await res.json();

      if (json.ok) {
        $docModal.classList.add('hidden');
        const msg = json.data.ingested ? 'Document saved & embedded' : 'Document saved (add OpenAI key to enable embeddings)';
        toast(msg, 'success');
        loadDocuments();
        loadAgents();
      } else {
        toast(json.error || 'Failed to save document', 'error');
      }
    } catch (err) {
      if (!err.isAuthError) toast('Connection error', 'error');
    }

    btn.disabled = false;
    btn.textContent = 'Save Document';
  });

  window._adminDeleteDoc = async function (id) {
    if (!confirm('Delete this document? This cannot be undone.')) return;
    try {
      const res = await adminFetch(`${API}/agents/${currentKbAgentId}/documents/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.ok) {
        toast('Document deleted', 'success');
        loadDocuments();
        loadAgents();
      } else {
        toast(json.error || 'Failed to delete', 'error');
      }
    } catch (err) {
      if (!err.isAuthError) toast('Connection error', 'error');
    }
  };

  // ─── MCP Servers ───────────────────────────────────────────────────
  const $mcpList = document.getElementById('mcpList');
  const $mcpModal = document.getElementById('mcpModal');
  let allAgentsCache = [];

  async function loadMcpServers() {
    $mcpList.innerHTML = '<p class="empty-state">Loading...</p>';
    try {
      const [capRes, agentRes] = await Promise.all([
        adminFetch(`${API}/capabilities`),
        adminFetch(`${API}/agents`),
      ]);
      const capJson = await capRes.json();
      const agentJson = await agentRes.json();

      allAgentsCache = agentJson.ok ? agentJson.data : [];

      if (!capJson.ok || capJson.data.length === 0) {
        $mcpList.innerHTML = '<p class="empty-state">No MCP servers yet. Add one to give agents access to external tools.</p>';
        return;
      }

      $mcpList.innerHTML = capJson.data.map(c => {
        const unconnected = allAgentsCache.filter(a => !c.agents.find(ca => ca.id === a.id));
        const connectedTags = c.agents.length > 0
          ? c.agents.map(a => `
              <span class="mcp-agent-tag">
                ${escapeHtml(a.name)}
                <button class="mcp-tag-remove" onclick="window._disconnectMcp('${c.id}','${a.id}')" title="Disconnect">&times;</button>
              </span>`).join('')
          : '<span style="font-size:12px;color:var(--text-tertiary)">No agents connected</span>';

        return `
          <div class="admin-card" id="mcp-card-${c.id}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
              <div style="min-width:0">
                <h4 style="margin:0 0 4px;font-size:15px;color:var(--text-primary)">${escapeHtml(c.name)}</h4>
                <code style="font-size:12px;color:var(--text-secondary);word-break:break-all">${escapeHtml(c.serverUrl || 'No URL set')}</code>
              </div>
              <div style="display:flex;gap:6px;flex-shrink:0">
                <button class="btn-sm" onclick="window._testMcp('${c.id}')">Test</button>
                <button class="btn-sm" onclick="window._editMcp('${c.id}')">Edit</button>
                <button class="btn-sm danger" onclick="window._deleteMcp('${c.id}','${escapeHtml(c.name)}')">Delete</button>
              </div>
            </div>

            <div id="mcp-test-${c.id}" style="display:none;margin-top:10px;padding:8px 12px;background:var(--bg-elevated);border-radius:var(--radius-sm);font-size:12px;line-height:1.6"></div>

            <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-subtle)">
              <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">Connected agents:</div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">${connectedTags}</div>
              ${unconnected.length > 0 ? `
                <div style="display:flex;gap:6px;align-items:center">
                  <select id="mcp-agent-sel-${c.id}" style="font-size:12px;padding:4px 8px;background:var(--bg-primary);border:1px solid var(--border-default);border-radius:var(--radius-sm);color:var(--text-primary)">
                    <option value="">Connect agent...</option>
                    ${unconnected.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}
                  </select>
                  <button class="btn-sm" onclick="window._connectMcp('${c.id}')">Connect</button>
                </div>
              ` : ''}
            </div>
          </div>`;
      }).join('');

    } catch (err) {
      if (!err.isAuthError) $mcpList.innerHTML = '<p class="empty-state">Failed to load MCP servers</p>';
    }
  }

  document.getElementById('btnAddMcp').addEventListener('click', () => {
    document.getElementById('mcpModalTitle').textContent = 'Add MCP Server';
    document.getElementById('mcpEditId').value = '';
    document.getElementById('mcpNameInput').value = '';
    document.getElementById('mcpUrlInput').value = '';
    document.getElementById('mcpTokenInput').value = '';
    document.getElementById('mcpTestResult').style.display = 'none';
    $mcpModal.classList.remove('hidden');
  });

  document.getElementById('btnCancelMcp').addEventListener('click', () => {
    $mcpModal.classList.add('hidden');
  });

  document.getElementById('btnTestMcpModal').addEventListener('click', async () => {
    const editId = document.getElementById('mcpEditId').value;
    const serverUrl = document.getElementById('mcpUrlInput').value.trim();
    const bearerToken = document.getElementById('mcpTokenInput').value.trim() || null;
    const $result = document.getElementById('mcpTestResult');

    if (!serverUrl) { toast('Enter a server URL first', 'error'); return; }

    $result.style.display = 'block';
    $result.innerHTML = 'Testing connection...';

    try {
      let res;
      if (editId) {
        res = await adminFetch(`${API}/capabilities/${editId}/test`, {
          method: 'POST',
          body: JSON.stringify({ bearerToken }),
        });
      } else {
        // For unsaved servers, test via a temp endpoint or direct fetch
        // Use a POST to a test-url helper
        res = await adminFetch(`${API}/capabilities/test-url`, {
          method: 'POST',
          body: JSON.stringify({ serverUrl, bearerToken }),
        });
      }
      const json = await res.json();

      if (json.ok && json.data.reachable) {
        const toolNames = (json.data.tools || []).map(t => `<li>${escapeHtml(t.name)}${t.description ? ` — ${escapeHtml(t.description.slice(0, 60))}` : ''}</li>`).join('');
        $result.innerHTML = `<strong style="color:#22c55e">Connected</strong> — ${json.data.toolCount} tool${json.data.toolCount !== 1 ? 's' : ''} available${toolNames ? `<ul style="margin:6px 0 0 16px;padding:0">${toolNames}</ul>` : ''}`;
      } else {
        $result.innerHTML = `<strong style="color:#ef4444">Failed</strong> — ${escapeHtml(json.data?.error || 'Could not connect')}`;
      }
    } catch (err) {
      if (!err.isAuthError) $result.innerHTML = `<strong style="color:#ef4444">Error</strong> — ${escapeHtml(err.message)}`;
    }
  });

  document.getElementById('btnSaveMcp').addEventListener('click', async () => {
    const editId = document.getElementById('mcpEditId').value;
    const name = document.getElementById('mcpNameInput').value.trim();
    const serverUrl = document.getElementById('mcpUrlInput').value.trim();
    const bearerToken = document.getElementById('mcpTokenInput').value.trim() || null;

    if (!name || !serverUrl) {
      toast('Name and server URL are required', 'error');
      return;
    }

    const payload = {
      name,
      serverUrl,
      type: 'external',
      config: bearerToken ? { bearerToken } : {},
    };

    try {
      const url = editId ? `${API}/capabilities/${editId}` : `${API}/capabilities`;
      const method = editId ? 'PATCH' : 'POST';
      const res = await adminFetch(url, { method, body: JSON.stringify(payload) });
      const json = await res.json();

      if (json.ok) {
        $mcpModal.classList.add('hidden');
        toast(editId ? 'Server updated' : 'Server added', 'success');
        loadMcpServers();
      } else {
        toast(json.error || 'Failed to save', 'error');
      }
    } catch (err) {
      if (!err.isAuthError) toast('Connection error', 'error');
    }
  });

  window._testMcp = async function (id) {
    const $result = document.getElementById(`mcp-test-${id}`);
    $result.style.display = 'block';
    $result.innerHTML = 'Testing...';

    try {
      const res = await adminFetch(`${API}/capabilities/${id}/test`, { method: 'POST' });
      const json = await res.json();

      if (json.ok && json.data.reachable) {
        const toolNames = (json.data.tools || []).map(t => `<li>${escapeHtml(t.name)}</li>`).join('');
        $result.innerHTML = `<strong style="color:#22c55e">Connected</strong> — ${json.data.toolCount} tools${toolNames ? `<ul style="margin:4px 0 0 16px;padding:0">${toolNames}</ul>` : ''}`;
      } else {
        $result.innerHTML = `<strong style="color:#ef4444">Failed</strong> — ${escapeHtml(json.data?.error || 'Could not connect')}`;
      }
    } catch (err) {
      if (!err.isAuthError) $result.innerHTML = `<strong style="color:#ef4444">Error</strong>`;
    }
  };

  window._editMcp = async function (id) {
    try {
      const res = await adminFetch(`${API}/capabilities`);
      const json = await res.json();
      const cap = json.data?.find(c => c.id === id);
      if (!cap) return;

      document.getElementById('mcpModalTitle').textContent = 'Edit MCP Server';
      document.getElementById('mcpEditId').value = id;
      document.getElementById('mcpNameInput').value = cap.name;
      document.getElementById('mcpUrlInput').value = cap.serverUrl || '';
      document.getElementById('mcpTokenInput').value = '';
      document.getElementById('mcpTestResult').style.display = 'none';
      $mcpModal.classList.remove('hidden');
    } catch (err) {
      if (!err.isAuthError) toast('Failed to load server', 'error');
    }
  };

  window._deleteMcp = async function (id, name) {
    if (!confirm(`Remove MCP server "${name}"?`)) return;
    try {
      const res = await adminFetch(`${API}/capabilities/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.ok) {
        toast('Server removed', 'success');
        loadMcpServers();
      } else {
        toast(json.error || 'Failed', 'error');
      }
    } catch (err) {
      if (!err.isAuthError) toast('Connection error', 'error');
    }
  };

  window._connectMcp = async function (capId) {
    const agentId = document.getElementById(`mcp-agent-sel-${capId}`)?.value;
    if (!agentId) { toast('Select an agent first', 'error'); return; }

    try {
      const res = await adminFetch(`${API}/agents/${agentId}/capabilities/${capId}`, { method: 'PUT', body: '{}' });
      const json = await res.json();
      if (json.ok) {
        toast('Agent connected', 'success');
        loadMcpServers();
      } else {
        toast(json.error || 'Failed', 'error');
      }
    } catch (err) {
      if (!err.isAuthError) toast('Connection error', 'error');
    }
  };

  window._disconnectMcp = async function (capId, agentId) {
    try {
      const res = await adminFetch(`${API}/agents/${agentId}/capabilities/${capId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.ok) {
        toast('Agent disconnected', 'success');
        loadMcpServers();
      } else {
        toast(json.error || 'Failed', 'error');
      }
    } catch (err) {
      if (!err.isAuthError) toast('Connection error', 'error');
    }
  };

  // ─── LLM Config ───────────────────────────────────────────────────
  const $llmProvider = document.getElementById('llmProvider');
  const $llmModel = document.getElementById('llmModel');

  async function loadLlmConfig() {
    try {
      const provRes = await adminFetch(`${API}/llm-config/providers`);
      const provJson = await provRes.json();
      if (provJson.ok) {
        providers = provJson.data;
        $llmProvider.innerHTML = providers.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
      }

      const cfgRes = await adminFetch(`${API}/llm-config`);
      const cfgJson = await cfgRes.json();
      if (cfgJson.ok) {
        $llmProvider.value = cfgJson.data.provider;
        updateModelOptions();
        $llmModel.value = cfgJson.data.model;
      }

      renderApiKeys();
    } catch (err) {
      if (!err.isAuthError) {
        $llmProvider.innerHTML = '<option value="">Failed to load providers</option>';
      }
    }
  }

  function updateModelOptions() {
    const provider = providers.find(p => p.id === $llmProvider.value);
    if (!provider) return;
    $llmModel.innerHTML = provider.models.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  }

  $llmProvider.addEventListener('change', updateModelOptions);

  document.getElementById('btnSaveLlm').addEventListener('click', async () => {
    try {
      const res = await adminFetch(`${API}/llm-config`, {
        method: 'PUT',
        body: JSON.stringify({ provider: $llmProvider.value, model: $llmModel.value }),
      });
      const json = await res.json();
      toast(json.ok ? 'Model saved' : (json.error || 'Failed'), json.ok ? 'success' : 'error');
    } catch (err) {
      if (!err.isAuthError) toast('Connection error', 'error');
    }
  });

  function renderApiKeys() {
    const $list = document.getElementById('apiKeyList');
    $list.innerHTML = providers.map(p => `
      <div class="card-row">
        <div>
          <span class="label">${p.name}</span>
          ${p.hasKey ? `<span class="badge badge-green" style="margin-left:8px">configured</span>` : `<span class="badge badge-yellow" style="margin-left:8px">not set</span>`}
          ${p.keyPrefix ? `<span style="font-size:11px;color:var(--text-tertiary);margin-left:8px">${p.keyPrefix}</span>` : ''}
        </div>
        <div class="inline-form" style="gap:6px">
          <input type="password" placeholder="Paste API key" id="apikey-${p.id}" style="width:200px;padding:6px 10px;font-size:13px">
          <button class="btn-sm" onclick="window._saveApiKey('${p.id}')">Save</button>
          ${p.hasKey ? `<button class="btn-sm danger" onclick="window._deleteApiKey('${p.id}')">Remove</button>` : ''}
        </div>
      </div>
    `).join('');
  }

  window._saveApiKey = async function (provider) {
    const input = document.getElementById('apikey-' + provider);
    const apiKey = input.value.trim();
    if (!apiKey) return;

    try {
      const res = await adminFetch(`${API}/llm-config/api-key`, {
        method: 'PUT',
        body: JSON.stringify({ provider, apiKey }),
      });
      const json = await res.json();
      if (json.ok) {
        input.value = '';
        toast('API key saved', 'success');
        loadLlmConfig();
      } else {
        toast(json.error || 'Failed', 'error');
      }
    } catch (err) {
      if (!err.isAuthError) toast('Connection error', 'error');
    }
  };

  window._deleteApiKey = async function (provider) {
    if (!confirm(`Remove ${provider} API key?`)) return;
    try {
      const res = await adminFetch(`${API}/llm-config/api-key/${provider}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.ok) {
        toast('API key removed', 'success');
        loadLlmConfig();
      }
    } catch (err) {
      if (!err.isAuthError) toast('Connection error', 'error');
    }
  };

  // ─── Settings ──────────────────────────────────────────────────────
  async function loadSettings() {
    const $list = document.getElementById('settingsList');
    try {
      const res = await adminFetch(`${API}/settings`);
      const json = await res.json();
      if (!json.ok) {
        $list.innerHTML = '<p class="empty-state">Failed to load settings</p>';
        return;
      }

      $list.innerHTML = json.data.map(s => `
        <div class="card-row">
          <div>
            <span class="label">${escapeHtml(s.label)}</span>
            ${s.configured ? `<span class="badge badge-green" style="margin-left:8px">${s.source}</span>` : `<span class="badge badge-yellow" style="margin-left:8px">not set</span>`}
            ${s.keyPrefix ? `<span style="font-size:11px;color:var(--text-tertiary);margin-left:8px">${s.keyPrefix}</span>` : ''}
            <br><span style="font-size:11px;color:var(--text-tertiary)">${escapeHtml(s.description)}</span>
          </div>
          <div class="inline-form" style="gap:6px">
            <input type="password" placeholder="Paste value" id="setting-${s.key}" style="width:200px;padding:6px 10px;font-size:13px">
            <button class="btn-sm" onclick="window._saveSetting('${s.key}')">Save</button>
            ${s.source === 'db' ? `<button class="btn-sm danger" onclick="window._deleteSetting('${s.key}')">Remove</button>` : ''}
          </div>
        </div>
      `).join('');
    } catch (err) {
      if (!err.isAuthError) $list.innerHTML = '<p class="empty-state">Failed to load settings</p>';
    }
  }

  window._saveSetting = async function (key) {
    const input = document.getElementById('setting-' + key);
    const value = input.value.trim();
    if (!value) return;

    try {
      const res = await adminFetch(`${API}/settings/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      const json = await res.json();
      if (json.ok) {
        input.value = '';
        toast('Setting saved', 'success');
        loadSettings();
      } else {
        toast(json.error || 'Failed', 'error');
      }
    } catch (err) {
      if (!err.isAuthError) toast('Connection error', 'error');
    }
  };

  window._deleteSetting = async function (key) {
    if (!confirm(`Remove setting ${key}?`)) return;
    try {
      const res = await adminFetch(`${API}/settings/${key}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.ok) {
        toast('Setting removed', 'success');
        loadSettings();
      }
    } catch (err) {
      if (!err.isAuthError) toast('Connection error', 'error');
    }
  };

  // ─── Utilities ─────────────────────────────────────────────────────
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function toast(message, type) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }
})();
