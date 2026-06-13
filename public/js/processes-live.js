/* Live Map — hand-rolled layout + SVG particle animation. No external libs.
 * Two modes off window.LM_GRAPH.mode:
 *   'overview'  — Org → Area → Process constellation (layered columns).
 *   'schematic' — the inside of one process: owner agent + ordered steps, each
 *                 step's policies (left) and tools (right), typed by decision type,
 *                 with the latest run's per-step status lighting the spine.
 * The "living" feel is SVG <animateMotion> particles riding each edge. */
(function () {
  var G = window.LM_GRAPH || { nodes: [], edges: [], mode: 'overview' };
  var svg = document.getElementById('lm-svg');
  var stage = document.getElementById('lm-stage');

  var byId = {};
  G.nodes.forEach(function (n) { byId[n.id] = n; });

  var sigStroke = { idle: 'var(--muted)', live: 'var(--accent)', attention: 'var(--warn)', posted: 'var(--good)' };
  var sigPace = { idle: 5.5, live: 1.9, posted: 3.4, attention: 2.6 };
  var sigCount = { idle: 1, live: 3, posted: 2, attention: 2 };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  var W = 0, H = 0; // content size, set by the active renderer

  // Emit a bezier edge + its riding particles. `vertical` curves top→bottom.
  function edge(parts, x1, y1, x2, y2, signal, idx, vertical, faint) {
    var d;
    if (vertical) { var my = (y1 + y2) / 2; d = 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + my + ' ' + x2 + ',' + my + ' ' + x2 + ',' + y2; }
    else { var mx = (x1 + x2) / 2; d = 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2; }
    var pid = 'p' + idx;
    parts.push('<path id="' + pid + '" class="lm-edge ' + signal + '" d="' + d + '"' + (faint ? ' opacity="0.28"' : '') + '/>');
    if (faint && signal === 'idle') return;
    var col = sigStroke[signal] || sigStroke.idle;
    var dur = sigPace[signal] || 5;
    var n = faint ? 1 : (sigCount[signal] || 1);
    for (var k = 0; k < n; k++) {
      var begin = (dur / n * k).toFixed(2);
      parts.push('<circle r="' + (faint ? 2.2 : 3) + '" fill="' + col + '" filter="url(#lmglow)" opacity="' + (signal === 'idle' ? 0.5 : 0.95) + '">' +
        '<animateMotion dur="' + dur + 's" repeatCount="indefinite" begin="' + begin + 's"><mpath href="#' + pid + '"/></animateMotion></circle>');
    }
  }

  function defs(parts) {
    parts.push('<defs>' +
      '<filter id="lmglow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
      '</defs>');
  }

  // ---------------------------------------------------------------- OVERVIEW
  function renderOverview() {
    var DIM = { org: { w: 170, h: 62 }, function: { w: 184, h: 58 }, process: { w: 210, h: 70 }, agent: { w: 168, h: 50 } };
    var COL_X = [60, 360, 700, 1040];
    var ROW = 96, PAD = 60;

    var procs = G.nodes.filter(function (n) { return n.type === 'process'; });
    procs.forEach(function (n, i) { n._y = PAD + i * ROW; n._x = COL_X[2]; });

    var childY = {};
    G.edges.forEach(function (e) { (childY[e.from] = childY[e.from] || []).push(e.to); });
    function avgChildY(id) {
      var kids = (childY[id] || []).map(function (cid) { return byId[cid] && byId[cid]._y; }).filter(function (v) { return typeof v === 'number'; });
      if (!kids.length) return PAD;
      return kids.reduce(function (a, b) { return a + b; }, 0) / kids.length;
    }
    G.nodes.filter(function (n) { return n.type === 'function'; }).forEach(function (n) { n._y = avgChildY(n.id); n._x = COL_X[1]; });
    G.nodes.filter(function (n) { return n.type === 'org'; }).forEach(function (n) { n._y = avgChildY(n.id); n._x = COL_X[0]; });

    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    G.nodes.forEach(function (n) { var d = DIM[n.type]; minX = Math.min(minX, n._x); minY = Math.min(minY, n._y - d.h / 2); maxX = Math.max(maxX, n._x + d.w); maxY = Math.max(maxY, n._y + d.h / 2); });
    W = (maxX - minX) + PAD * 2; H = (maxY - minY) + PAD * 2;
    var OX = -minX + PAD, OY = -minY + PAD;

    var parts = []; defs(parts);
    G.edges.forEach(function (e, idx) {
      var a = byId[e.from], b = byId[e.to]; if (!a || !b) return;
      var da = DIM[a.type], db = DIM[b.type];
      edge(parts, a._x + da.w + OX, a._y + OY, b._x + OX, b._y + OY, e.signal, idx, false, false);
    });
    G.nodes.forEach(function (n) {
      var d = DIM[n.type];
      var x = n._x + OX, y = (n._y + OY) - d.h / 2;
      var dataFn = n.type === 'process' ? n.fnSlug : (n.type === 'function' ? n.slug : '');
      var clickJs = n.type === 'process' ? ('lmFlyTo(this,\'/processes/live/' + n.slug + '\')') : '';
      parts.push('<g class="lm-node ' + n.type + ' ' + (n.signal || 'idle') + '"' + (dataFn ? ' data-fn="' + esc(dataFn) + '"' : '') + (clickJs ? ' onclick="' + clickJs + '"' : '') + '>');
      parts.push('<rect class="lm-box" x="' + x + '" y="' + y + '" width="' + d.w + '" height="' + d.h + '" rx="12"/>');
      parts.push('<circle class="lm-dot ' + (n.signal || 'idle') + '" cx="' + (x + 14) + '" cy="' + (y + 16) + '" r="4.5" fill="' + (sigStroke[n.signal] || sigStroke.idle) + '"/>');
      parts.push('<text class="lm-title" x="' + (x + 28) + '" y="' + (y + 26) + '" font-size="' + (n.type === 'process' ? 14 : 13) + '">' + esc(clip(n.label, n.type === 'process' ? 22 : 20)) + '</text>');
      if (n.sublabel) parts.push('<text class="lm-sub" x="' + (x + 28) + '" y="' + (y + 44) + '" font-size="10.5">' + esc(n.sublabel) + '</text>');
      if (n.type === 'process') {
        parts.push('<text class="lm-tag" x="' + (x + d.w - 12) + '" y="' + (y + 26) + '" text-anchor="end" font-size="9.5" fill="' + (sigStroke[n.signal] || sigStroke.idle) + '">' + esc((n.signal || 'idle').toUpperCase()) + '</text>');
        if (n.frequency) parts.push('<text class="lm-sub" x="' + (x + d.w - 12) + '" y="' + (y + 44) + '" text-anchor="end" font-size="10">' + esc(n.frequency + ' · ' + n.mode) + '</text>');
      }
      parts.push('</g>');
    });
    paint(parts);
  }

  // --------------------------------------------------------------- SCHEMATIC
  function renderSchematic() {
    var D = { agent: { w: 250, h: 64 }, step: { w: 260, h: 70 }, policy: { w: 184, h: 48 }, tool: { w: 184, h: 48 } };
    var BR = 60, GAP = 30, TOP = 150, RAIL_X = 30;
    var SX = 560;                              // step box left
    var stepCx = SX + D.step.w / 2;
    var POL_RIGHT = SX - 70;                   // policy box right edge
    var POL_X = POL_RIGHT - D.policy.w;
    var TOOL_X = SX + D.step.w + 70;           // tool box left

    var agent = G.nodes.filter(function (n) { return n.type === 'agent'; })[0];
    var steps = G.nodes.filter(function (n) { return n.type === 'step'; }).sort(function (a, b) { return a.order - b.order; });

    if (agent) { agent._cx = stepCx; agent._cy = TOP - 84; }
    var y = TOP;
    steps.forEach(function (s) {
      var rows = Math.max(1, (s.policies || []).length, (s.tools || []).length);
      var band = rows * BR;
      s._cy = y + band / 2; s._cx = stepCx;
      (s.policies || []).forEach(function (po, i) { var n = byId[po.id]; if (n) { n._cx = POL_X + D.policy.w / 2; n._cy = y + BR * i + BR / 2; } });
      (s.tools || []).forEach(function (t, i) { var n = byId[t.id]; if (n) { n._cx = TOOL_X + D.tool.w / 2; n._cy = y + BR * i + BR / 2; } });
      y += band + GAP;
    });

    // Process-level rail (far left): policies then tools, stacked.
    var rail = (G.rail || { policies: [], tools: [] });
    var railNodes = rail.policies.concat(rail.tools);
    var railTop = TOP, ry = railTop + 26;
    railNodes.forEach(function (rn) { rn._cx = RAIL_X + D.policy.w / 2; rn._cy = ry; ry += 56; });

    // Bounds.
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    function bound(cx, cy, d) { minX = Math.min(minX, cx - d.w / 2); maxX = Math.max(maxX, cx + d.w / 2); minY = Math.min(minY, cy - d.h / 2); maxY = Math.max(maxY, cy + d.h / 2); }
    if (agent) bound(agent._cx, agent._cy, D.agent);
    steps.forEach(function (s) {
      bound(s._cx, s._cy, D.step);
      (s.policies || []).forEach(function (po) { var n = byId[po.id]; if (n) bound(n._cx, n._cy, D.policy); });
      (s.tools || []).forEach(function (t) { var n = byId[t.id]; if (n) bound(n._cx, n._cy, D.tool); });
    });
    railNodes.forEach(function (rn) { bound(rn._cx, rn._cy, D.policy); });
    if (railNodes.length) minX = Math.min(minX, RAIL_X - 10);
    var PAD = 70;
    minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
    W = maxX - minX; H = maxY - minY;

    var parts = []; defs(parts);

    // Edges (spine vertical, branches horizontal).
    G.edges.forEach(function (e, idx) {
      var a = byId[e.from], b = byId[e.to]; if (!a || !b) return;
      if (e.spine) {
        var da = a.type === 'agent' ? D.agent : D.step;
        edge(parts, a._cx - minX, a._cy + da.h / 2 - minY, b._cx - minX, b._cy - D.step.h / 2 - minY, e.signal, idx, true, false);
      } else if (e.branch === 'policy') {
        edge(parts, a._cx - D.step.w / 2 - minX, a._cy - minY, b._cx + D.policy.w / 2 - minX, b._cy - minY, e.signal, idx, false, true);
      } else { // tool
        edge(parts, a._cx + D.step.w / 2 - minX, a._cy - minY, b._cx - D.tool.w / 2 - minX, b._cy - minY, e.signal, idx, false, true);
      }
    });

    // Rail header + nodes.
    if (railNodes.length) {
      parts.push('<text class="lm-railhead" x="' + (RAIL_X - minX) + '" y="' + (railTop - 4 - minY) + '">PROCESS-LEVEL</text>');
      railNodes.forEach(function (rn) { pill(parts, rn, rn._cx - minX, rn._cy - minY, D.policy, rn.type); });
    }

    // Agent core.
    if (agent) {
      var ax = agent._cx - D.agent.w / 2 - minX, ay = agent._cy - D.agent.h / 2 - minY;
      var click = agent.slug ? ' onclick="window.location=\'/agents?agent=' + encodeURIComponent(agent.slug) + '\'"' : '';
      parts.push('<g class="lm-node agent ' + (agent.signal || 'idle') + '"' + click + '>');
      parts.push('<rect class="lm-box" x="' + ax + '" y="' + ay + '" width="' + D.agent.w + '" height="' + D.agent.h + '" rx="14" filter="url(#lmglow)"/>');
      parts.push('<circle class="lm-dot ' + (agent.signal || 'idle') + '" cx="' + (ax + 18) + '" cy="' + (ay + 20) + '" r="5" fill="var(--violet)"/>');
      parts.push('<text class="lm-title" x="' + (ax + 34) + '" y="' + (ay + 26) + '" font-size="14">' + esc(clip(agent.label, 26)) + '</text>');
      parts.push('<text class="lm-sub" x="' + (ax + 34) + '" y="' + (ay + 45) + '" font-size="10">' + esc(agent.sublabel) + '</text>');
      parts.push('</g>');
    }

    // Policy + tool branch nodes.
    steps.forEach(function (s) {
      (s.policies || []).forEach(function (po) { var n = byId[po.id]; if (n) pill(parts, n, n._cx - minX, n._cy - minY, D.policy, 'policy'); });
      (s.tools || []).forEach(function (t) { var n = byId[t.id]; if (n) pill(parts, n, n._cx - minX, n._cy - minY, D.tool, 'tool'); });
    });

    // Steps (drawn last so they sit above branch lines).
    steps.forEach(function (s, i) {
      var x = s._cx - D.step.w / 2 - minX, yy = s._cy - D.step.h / 2 - minY;
      parts.push('<g class="lm-node step ' + (s.signal || 'idle') + ' lm-step-' + (s.signal || 'idle') + '" onclick="lmStep(\'' + s.id + '\')">');
      parts.push('<rect class="lm-box" x="' + x + '" y="' + yy + '" width="' + D.step.w + '" height="' + D.step.h + '" rx="12"/>');
      parts.push('<line class="lm-dt ' + s.decisionType + '" x1="' + (x + 2) + '" y1="' + (yy + 8) + '" x2="' + (x + 2) + '" y2="' + (yy + D.step.h - 8) + '"/>');
      // order badge
      parts.push('<circle class="lm-orderbg" cx="' + (x + 22) + '" cy="' + (yy + D.step.h / 2) + '" r="12"/>');
      parts.push('<text class="lm-order" x="' + (x + 22) + '" y="' + (yy + D.step.h / 2 + 4) + '" text-anchor="middle" font-size="11">' + esc(s.order) + '</text>');
      parts.push('<text class="lm-title" x="' + (x + 44) + '" y="' + (yy + 28) + '" font-size="13.5">' + esc(clip(s.label, 24)) + '</text>');
      var sub = s.decisionType.replace('_', '-');
      parts.push('<text class="lm-sub" x="' + (x + 44) + '" y="' + (yy + 46) + '" font-size="10">' + esc(sub) + (s.engineSource ? ' · ' + clip(s.engineSource, 16) : '') + '</text>');
      // gate diamond / checkpoint marker (top-right)
      if (s.isGate) {
        var gx = x + D.step.w - 18, gy = yy + 16, r = 7;
        parts.push('<path class="lm-gate" d="M' + gx + ',' + (gy - r) + ' L' + (gx + r) + ',' + gy + ' L' + gx + ',' + (gy + r) + ' L' + (gx - r) + ',' + gy + ' Z"/>');
      }
      if (s.pauseAfter) {
        parts.push('<circle class="lm-check" cx="' + (x + D.step.w - 18) + '" cy="' + (yy + D.step.h - 16) + '" r="6.5"/>');
        parts.push('<text class="lm-sub" x="' + (x + D.step.w - 18) + '" y="' + (yy + D.step.h - 12.5) + '" text-anchor="middle" font-size="8" fill="var(--warn)">‖</text>');
      }
      parts.push('</g>');
    });

    paint(parts);
    window.lmStep = function (id) { openDrawer(byId[id]); };
  }

  function pill(parts, n, cx, cy, d, kind) {
    var x = cx - d.w / 2, y = cy - d.h / 2;
    var cls = kind + (n.engine ? ' engine' : '');
    parts.push('<g class="lm-node ' + cls + '">');
    parts.push('<rect class="lm-box" x="' + x + '" y="' + y + '" width="' + d.w + '" height="' + d.h + '" rx="10"/>');
    var tag = kind === 'policy' ? 'POLICY' : (n.engine ? 'ENGINE' : String(n.ttype || 'TOOL').toUpperCase());
    var tagCol = kind === 'policy' ? 'var(--accent)' : 'var(--violet)';
    parts.push('<text class="lm-tag" x="' + (x + 12) + '" y="' + (y + 17) + '" font-size="8" fill="' + tagCol + '">' + esc(tag) + '</text>');
    parts.push('<text class="lm-title" x="' + (x + 12) + '" y="' + (y + 35) + '" font-size="12">' + esc(clip(n.label, 22)) + '</text>');
    parts.push('</g>');
  }

  // ----------------------------------------------------------------- DRAWER
  function openDrawer(s) {
    if (!s) return;
    var body = document.getElementById('lm-drawer-body');
    var dt = s.decisionType.replace('_', '-');
    var h = '';
    h += '<h3>' + esc(s.label) + '</h3>';
    h += '<span class="dt-tag">step ' + esc(s.order) + ' · ' + esc(s.key) + '</span>';
    h += '<span class="dt-tag">' + esc(dt) + '</span>';
    if (s.isGate) h += '<span class="dt-tag" style="color:var(--warn)">GATE</span>';
    if (s.pauseAfter) h += '<span class="dt-tag" style="color:var(--warn)">HUMAN CHECKPOINT</span>';
    if (s.exec) h += '<span class="dt-tag" style="color:' + (sigStroke[s.signal] || 'var(--muted)') + '">RUN: ' + esc(String(s.exec.status).toUpperCase()) + '</span>';

    h += '<div class="sec"><h4>Policies (' + (s.policies || []).length + ')</h4>';
    if (!(s.policies || []).length) h += '<div class="row"><div class="meta">No step-scoped policies.</div></div>';
    (s.policies || []).forEach(function (p) {
      h += '<div class="row"><div class="nm">' + esc(p.label) + '</div><div class="meta">' + esc(p.key) + (p.version ? ' · v' + p.version : '') + '</div>';
      if (p.definition) h += '<div class="meta" style="margin-top:5px;color:var(--ink-2)">' + esc(p.definition) + '</div>';
      if (p.params && Object.keys(p.params).length) h += '<pre>' + esc(JSON.stringify(p.params, null, 2)) + '</pre>';
      h += '</div>';
    });
    h += '</div>';

    h += '<div class="sec"><h4>Tools &amp; engine (' + (s.tools || []).length + ')</h4>';
    if (!(s.tools || []).length) h += '<div class="row"><div class="meta">No tools bound.</div></div>';
    (s.tools || []).forEach(function (t) {
      h += '<div class="row"><div class="nm">' + esc(t.label) + '</div><div class="meta">' + esc(t.engine ? 'engine source' : (t.ttype || 'tool')) + (t.role ? ' · ' + esc(t.role) : '') + '</div></div>';
    });
    h += '</div>';

    if (s.exec && s.exec.outcome && Object.keys(s.exec.outcome).length) {
      h += '<div class="sec"><h4>Latest outcome</h4><pre>' + esc(JSON.stringify(s.exec.outcome, null, 2)) + '</pre></div>';
    }
    body.innerHTML = h;
    document.getElementById('lm-drawer').classList.add('open');
  }
  window.lmCloseDrawer = function () { var d = document.getElementById('lm-drawer'); if (d) d.classList.remove('open'); };

  // ------------------------------------------------------------- PAINT + NAV
  function paint(parts) {
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.innerHTML = parts.join('');
  }

  if (G.mode === 'schematic') renderSchematic(); else renderOverview();

  // Pan / zoom (shared).
  var scale = 1, tx = 0, ty = 0;
  function apply() { svg.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; }
  window.lmZoom = function (f) {
    var r = stage.getBoundingClientRect();
    var cx = r.width / 2, cy = r.height / 2;
    var ns = Math.min(2.5, Math.max(0.2, scale * f));
    tx = cx - (cx - tx) * (ns / scale); ty = cy - (cy - ty) * (ns / scale);
    scale = ns; apply();
  };
  window.lmFit = function () {
    svg.classList.add('no-anim');
    var r = stage.getBoundingClientRect();
    var s = Math.min(r.width / W, r.height / H) * 0.9;
    scale = Math.max(0.2, Math.min(1.4, s));
    tx = (r.width - W * scale) / 2; ty = (r.height - H * scale) / 2; apply();
    requestAnimationFrame(function () { svg.classList.remove('no-anim'); });
  };
  var dragging = false, sx = 0, sy = 0, otx = 0, oty = 0;
  stage.addEventListener('mousedown', function (e) {
    if (e.target.closest('.lm-node')) return;
    dragging = true; stage.classList.add('grabbing'); sx = e.clientX; sy = e.clientY; otx = tx; oty = ty;
    svg.classList.add('no-anim');
  });
  window.addEventListener('mousemove', function (e) { if (!dragging) return; tx = otx + (e.clientX - sx); ty = oty + (e.clientY - sy); apply(); });
  window.addEventListener('mouseup', function () { dragging = false; stage.classList.remove('grabbing'); svg.classList.remove('no-anim'); });
  stage.addEventListener('wheel', function (e) { e.preventDefault(); svg.classList.add('no-anim'); lmZoom(e.deltaY < 0 ? 1.08 : 0.93); svg.classList.remove('no-anim'); }, { passive: false });

  // Fly-in: scale toward the clicked process, then navigate to its schematic.
  window.lmFlyTo = function (el, url) {
    try {
      var bb = el.getBBox();
      var r = stage.getBoundingClientRect();
      var ns = Math.min(2.4, scale * 2.1);
      var ncx = (bb.x + bb.width / 2), ncy = (bb.y + bb.height / 2);
      tx = r.width / 2 - ncx * ns; ty = r.height / 2 - ncy * ns; scale = ns;
      svg.style.opacity = '0.25'; apply();
      setTimeout(function () { window.location = url; }, 260);
    } catch (e) { window.location = url; }
  };

  // BU/Area filter (overview) + jump-to-process (both modes).
  var bu = document.getElementById('lm-bu');
  if (bu) bu.addEventListener('change', function () {
    var v = this.value;
    svg.querySelectorAll('.lm-node[data-fn]').forEach(function (g) { g.classList.toggle('lm-dim', !!v && g.getAttribute('data-fn') !== v); });
  });
  var proc = document.getElementById('lm-proc');
  if (proc) proc.addEventListener('change', function () { if (this.value) window.location = '/processes/live/' + this.value; });

  lmFit();
})();
