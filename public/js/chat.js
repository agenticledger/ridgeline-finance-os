// ─── Orphil Chat Client ──────────────────────────────────────────────
(function () {
  const API = '/api';
  let currentConversationId = null;
  let currentAgentId = null;

  const $messages = document.getElementById('chatMessages');
  const $input = document.getElementById('chatInput');
  const $btnSend = document.getElementById('btnSend');
  const $btnNewChat = document.getElementById('btnNewChat');
  const $conversationList = document.getElementById('conversationList');
  const $agentSelect = document.getElementById('agentSelect');
  const $agentAvatar = document.getElementById('agentAvatar');
  const $agentDescription = document.getElementById('agentDescription');
  const $sidebar = document.getElementById('chatSidebar');
  const $btnToggle = document.getElementById('btnToggleSidebar');
  const $btnChatSize = document.getElementById('btnChatSize');
  const $chatContainer = document.querySelector('.chat-container');

  let allAgents = [];

  // ─── Chat Size Toggle ──────────────────────────────────────────────
  const SIZES = ['size-half', 'size-three-quarter', 'size-full'];
  const SIZE_ICONS = [
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 4v16"/></svg>',
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/></svg>',
  ];
  const SIZE_TITLES = ['Half width', 'Three-quarter width', 'Full width'];
  // Default to full width so the chat uses the whole page; remember the choice.
  let currentSizeIndex = 2;
  try {
    const saved = parseInt(localStorage.getItem('rl-chat-size'), 10);
    if (saved >= 0 && saved < SIZES.length) currentSizeIndex = saved;
  } catch {}

  function applySize() {
    SIZES.forEach((s) => $chatContainer.classList.remove(s));
    $chatContainer.classList.add(SIZES[currentSizeIndex]);
    $btnChatSize.innerHTML = SIZE_ICONS[currentSizeIndex];
    $btnChatSize.title = SIZE_TITLES[currentSizeIndex];
  }
  applySize();

  $btnChatSize.addEventListener('click', () => {
    currentSizeIndex = (currentSizeIndex + 1) % SIZES.length;
    applySize();
    try { localStorage.setItem('rl-chat-size', String(currentSizeIndex)); } catch {}
  });

  // ─── Init ──────────────────────────────────────────────────────────
  async function init() {
    try {
      const res = await fetch(`${API}/agents`);
      const json = await res.json();
      if (json.ok && json.data.length > 0) {
        allAgents = json.data;
        $agentSelect.innerHTML = allAgents.map(a =>
          `<option value="${a.id}">${escapeHtml(a.name)}</option>`
        ).join('');

        // Honor ?agent=<id|slug> so "Open chat" lands on the requested agent
        // (e.g. the Freight Accrual Process Owner Agent), not a default.
        const want = new URLSearchParams(location.search).get('agent');
        const preferred =
          (want && allAgents.find(a => a.id === want || a.slug === want)) ||
          allAgents[0];
        $agentSelect.value = preferred.id;
        selectAgent(preferred);
      } else {
        $agentSelect.innerHTML = '<option value="">No agents available</option>';
      }
    } catch {
      $agentSelect.innerHTML = '<option value="">Failed to load agents</option>';
    }
    loadConversations();
  }

  function selectAgent(agent) {
    currentAgentId = agent.id;
    $agentAvatar.textContent = agent.branding?.avatar || agent.name.charAt(0);
    $agentDescription.textContent = agent.description;
    if ($input) $input.placeholder = `Ask ${agent.name}...`;
    // Update welcome message
    const welcome = $messages.querySelector('.welcome-message');
    if (welcome) {
      welcome.querySelector('.agent-avatar').textContent = agent.branding?.avatar || agent.name.charAt(0);
      welcome.querySelector('h3').textContent = `Welcome to ${agent.name}`;
      welcome.querySelector('p').textContent = agent.description;
    }
  }

  $agentSelect.addEventListener('change', () => {
    const agent = allAgents.find(a => a.id === $agentSelect.value);
    if (!agent) return;
    selectAgent(agent);
    // Start fresh conversation with new agent
    currentConversationId = null;
    $messages.innerHTML = `
      <div class="welcome-message">
        <div class="agent-avatar large">${escapeHtml(agent.branding?.avatar || agent.name.charAt(0))}</div>
        <h3>Welcome to ${escapeHtml(agent.name)}</h3>
        <p>${escapeHtml(agent.description)}</p>
      </div>
    `;
  });

  // ─── Conversations ────────────────────────────────────────────────
  async function loadConversations() {
    try {
      const res = await fetch(`${API}/chat/conversations`);
      const json = await res.json();
      if (!json.ok || json.data.length === 0) {
        $conversationList.innerHTML = '<p class="empty-state">No conversations yet</p>';
        return;
      }
      $conversationList.innerHTML = json.data.map(c => `
        <div class="conversation-item ${c.id === currentConversationId ? 'active' : ''}" data-id="${c.id}">
          <div class="conv-main" data-id="${c.id}">
            <span class="conv-title">${escapeHtml(c.title || 'New conversation')}</span>
            <span class="conv-meta">${formatDate(c.lastMessageAt || c.createdAt)}</span>
          </div>
          <button class="conv-del" data-id="${c.id}" title="Delete conversation" aria-label="Delete conversation">&times;</button>
        </div>
      `).join('');

      $conversationList.querySelectorAll('.conv-main').forEach(el => {
        el.addEventListener('click', () => loadConversation(el.dataset.id));
      });
      $conversationList.querySelectorAll('.conv-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          // Two-click inline confirm (no native dialog): first click arms the
          // button, second click within 3s deletes. Auto-reverts otherwise.
          if (btn.dataset.armed === '1') { deleteConversation(btn.dataset.id); return; }
          btn.dataset.armed = '1';
          btn.classList.add('confirm');
          btn.textContent = '✓';
          btn.title = 'Click again to confirm delete';
          clearTimeout(btn._revert);
          btn._revert = setTimeout(() => {
            btn.dataset.armed = '0';
            btn.classList.remove('confirm');
            btn.textContent = '×';
            btn.title = 'Delete conversation';
          }, 3000);
        });
      });
    } catch {
      // silently fail
    }
  }

  async function loadConversation(convId) {
    try {
      const res = await fetch(`${API}/chat/${convId}`);
      const json = await res.json();
      if (!json.ok) return;

      currentConversationId = convId;
      $messages.innerHTML = '';

      json.data.messages.forEach(msg => {
        appendMessage(msg.role, msg.content);
      });

      scrollToBottom();
      loadConversations();
    } catch {
      // silently fail
    }
  }

  async function startConversation() {
    if (!currentAgentId) {
      appendSystemMessage('No agent configured. Please set up an agent in the admin panel.');
      return null;
    }

    try {
      const res = await fetch(`${API}/chat/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: currentAgentId }),
      });
      const json = await res.json();
      if (json.ok) {
        currentConversationId = json.data.conversationId;
        loadConversations();
        return currentConversationId;
      }
    } catch {
      appendSystemMessage('Failed to start conversation. Is the database connected?');
    }
    return null;
  }

  // ─── Send Message ─────────────────────────────────────────────────
  async function sendMessage() {
    const content = $input.value.trim();
    if (!content) return;

    if (!currentConversationId) {
      const id = await startConversation();
      if (!id) return;
    }

    $input.value = '';
    $input.style.height = 'auto';
    appendMessage('user', content);
    scrollToBottom();
    setLoading(true);

    // Remove welcome message if present
    const welcome = $messages.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    try {
      const res = await fetch(`${API}/chat/${currentConversationId}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        appendSystemMessage(err.error || `Error ${res.status}`);
        setLoading(false);
        return;
      }

      // SSE streaming
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantEl = null;
      let assistantContent = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            var eventType = line.slice(7);
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'delta') {
                if (!assistantEl) {
                  assistantEl = appendMessage('assistant', '');
                }
                assistantContent += data.content;
                assistantEl.querySelector('.message-text').innerHTML = renderMarkdown(assistantContent);
                scrollToBottom();
              } else if (eventType === 'error') {
                appendSystemMessage(data.message || 'Stream error');
              }
            } catch {
              // parse error, skip
            }
            eventType = null;
          }
        }
      }

      loadConversations();
      // the LLM-refined title lands a moment after the stream ends
      setTimeout(loadConversations, 2500);
    } catch (err) {
      appendSystemMessage('Connection error: ' + err.message);
    }

    setLoading(false);
  }

  // ─── UI Helpers ───────────────────────────────────────────────────
  function appendMessage(role, content) {
    const div = document.createElement('div');
    div.className = `message message-${role}`;
    div.innerHTML = `
      <div class="message-avatar">${role === 'user' ? 'You' : 'O'}</div>
      <div class="message-body">
        <div class="message-text">${role === 'user' ? escapeHtml(content) : renderMarkdown(content)}</div>
      </div>
    `;
    $messages.appendChild(div);
    return div;
  }

  function appendSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'message message-system';
    div.innerHTML = `<div class="message-body"><div class="message-text">${escapeHtml(text)}</div></div>`;
    $messages.appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    $messages.scrollTop = $messages.scrollHeight;
  }

  function setLoading(on) {
    $btnSend.disabled = on;
    $input.disabled = on;
    if (on) {
      const dot = document.createElement('div');
      dot.className = 'message message-assistant typing-indicator';
      dot.id = 'typingIndicator';
      dot.innerHTML = '<div class="message-avatar">O</div><div class="message-body"><div class="dots"><span></span><span></span><span></span></div></div>';
      $messages.appendChild(dot);
      scrollToBottom();
    } else {
      const ti = document.getElementById('typingIndicator');
      if (ti) ti.remove();
    }
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function renderMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return d.toLocaleDateString();
  }

  // ─── Event Listeners ──────────────────────────────────────────────
  $btnSend.addEventListener('click', sendMessage);

  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  $input.addEventListener('input', () => {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 150) + 'px';
  });

  function resetToWelcome() {
    currentConversationId = null;
    const agent = allAgents.find(a => a.id === currentAgentId) || { name: 'Ridgeline Finance OS', description: 'Process Owner Agent' };
    const avatar = agent.branding?.avatar || agent.name.charAt(0);
    $messages.innerHTML = `
      <div class="welcome-message">
        <div class="agent-avatar large">${escapeHtml(avatar)}</div>
        <h3>Welcome to ${escapeHtml(agent.name)}</h3>
        <p>${escapeHtml(agent.description)}</p>
      </div>
    `;
  }

  async function deleteConversation(convId) {
    try {
      await fetch(`${API}/chat/${convId}`, { method: 'DELETE' });
      if (convId === currentConversationId) resetToWelcome();
      loadConversations();
    } catch {
      // non-critical
    }
  }

  $btnNewChat.addEventListener('click', () => {
    resetToWelcome();
    loadConversations();
  });

  $btnToggle.addEventListener('click', () => {
    $sidebar.classList.toggle('collapsed');
  });

  init();
})();
