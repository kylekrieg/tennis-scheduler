/* Stats charts (Kyle, 2026-09-25): win % over time (line) and average games
 * per match (columns / bars). Plain SVG, no library and no CDN, so it works
 * on the Pi exactly as everything else does. Data arrives as JSON in
 * <script type="application/json" id="stats-data">; every table the charts
 * draw from is also rendered server-side, so nothing here is required to
 * read the numbers. All text from data goes in via textContent.
 *
 * Colour: up to 8 players at once, one fixed slot each (never cycled) — the
 * slot stays with the player while they're selected, so toggling someone
 * else never repaints them. Slot colours are the --viz-s1..s8 CSS variables
 * (light + dark values, validated for colour-blind separation).
 */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var MAX_LINES = 8;

  var dataEl = document.getElementById('stats-data');
  if (!dataEl) return;
  var DATA;
  try { DATA = JSON.parse(dataEl.textContent); } catch (e) { return; }

  function svg(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function html(tag, cls, text, parent) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function pct(v) { return v == null ? '—' : (v * 100).toFixed(1) + '%'; }
  function fmtLabel(label, multiYear) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
    if (!m) return label;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString(undefined, multiYear ? { month: 'short', day: 'numeric', year: '2-digit' } : { month: 'short', day: 'numeric' });
  }

  // -------------------------------------------------------------------------
  // Win % line chart
  // -------------------------------------------------------------------------
  function initWinChart() {
    var root = document.getElementById('winpct-chart');
    var S = DATA.winSeries;
    if (!root || !S || !S.players.length || !S.labels.length) return;

    var multiYear = false;
    if (S.axis === 'date') {
      var yrs = {};
      S.labels.forEach(function (l) { yrs[l.slice(0, 4)] = 1; });
      multiYear = Object.keys(yrs).length > 1;
    }
    var xLabels = S.labels.map(function (l) { return fmtLabel(l, multiYear); });

    var mode = 'cumulative'; // or 'weekly'
    var slotOf = {};         // player id -> slot 1..8
    var selected = [];       // player ids, in the order they were added
    var byId = {};
    S.players.forEach(function (p) { byId[p.id] = p; });

    // Everyone is shown by default. The first 8 selected players get a fixed
    // colour slot; any beyond that are drawn in neutral grey (never a cycled
    // or invented hue) - their name and value are still in the tooltip/chips.
    function firstFreeSlot() {
      var used = {};
      selected.forEach(function (id) { if (slotOf[id]) used[slotOf[id]] = true; });
      for (var s = 1; s <= MAX_LINES; s++) if (!used[s]) return s;
      return null;
    }
    function select(id) {
      if (selected.indexOf(id) >= 0) return true;
      slotOf[id] = firstFreeSlot(); // null = grey
      selected.push(id);
      return true;
    }
    function lineColor(id) { return slotOf[id] ? 'var(--viz-s' + slotOf[id] + ')' : 'var(--viz-grey)'; }
    function deselect(id) {
      selected = selected.filter(function (x) { return x !== id; });
      delete slotOf[id];
    }
    function selectAll() {
      selected = [];
      slotOf = {};
      S.players.forEach(function (p) { select(p.id); });
    }
    function selectTop() {
      selected = [];
      slotOf = {};
      var ranked = S.players.filter(function (p) { return p.qualifiedAt !== null; });
      if (!ranked.length) ranked = S.players.slice().sort(function (a, b) { return b.matches - a.matches; });
      ranked.slice(0, MAX_LINES).forEach(function (p) { select(p.id); });
    }
    selectAll();

    var wrap = html('div', 'viz-wrap', null, root);
    var controls = html('div', 'viz-controls', null, wrap);
    var modeGroup = html('div', 'viz-seg', null, controls);
    var btnCum = html('button', 'viz-seg-btn', S.axis === 'week' ? 'Season to date' : 'Running total', modeGroup);
    var btnWk = html('button', 'viz-seg-btn', S.axis === 'week' ? 'Each week only' : 'Each match day only', modeGroup);
    btnCum.type = 'button'; btnWk.type = 'button';
    var plotHost = html('div', 'viz-plot', null, wrap);
    var tip = html('div', 'viz-tip', null, plotHost);
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    var legend = html('div', 'viz-legend', null, wrap);
    var legendHelp = html('p', 'muted viz-note', null, wrap);

    var W = 760, H = 360, M = { t: 14, b: 40, l: 46 };
    var hoverIdx = null;

    function render() {
      btnCum.setAttribute('aria-pressed', mode === 'cumulative');
      btnWk.setAttribute('aria-pressed', mode === 'weekly');
      btnCum.className = 'viz-seg-btn' + (mode === 'cumulative' ? ' on' : '');
      btnWk.className = 'viz-seg-btn' + (mode === 'weekly' ? ' on' : '');

      var labelEnds = selected.length > 0 && selected.length <= 4;
      var R = labelEnds ? 112 : 18;
      var iw = W - M.l - R, ih = H - M.t - M.b;
      var n = xLabels.length;
      function px(i) { return n === 1 ? M.l + iw / 2 : M.l + (iw * i) / (n - 1); }
      // Y range: fit the data (all players, not just the selected ones, so the
      // axis doesn't jump when someone is toggled), padded and rounded to
      // clean 5%/10% steps, and always clamped to 0-100%.
      var lo = 1, hi = 0;
      S.players.forEach(function (p) {
        (mode === 'cumulative' ? p.cumulative : p.weekly).forEach(function (v) {
          if (v == null) return;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        });
      });
      if (lo > hi) { lo = 0; hi = 1; }
      var tickStep = hi - lo <= 0.3 ? 0.05 : (hi - lo <= 0.6 ? 0.1 : 0.25);
      var yLo = Math.max(0, Math.floor((lo - 0.02) / tickStep) * tickStep);
      var yHi = Math.min(1, Math.ceil((hi + 0.02) / tickStep) * tickStep);
      if (yHi - yLo < 0.2) { yLo = Math.max(0, yLo - 0.05); yHi = Math.min(1, yHi + 0.05); }
      function py(v) { return M.t + ih * (1 - (v - yLo) / (yHi - yLo)); }

      plotHost.querySelectorAll('svg').forEach(function (e) { e.remove(); });
      var el = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'viz-svg', role: 'img', tabindex: '0',
        'aria-label': 'Line chart of ' + (mode === 'cumulative' ? 'cumulative' : 'weekly') + ' win percentage by player. Use the table below for exact values.' });
      plotHost.insertBefore(el, tip);

      // grid + y axis
      for (var tv = yLo; tv <= yHi + 1e-9; tv += tickStep) {
        var isBase = Math.abs(tv - yLo) < 1e-9;
        svg('line', { x1: M.l, x2: W - R, y1: py(tv), y2: py(tv), class: isBase ? 'viz-axis' : 'viz-grid' }, el);
        var tx = svg('text', { x: M.l - 8, y: py(tv) + 4, 'text-anchor': 'end', class: 'viz-tick' }, el);
        tx.textContent = Math.round(tv * 100) + '%';
      }
      // x labels (thin out when crowded)
      var step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 62))));
      for (var i = 0; i < n; i++) {
        var isLast = i === n - 1;
        if (!isLast && (i % step !== 0 || n - 1 - i < step)) continue;
        var t = svg('text', { x: px(i), y: H - M.b + 18, 'text-anchor': 'middle', class: 'viz-tick' }, el);
        t.textContent = xLabels[i];
      }

      // hover crosshair (under lines)
      var cross = svg('line', { y1: M.t, y2: M.t + ih, class: 'viz-cross', visibility: 'hidden' }, el);

      var showMarkers = n <= 24;
      // grey lines first so coloured ones sit on top
      var drawOrder = selected.filter(function (id) { return !slotOf[id]; })
        .concat(selected.filter(function (id) { return !!slotOf[id]; }));
      drawOrder.forEach(function (id) {
        var p = byId[id];
        var vals = mode === 'cumulative' ? p.cumulative : p.weekly;
        var color = lineColor(id);
        var pts = [];
        for (var j = 0; j < n; j++) if (vals[j] != null) pts.push(j);
        if (!pts.length) return;
        // Segments: dashed while the player is still under the min-matches
        // bar (cumulative mode only), solid after.
        for (var k = 1; k < pts.length; k++) {
          var a = pts[k - 1], b = pts[k];
          var building = mode === 'cumulative' && (p.qualifiedAt === null || b < p.qualifiedAt);
          svg('line', {
            x1: px(a), y1: py(vals[a]), x2: px(b), y2: py(vals[b]),
            stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round',
            'stroke-dasharray': building ? '2 5' : 'none', class: 'viz-line'
          }, el);
        }
        if (showMarkers || pts.length) {
          pts.forEach(function (j, idx) {
            if (!showMarkers && idx !== pts.length - 1) return;
            svg('circle', { cx: px(j), cy: py(vals[j]), r: 4, fill: color, class: 'viz-dot' }, el);
          });
        }
        if (labelEnds) {
          var last = pts[pts.length - 1];
          var lt = svg('text', { x: px(last) + 10, y: py(vals[last]) + 4, class: 'viz-endlabel' }, el);
          lt.textContent = p.name;
        }
      });

      // hit layer
      var hit = svg('rect', { x: M.l, y: M.t, width: iw, height: ih, fill: 'transparent', class: 'viz-hit' }, el);
      function showAt(i, clientX, clientY) {
        hoverIdx = i;
        cross.setAttribute('x1', px(i)); cross.setAttribute('x2', px(i));
        cross.setAttribute('visibility', 'visible');
        tip.textContent = '';
        html('div', 'viz-tip-title', xLabels[i], tip);
        var rows = selected.map(function (id) {
          var p = byId[id];
          return { p: p, v: (mode === 'cumulative' ? p.cumulative : p.weekly)[i] };
        }).filter(function (r) { return r.v != null; }).sort(function (a, b) { return b.v - a.v; });
        if (!rows.length) html('div', 'viz-tip-row muted', 'No scored matches for the selected players yet.', tip);
        rows.forEach(function (r) {
          var row = html('div', 'viz-tip-row', null, tip);
          var key = html('span', 'viz-key', null, row);
          key.style.background = lineColor(r.p.id);
          html('strong', 'viz-tip-val', pct(r.v), row);
          html('span', 'viz-tip-name', ' ' + r.p.name, row);
        });
        tip.hidden = false;
        var box = plotHost.getBoundingClientRect();
        var x = (clientX != null ? clientX - box.left : (px(i) / W) * box.width) + 14;
        var y = (clientY != null ? clientY - box.top : 24) + 8;
        var tw = tip.offsetWidth;
        if (x + tw > box.width - 4) x = Math.max(4, x - tw - 28);
        tip.style.left = x + 'px';
        tip.style.top = Math.max(4, Math.min(y, box.height - tip.offsetHeight - 4)) + 'px';
      }
      function hide() { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; hoverIdx = null; }
      function nearest(evt) {
        var r = el.getBoundingClientRect();
        var x = ((evt.clientX - r.left) / r.width) * W;
        var best = 0, bd = Infinity;
        for (var q = 0; q < n; q++) { var d = Math.abs(px(q) - x); if (d < bd) { bd = d; best = q; } }
        return best;
      }
      hit.addEventListener('pointermove', function (e) { showAt(nearest(e), e.clientX, e.clientY); });
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('pointerdown', function (e) { showAt(nearest(e), e.clientX, e.clientY); });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          var cur = hoverIdx == null ? (e.key === 'ArrowLeft' ? n : -1) : hoverIdx;
          var nx = Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowLeft' ? -1 : 1)));
          showAt(nx);
          e.preventDefault();
        } else if (e.key === 'Escape') { hide(); }
      });
      el.addEventListener('blur', hide);

      renderLegend();
    }

    function renderLegend() {
      legend.textContent = '';
      S.players.forEach(function (p) {
        var on = selected.indexOf(p.id) >= 0;
        var b = html('button', 'viz-chip' + (on ? ' on' : ''), null, legend);
        b.type = 'button';
        b.setAttribute('aria-pressed', on);
        var key = html('span', 'viz-key', null, b);
        if (on) key.style.background = lineColor(p.id);
        else key.className = 'viz-key off';
        html('span', 'viz-chip-name', p.name, b);
        html('span', 'viz-chip-val', pct(p.finalWinPct), b);
        b.addEventListener('click', function () {
          if (on) deselect(p.id); else select(p.id);
          render();
        });
      });
      var acts = html('div', 'viz-legend-actions', null, legend);
      var all = html('button', 'viz-link', 'Show all', acts); all.type = 'button';
      var top = html('button', 'viz-link', 'Show top ' + MAX_LINES, acts); top.type = 'button';
      var none = html('button', 'viz-link', 'Clear all', acts); none.type = 'button';
      all.addEventListener('click', function () { selectAll(); render(); });
      top.addEventListener('click', function () { selectTop(); render(); });
      none.addEventListener('click', function () { selected = []; slotOf = {}; render(); });
      legendHelp.textContent = 'Everyone is shown to start. Click a name to remove or add a line' + (S.players.length > MAX_LINES ? '; with more than ' + MAX_LINES + ' lines, the first ' + MAX_LINES + ' are coloured and the rest grey (hover for names)' : '') + '. Dotted line = still building a sample (fewer than ' + S.minMatches + ' matches scored). Chip numbers are each player’s overall win % for this view.';
    }

    btnCum.addEventListener('click', function () { mode = 'cumulative'; render(); });
    btnWk.addEventListener('click', function () { mode = 'weekly'; render(); });
    render();
  }

  // -------------------------------------------------------------------------
  // Average games per match (columns by week, or bars by session)
  // -------------------------------------------------------------------------
  function initGamesChart() {
    var root = document.getElementById('games-chart');
    var G = DATA.avgGames;
    if (!root || !G || !G.points.length) return;
    var wrap = html('div', 'viz-wrap', null, root);
    var host = html('div', 'viz-plot', null, wrap);
    var tip = html('div', 'viz-tip', null, host);
    tip.hidden = true;

    var pts = G.points;
    var max = Math.max.apply(null, pts.map(function (p) { return p.average; }).concat([G.average || 0]));
    var top = Math.max(5, Math.ceil(max / 5) * 5);
    var horizontal = G.mode === 'sessions';

    function showTip(p, evt, box) {
      tip.textContent = '';
      html('div', 'viz-tip-title', p.label, tip);
      var row = html('div', 'viz-tip-row', null, tip);
      html('strong', 'viz-tip-val', String(p.average), row);
      html('span', 'viz-tip-name', ' avg games per match', row);
      html('div', 'viz-tip-row muted', p.matches + ' match' + (p.matches === 1 ? '' : 'es') + ' scored', tip);
      tip.hidden = false;
      var b = host.getBoundingClientRect();
      var x = (evt.clientX - b.left) + 14, y = (evt.clientY - b.top) + 8;
      if (x + tip.offsetWidth > b.width - 4) x = Math.max(4, x - tip.offsetWidth - 28);
      tip.style.left = x + 'px';
      tip.style.top = Math.max(4, Math.min(y, b.height - tip.offsetHeight - 4)) + 'px';
    }
    function hideTip() { tip.hidden = true; }

    if (!horizontal) {
      var multiYear = false;
      var W = 760, H = 320, M = { t: 24, b: 40, l: 46, r: 18 };
      var el = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'viz-svg', role: 'img',
        'aria-label': 'Column chart of average games played per match, by week. Use the table below for exact values.' }, host);
      host.insertBefore(el, tip);
      var iw = W - M.l - M.r, ih = H - M.t - M.b;
      function yv(v) { return M.t + ih * (1 - v / top); }
      for (var t = 0; t <= top; t += top / 5) {
        svg('line', { x1: M.l, x2: W - M.r, y1: yv(t), y2: yv(t), class: t === 0 ? 'viz-axis' : 'viz-grid' }, el);
        var tx = svg('text', { x: M.l - 8, y: yv(t) + 4, 'text-anchor': 'end', class: 'viz-tick' }, el);
        tx.textContent = String(Math.round(t * 10) / 10);
      }
      var slot = iw / pts.length;
      var bw = Math.min(24, slot * 0.6);
      pts.forEach(function (p, i) {
        var cx = M.l + slot * i + slot / 2;
        var x = cx - bw / 2, y = yv(p.average), h = yv(0) - y, r = Math.min(4, bw / 2, h);
        var path = 'M' + x + ',' + yv(0) + ' V' + (y + r) + ' Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
          ' H' + (x + bw - r) + ' Q' + (x + bw) + ',' + y + ' ' + (x + bw) + ',' + (y + r) + ' V' + yv(0) + ' Z';
        var bar = svg('path', { d: path, fill: 'var(--viz-s1)', class: 'viz-bar', tabindex: '0',
          'aria-label': p.label + ': ' + p.average + ' games per match' }, el);
        // hit area wider than the mark
        var hit = svg('rect', { x: cx - slot / 2, y: M.t, width: slot, height: ih, fill: 'transparent' }, el);
        hit.addEventListener('pointermove', function (e) { bar.classList.add('hot'); showTip(p, e); });
        hit.addEventListener('pointerleave', function () { bar.classList.remove('hot'); hideTip(); });
        bar.addEventListener('focus', function () { var r0 = bar.getBoundingClientRect(); showTip(p, { clientX: r0.left + r0.width / 2, clientY: r0.top }); });
        bar.addEventListener('blur', hideTip);
        var v = svg('text', { x: cx, y: y - 6, 'text-anchor': 'middle', class: 'viz-value' }, el);
        v.textContent = String(p.average);
        if (pts.length <= 14 || i % Math.ceil(pts.length / 14) === 0) {
          var lab = svg('text', { x: cx, y: H - 16, 'text-anchor': 'middle', class: 'viz-tick' }, el);
          lab.textContent = p.label.replace(/^Week /, 'Wk ');
        }
      });
      if (G.average != null) {
        svg('line', { x1: M.l, x2: W - M.r, y1: yv(G.average), y2: yv(G.average), class: 'viz-ref' }, el);
        var rl = svg('text', { x: W - M.r, y: yv(G.average) - 5, 'text-anchor': 'end', class: 'viz-reflabel' }, el);
        rl.textContent = 'Overall average ' + G.average;
      }
    } else {
      var rowH = 34;
      var W2 = 760, M2 = { t: 10, b: 30, l: 190, r: 46 };
      var H2 = M2.t + M2.b + rowH * pts.length;
      var el2 = svg('svg', { viewBox: '0 0 ' + W2 + ' ' + H2, class: 'viz-svg', role: 'img',
        'aria-label': 'Bar chart of average games played per match, by session. Use the table below for exact values.' }, host);
      host.insertBefore(el2, tip);
      var iw2 = W2 - M2.l - M2.r;
      function xv(v) { return M2.l + iw2 * (v / top); }
      for (var t2 = 0; t2 <= top; t2 += top / 5) {
        svg('line', { x1: xv(t2), x2: xv(t2), y1: M2.t, y2: H2 - M2.b, class: t2 === 0 ? 'viz-axis' : 'viz-grid' }, el2);
        var tt = svg('text', { x: xv(t2), y: H2 - 10, 'text-anchor': 'middle', class: 'viz-tick' }, el2);
        tt.textContent = String(Math.round(t2 * 10) / 10);
      }
      pts.forEach(function (p, i) {
        var cy = M2.t + rowH * i + rowH / 2;
        var bh = 18, w = Math.max(1, xv(p.average) - M2.l), r = Math.min(4, bh / 2, w);
        var y0 = cy - bh / 2;
        var path = 'M' + M2.l + ',' + y0 + ' H' + (M2.l + w - r) + ' Q' + (M2.l + w) + ',' + y0 + ' ' + (M2.l + w) + ',' + (y0 + r) +
          ' V' + (y0 + bh - r) + ' Q' + (M2.l + w) + ',' + (y0 + bh) + ' ' + (M2.l + w - r) + ',' + (y0 + bh) + ' H' + M2.l + ' Z';
        var bar = svg('path', { d: path, fill: 'var(--viz-s1)', class: 'viz-bar', tabindex: '0',
          'aria-label': p.label + ': ' + p.average + ' games per match' }, el2);
        var hit = svg('rect', { x: 0, y: cy - rowH / 2, width: W2, height: rowH, fill: 'transparent' }, el2);
        hit.addEventListener('pointermove', function (e) { bar.classList.add('hot'); showTip(p, e); });
        hit.addEventListener('pointerleave', function () { bar.classList.remove('hot'); hideTip(); });
        bar.addEventListener('focus', function () { var r0 = bar.getBoundingClientRect(); showTip(p, { clientX: r0.left + r0.width / 2, clientY: r0.top }); });
        bar.addEventListener('blur', hideTip);
        var name = svg('text', { x: M2.l - 10, y: cy + 4, 'text-anchor': 'end', class: 'viz-cat' }, el2);
        name.textContent = p.label.length > 26 ? p.label.slice(0, 25) + '…' : p.label;
        var v = svg('text', { x: M2.l + w + 8, y: cy + 4, class: 'viz-value' }, el2);
        v.textContent = String(p.average);
      });
    }
  }

  initWinChart();
  initGamesChart();
})();
