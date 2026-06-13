// ─── Orphil Floating Chat Widget ─────────────────────────────────────
// Appears on every page as a bottom-right bubble. Opens an inline chat.
(function () {
  const API = '/api';
  let agentId = null;
  let conversationId = null;
  let isOpen = false;

  // ─── Build DOM ─────────────────────────────────────────────────────
  const widget = document.createElement('div');
  widget.id = 'orphilWidget';
  widget.innerHTML = `
    <button class="ow-fab" id="owFab" aria-label="Chat with Orphil">
      <svg class="ow-icon-chat" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <svg class="ow-icon-close" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div class="ow-panel" id="owPanel">
      <div class="ow-header">
        <div class="ow-header-left">
          <div class="ow-avatar">O</div>
          <div>
            <div class="ow-name">Orphil</div>
            <div class="ow-status">AI Advisory Assistant</div>
          </div>
        </div>
        <div class="ow-header-actions">
          <button class="ow-header-btn" id="owClear" aria-label="Clear conversation" title="Clear conversation">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
          <button class="ow-header-btn" id="owResize" aria-label="Resize chat" title="Resize chat">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
          </button>
          <button class="ow-close" id="owClose" aria-label="Close chat">&times;</button>
        </div>
      </div>
      <div class="ow-messages" id="owMessages">
        <div class="ow-welcome">
          <p>Hi! I'm Orphil's AI assistant. Ask me anything about our AI transformation services.</p>
        </div>
      </div>
      <div class="ow-input-area">
        <textarea id="owInput" placeholder="Type a message..." rows="1" maxlength="5000"></textarea>
        <button class="ow-send" id="owSend" aria-label="Send">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(widget);

  const $fab = document.getElementById('owFab');
  const $panel = document.getElementById('owPanel');
  const $close = document.getElementById('owClose');
  const $clear = document.getElementById('owClear');
  const $resize = document.getElementById('owResize');
  const $messages = document.getElementById('owMessages');
  const $input = document.getElementById('owInput');
  const $send = document.getElementById('owSend');
  const $iconChat = widget.querySelector('.ow-icon-chat');
  const $iconClose = widget.querySelector('.ow-icon-close');

  // Don't show widget on /chat or /admin pages
  if (window.location.pathname === '/chat' || window.location.pathname === '/admin') {
    widget.style.display = 'none';
    return;
  }

  // ─── Toggle ────────────────────────────────────────────────────────
  function toggle() {
    isOpen = !isOpen;
    $panel.classList.toggle('open', isOpen);
    $iconChat.style.display = isOpen ? 'none' : 'block';
    $iconClose.style.display = isOpen ? 'block' : 'none';
    if (isOpen) {
      $input.focus();
      if (!agentId) initAgent();
    }
  }

  $fab.addEventListener('click', toggle);
  $close.addEventListener('click', toggle);

  // ─── Clear Conversation ──────────────────────────────────────────
  $clear.addEventListener('click', () => {
    conversationId = null;
    $messages.innerHTML = `
      <div class="ow-welcome">
        <p>Hi! I'm Orphil's AI assistant. Ask me anything about our AI transformation services.</p>
      </div>
    `;
  });

  // ─── Resize ──────────────────────────────────────────────────────
  const OW_SIZES = ['ow-size-default', 'ow-size-medium', 'ow-size-large'];
  let owSizeIndex = 0;

  $resize.addEventListener('click', () => {
    $panel.classList.remove(OW_SIZES[owSizeIndex]);
    owSizeIndex = (owSizeIndex + 1) % OW_SIZES.length;
    $panel.classList.add(OW_SIZES[owSizeIndex]);
  });

  // ─── Init Agent ────────────────────────────────────────────────────
  async function initAgent() {
    try {
      const res = await fetch(`${API}/agents`);
      const json = await res.json();
      if (json.ok && json.data.length > 0) {
        const agent = json.data.find(a => a.slug === 'orphil-advisory') || json.data[0];
        agentId = agent.id;
      }
    } catch {
      // silently fail
    }
  }

  async function ensureConversation() {
    if (conversationId) return true;
    if (!agentId) {
      await initAgent();
      if (!agentId) {
        addMsg('system', 'Agent not configured yet.');
        return false;
      }
    }
    try {
      const res = await fetch(`${API}/chat/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });
      const json = await res.json();
      if (json.ok) {
        conversationId = json.data.conversationId;
        return true;
      }
    } catch {
      addMsg('system', 'Could not start conversation.');
    }
    return false;
  }

  // ─── Send ──────────────────────────────────────────────────────────
  async function send() {
    const text = $input.value.trim();
    if (!text) return;

    $input.value = '';
    $input.style.height = 'auto';

    // Remove welcome
    const welcome = $messages.querySelector('.ow-welcome');
    if (welcome) welcome.remove();

    addMsg('user', text);

    if (!(await ensureConversation())) return;

    setLoading(true);

    try {
      const res = await fetch(`${API}/chat/${conversationId}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        addMsg('system', err.error || 'Error');
        setLoading(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantEl = null;
      let fullText = '';
      let buffer = '';
      let eventType = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7);
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'delta') {
                if (!assistantEl) {
                  assistantEl = addMsg('assistant', '');
                }
                fullText += data.content;
                assistantEl.querySelector('.ow-msg-text').innerHTML = miniRender(fullText);
                $messages.scrollTop = $messages.scrollHeight;
              } else if (eventType === 'error') {
                addMsg('system', data.message || 'Error');
              }
            } catch { /* skip */ }
            eventType = null;
          }
        }
      }
    } catch (err) {
      addMsg('system', 'Connection error');
    }

    setLoading(false);
  }

  // ─── UI Helpers ────────────────────────────────────────────────────
  function addMsg(role, text) {
    const div = document.createElement('div');
    div.className = `ow-msg ow-msg-${role}`;
    if (role === 'user') {
      div.innerHTML = `<div class="ow-msg-text">${esc(text)}</div>`;
    } else if (role === 'assistant') {
      div.innerHTML = `<div class="ow-msg-avatar">O</div><div class="ow-msg-text">${miniRender(text)}</div>`;
    } else {
      div.innerHTML = `<div class="ow-msg-text ow-msg-sys">${esc(text)}</div>`;
    }
    $messages.appendChild(div);
    $messages.scrollTop = $messages.scrollHeight;
    return div;
  }

  function setLoading(on) {
    $send.disabled = on;
    $input.disabled = on;
    const existing = document.getElementById('owTyping');
    if (on && !existing) {
      const d = document.createElement('div');
      d.className = 'ow-msg ow-msg-assistant';
      d.id = 'owTyping';
      d.innerHTML = '<div class="ow-msg-avatar">O</div><div class="ow-typing"><span></span><span></span><span></span></div>';
      $messages.appendChild(d);
      $messages.scrollTop = $messages.scrollHeight;
    } else if (!on && existing) {
      existing.remove();
    }
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function miniRender(t) {
    if (!t) return '';
    return t
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  // ─── Events ────────────────────────────────────────────────────────
  $send.addEventListener('click', send);
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $input.addEventListener('input', () => {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 100) + 'px';
  });
})();
