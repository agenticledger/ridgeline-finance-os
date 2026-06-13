/* Live Map — hand-rolled layered layout + SVG particle animation. No external libs.
 * Reads window.LM_GRAPH = { nodes:[{id,type,col,signal,label,sublabel,slug,...}], edges:[{from,to,signal}] }.
 * Columns: 0 Org, 1 Sub-function, 2 Process, 3 Agent. The "living" feel is SVG
 * <animateMotion> particles riding each edge; pace/brightness keyed to signal. */
(function () {
  var G = window.LM_GRAPH || { nodes: [], edges: [] };
  var svg = document.getElementById('lm-svg');
  var stage = document.getElementById('lm-stage');

  // Node box dimensions per type.
  var DIM = {
    org: { w: 170, h: 62 }, function: { w: 184, h: 58 },
    process: { w: 210, h: 70 }, agent: { w: 168, h: 50 },
  };
  var COL_X = [60, 360, 700, 1040];
  var ROW = 96;        // vertical pitch for process rows
  var PAD = 60;

  var byId = {};
  G.nodes.forEach(function (n) { byId[n.id] = n; });

  // 1) Lay out process rows in source order, stacked top→bottom.
  var procs = G.nodes.filter(function (n) { return n.type === 'process'; });
  procs.forEach(function (n, i) { n._y = PAD + i * ROW; n._x = COL_X[2]; });

  // 2) Children map for centering parents on their children.
  var childY = {};
  G.edges.forEach(function (e) {
    (childY[e.from] = childY[e.from] || []).push(e.to);
  });
  function avgChildY(id) {
    var kids = (childY[id] || []).map(function (cid) { return byId[cid] && byId[cid]._y; })
      .filter(function (v) { return typeof v === 'number'; });
    if (!kids.length) return PAD;
    return kids.reduce(function (a, b) { return a + b; }, 0) / kids.length;
  }

  // 3) Function nodes centered on their processes.
  G.nodes.filter(function (n) { return n.type === 'function'; }).forEach(function (n) {
    n._y = avgChildY(n.id); n._x = COL_X[1];
  });
  // 4) Org centered on functions.
  G.nodes.filter(function (n) { return n.type === 'org'; }).forEach(function (n) {
    n._y = avgChildY(n.id); n._x = COL_X[0];
  });
  // 5) Agents: centered on the processes that point at them, then de-overlap.
  var parentY = {};
  G.edges.forEach(function (e) {
    if (byId[e.to] && byId[e.to].type === 'agent') (parentY[e.to] = parentY[e.to] || []).push(byId[e.from]._y);
  });
  var agents = G.nodes.filter(function (n) { return n.type === 'agent'; });
  agents.forEach(function (n) {
    var ys = parentY[n.id] || [PAD];
    n._y = ys.reduce(function (a, b) { return a + b; }, 0) / ys.length; n._x = COL_X[3];
  });
  agents.sort(function (a, b) { return a._y - b._y; });
  for (var i = 1; i < agents.length; i++) {
    if (agents[i]._y - agents[i - 1]._y < 70) agents[i]._y = agents[i - 1]._y + 70;
  }

  // Bounds → viewBox.
  var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  G.nodes.forEach(function (n) {
    var d = DIM[n.type];
    minX = Math.min(minX, n._x); minY = Math.min(minY, n._y - d.h / 2);
    maxX = Math.max(maxX, n._x + d.w); maxY = Math.max(maxY, n._y + d.h / 2);
  });
  var W = (maxX - minX) + PAD * 2, H = (maxY - minY) + PAD * 2;
  var OX = -minX + PAD, OY = -minY + PAD;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // ---- Build SVG ----
  var parts = [];
  parts.push('<defs>' +
    '<filter id="lmglow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
    '</defs>');

  var sigStroke = { idle: 'var(--muted)', live: 'var(--accent)', attention: 'var(--warn)', posted: 'var(--good)' };
  var sigPace = { idle: 5.5, live: 1.9, posted: 3.4, attention: 2.6 };
  var sigCount = { idle: 1, live: 3, posted: 2, attention: 2 };

  // Edges + particles.
  G.edges.forEach(function (e, idx) {
    var a = byId[e.from], b = byId[e.to];
    if (!a || !b) return;
    var da = DIM[a.type], db = DIM[b.type];
    var x1 = a._x + da.w + OX, y1 = a._y + OY;
    var x2 = b._x + OX, y2 = b._y + OY;
    var mx = (x1 + x2) / 2;
    var d = 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2;
    var pid = 'p' + idx;
    parts.push('<path id="' + pid + '" class="lm-edge ' + e.signal + '" d="' + d + '"/>');
    var col = sigStroke[e.signal] || sigStroke.idle;
    var dur = sigPace[e.signal] || 5;
    var n = sigCount[e.signal] || 1;
    for (var k = 0; k < n; k++) {
      var begin = (dur / n * k).toFixed(2);
      parts.push('<circle r="3" fill="' + col + '" filter="url(#lmglow)" opacity="' + (e.signal === 'idle' ? 0.5 : 0.95) + '">' +
        '<animateMotion dur="' + dur + 's" repeatCount="indefinite" begin="' + begin + 's"><mpath href="#' + pid + '"/></animateMotion></circle>');
    }
  });

  // Nodes.
  G.nodes.forEach(function (n) {
    var d = DIM[n.type];
    var x = n._x + OX, y = (n._y + OY) - d.h / 2;
    var nav = n.type === 'process' ? ('/process/' + n.slug + '/monitor') : (n.type === 'agent' ? '/agents' : '');
    var click = nav ? ' onclick="window.location=\'' + nav + '\'"' : '';
    parts.push('<g class="lm-node ' + n.type + ' ' + (n.signal || 'idle') + '"' + click + '>');
    parts.push('<rect class="lm-box" x="' + x + '" y="' + y + '" width="' + d.w + '" height="' + d.h + '" rx="12"/>');
    if (n.type === 'process' || n.type === 'function' || n.type === 'org') {
      parts.push('<circle class="lm-dot ' + (n.signal || 'idle') + '" cx="' + (x + 14) + '" cy="' + (y + 16) + '" r="4.5" fill="' + (sigStroke[n.signal] || sigStroke.idle) + '"/>');
    }
    var tx = x + (n.type === 'agent' ? 16 : 28);
    parts.push('<text class="lm-title" x="' + tx + '" y="' + (y + 26) + '" font-size="' + (n.type === 'process' ? 14 : 13) + '">' + esc(clip(n.label, n.type === 'process' ? 22 : 20)) + '</text>');
    if (n.sublabel) parts.push('<text class="lm-sub" x="' + tx + '" y="' + (y + 44) + '" font-size="10.5">' + esc(n.sublabel) + '</text>');
    if (n.type === 'process') {
      parts.push('<text class="lm-tag" x="' + (x + d.w - 12) + '" y="' + (y + 26) + '" text-anchor="end" font-size="9.5" fill="' + (sigStroke[n.signal] || sigStroke.idle) + '">' + esc((n.signal || 'idle').toUpperCase()) + '</text>');
      if (n.frequency) parts.push('<text class="lm-sub" x="' + (x + d.w - 12) + '" y="' + (y + 44) + '" text-anchor="end" font-size="10">' + esc(n.frequency + ' · ' + n.mode) + '</text>');
    }
    parts.push('</g>');
  });

  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.innerHTML = parts.join('');

  // ---- Pan / zoom ----
  var scale = 1, tx = 0, ty = 0;
  function apply() { svg.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; }
  window.lmZoom = function (f) {
    var r = stage.getBoundingClientRect();
    var cx = r.width / 2, cy = r.height / 2;
    var ns = Math.min(2.5, Math.max(0.25, scale * f));
    tx = cx - (cx - tx) * (ns / scale); ty = cy - (cy - ty) * (ns / scale);
    scale = ns; apply();
  };
  window.lmFit = function () {
    var r = stage.getBoundingClientRect();
    var s = Math.min(r.width / W, r.height / H) * 0.92;
    scale = Math.max(0.25, Math.min(1.4, s));
    tx = (r.width - W * scale) / 2; ty = (r.height - H * scale) / 2; apply();
  };
  var dragging = false, sx = 0, sy = 0, otx = 0, oty = 0;
  stage.addEventListener('mousedown', function (e) {
    if (e.target.closest('.lm-node')) return; // let node clicks through
    dragging = true; stage.classList.add('grabbing'); sx = e.clientX; sy = e.clientY; otx = tx; oty = ty;
  });
  window.addEventListener('mousemove', function (e) {
    if (!dragging) return; tx = otx + (e.clientX - sx); ty = oty + (e.clientY - sy); apply();
  });
  window.addEventListener('mouseup', function () { dragging = false; stage.classList.remove('grabbing'); });
  stage.addEventListener('wheel', function (e) { e.preventDefault(); lmZoom(e.deltaY < 0 ? 1.08 : 0.93); }, { passive: false });

  lmFit();
})();
