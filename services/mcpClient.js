/**
 * HTTP MCP Client — connects to remote MCP servers via Streamable HTTP.
 * Ported from MyAIforOne's mcpHttpClient.ts.
 *
 * Supports the MCP protocol over HTTP with optional Bearer token auth.
 * Handles session management (mcp-session-id) required by Streamable HTTP servers.
 */

// Session + tool cache per server URL (keyed by url + token)
const sessions = new Map();
const toolCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheKey(serverUrl, bearerToken) {
  return `${serverUrl}::${bearerToken || ''}`;
}

function parseSSEResult(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.result) return data.result;
        if (data.error) throw new Error(data.error.message || 'MCP server error');
      } catch (e) {
        if (e.message && e.message.includes('MCP server error')) throw e;
      }
    }
  }
  throw new Error('No result in SSE response');
}

async function mcpRequest(serverUrl, method, params = {}, bearerToken, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const body = { jsonrpc: '2.0', id: Date.now(), method, params };

  const res = await fetch(serverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  const newSessionId = res.headers.get('mcp-session-id') || undefined;
  const contentType = res.headers.get('content-type') || '';

  if (!res.ok) {
    const text = await res.text();
    let msg = `HTTP ${res.status}`;
    try { msg = JSON.parse(text).error?.message || msg; } catch { /* */ }
    throw new Error(msg);
  }

  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    return { result: parseSSEResult(text), sessionId: newSessionId };
  }

  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'MCP server error');
  return { result: json.result, sessionId: newSessionId };
}

async function ensureSession(serverUrl, bearerToken) {
  const key = cacheKey(serverUrl, bearerToken);
  const existing = sessions.get(key);
  if (existing && Date.now() - existing.createdAt < CACHE_TTL) {
    return existing.sessionId;
  }

  try {
    const { sessionId } = await mcpRequest(serverUrl, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'orphil-platform', version: '1.0.0' },
    }, bearerToken);

    if (sessionId) {
      sessions.set(key, { sessionId, createdAt: Date.now() });
      // Send initialized notification (required by MCP spec)
      await mcpRequest(serverUrl, 'notifications/initialized', {}, bearerToken, sessionId)
        .catch(() => { /* notification failures are non-fatal */ });
    }
    return sessionId;
  } catch {
    return undefined;
  }
}

/**
 * List tools from an HTTP MCP server. Results cached for 5 minutes.
 */
async function listTools(serverUrl, bearerToken) {
  const key = cacheKey(serverUrl, bearerToken);
  const cached = toolCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.tools;
  }

  const sessionId = await ensureSession(serverUrl, bearerToken);
  const { result } = await mcpRequest(serverUrl, 'tools/list', {}, bearerToken, sessionId);
  const tools = result?.tools || [];

  toolCache.set(key, { tools, fetchedAt: Date.now() });
  return tools;
}

/**
 * Call a tool on an HTTP MCP server.
 */
async function callTool(serverUrl, toolName, args, bearerToken) {
  const sessionId = await ensureSession(serverUrl, bearerToken);

  const { result } = await mcpRequest(serverUrl, 'tools/call', {
    name: toolName,
    arguments: args,
  }, bearerToken, sessionId);

  if (result?.content && Array.isArray(result.content)) {
    return result.content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text)
      .join('\n');
  }
  return JSON.stringify(result);
}

/**
 * Test connectivity to an HTTP MCP server.
 */
async function testConnection(serverUrl, bearerToken) {
  try {
    const tools = await listTools(serverUrl, bearerToken);
    return { ok: true, tools };
  } catch (err) {
    return { ok: false, error: err.message || 'Connection failed' };
  }
}

/** Clear session + tool caches (call after changing bearer token) */
function clearCache(serverUrl) {
  if (serverUrl) {
    for (const key of [...toolCache.keys(), ...sessions.keys()]) {
      if (key.startsWith(serverUrl)) {
        toolCache.delete(key);
        sessions.delete(key);
      }
    }
  } else {
    toolCache.clear();
    sessions.clear();
  }
}

module.exports = { listTools, callTool, testConnection, clearCache };
