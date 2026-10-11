/* Page behaviour for the control page (ui/index.html) and for the REST API Playground on tinypdf.in.
   Depends on sim-core.js (window.TinySim). When the local server serves the page it sets window.TINY_MOCK. */
(function () {
  'use strict';
  var S = window.TinySim;
  if (!S) return;

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var fmt = S.fmtMs;

  var BOOT = window.TINY_MOCK || null;              // set when the local server serves this page
  var PKG = 'tinypdf-mock', DEFAULT_LOCAL = 'http://localhost:4747';
  var server = S.newServerState();
  var rows = [];
  var routes = [];                                  // mock routes as edited: text fields, cleaned on use
  var running = false, liveRun = false, abortCtl = null, codeLang = 'curl';
  var target = 'sim';
  var local = { on: false, base: '', token: '', es: null, id: 'c' + Math.random().toString(36).slice(2, 10), log: [], selected: null, pushTimer: null, pushing: null, state: null };
  var simKeep = { latency: { baseMs: 120, jitterMs: 40 } };

  var PRESETS = [
    ['Authorization: Bearer secret123 (valid in the simulator)', 'Authorization', 'Bearer secret123'],
    ['Authorization: Bearer wrong-token', 'Authorization', 'Bearer wrong-token'],
    ['Content-Type: application/json', 'Content-Type', 'application/json'],
    ['Content-Type: text/plain', 'Content-Type', 'text/plain'],
    ['Accept: application/json', 'Accept', 'application/json'],
    ['Accept: application/xml (simulator answers 406)', 'Accept', 'application/xml'],
    ['Idempotency-Key', 'Idempotency-Key', 'order-123'],
    ['If-None-Match: W/"items-1"', 'If-None-Match', 'W/"items-1"'],
    ['Cache-Control: no-cache', 'Cache-Control', 'no-cache'],
    ['Cookie (browsers block this)', 'Cookie', 'session=abc123'],
    ['X-Request-ID', 'X-Request-ID', 'demo-1']
  ];
  var STRAT_HELP = {
    none: 'Fail on the first error. No retries.',
    fixed: 'Wait the same time before every retry.',
    linear: 'Wait base x retry number: 0.5 s, 1 s, 1.5 s, and so on.',
    exponential: 'Double the wait each time: 0.5 s, 1 s, 2 s, up to the max delay.',
    'full-jitter': 'Wait a random time between 0 and the exponential value. Spreads out many clients that failed together.',
    'equal-jitter': 'Wait half the exponential value plus a random share of the other half.'
  };

  function numVal(id, d) { var v = parseFloat($(id).value); return isNaN(v) ? d : v; }

  /* ---------- headers table ---------- */
  function renderHeaders() {
    var tb = $('ap-hdr-body');
    tb.innerHTML = '';
    rows.forEach(function (r, i) {
      var tr = document.createElement('tr');
      tr.setAttribute('data-i', i);
      tr.innerHTML =
        '<td><input type="checkbox" class="h-on" aria-label="Send this header"' + (r.enabled !== false ? ' checked' : '') + '></td>' +
        '<td><input type="text" class="h-name" spellcheck="false" autocomplete="off" aria-label="Header name" value="' + esc(r.name) + '"></td>' +
        '<td><input type="text" class="h-val" spellcheck="false" autocomplete="off" aria-label="Header value" value="' + esc(r.value) + '"></td>' +
        '<td class="h-end"><span class="ap-blocked" hidden title="Browsers refuse to set this header, so it would not be sent.">blocked</span><button type="button" class="ap-x" aria-label="Remove header">&times;</button></td>';
      tb.appendChild(tr);
      updateBlocked(tr, r);
    });
  }
  function updateBlocked(tr, r) {
    var bad = target !== 'local' && r.name && S.isForbiddenHeader(r.name);
    tr.querySelector('.ap-blocked').hidden = !bad;
  }
  function addHeader(name, value) {
    var existing = rows.filter(function (r) { return r.name.toLowerCase() === name.toLowerCase(); })[0];
    if (existing) { existing.value = value; existing.enabled = true; }
    else rows.push({ name: name, value: value, enabled: true });
    renderHeaders();
  }

  /* ---------- fault fields ---------- */
  function faultDef(type) { return S.FAULTS.filter(function (f) { return f.type === type; })[0] || S.FAULTS[0]; }
  function renderFaultFields(type, vals) {
    var f = faultDef(type), box = $('ap-fault-fields');
    box.innerHTML = '';
    f.fields.forEach(function (fd) {
      var id = 'ap-f-' + fd.key;
      var v = vals && vals[fd.key] != null ? vals[fd.key] : fd.def;
      var html = '<label for="' + id + '">' + esc(fd.label) + '</label>';
      if (fd.options) {
        html += '<select id="' + id + '" data-key="' + fd.key + '">' + fd.options.map(function (o) {
          return '<option' + (String(o) === String(v) ? ' selected' : '') + '>' + o + '</option>';
        }).join('') + '</select>';
      } else {
        html += '<input id="' + id + '" data-key="' + fd.key + '" type="number" min="' + fd.min + '" max="' + fd.max + '" value="' + esc(v) + '"' + (fd.optional ? ' placeholder="none"' : '') + '>';
      }
      var d = document.createElement('div');
      d.className = 'ap-field';
      d.innerHTML = html;
      box.appendChild(d);
    });
    $('ap-fault-help').textContent = f.help || '';
  }

  /* ---------- read / apply the whole form ---------- */
  function readCfg() {
    var fault = readFault();
    return {
      target: target, localBase: local.base || DEFAULT_LOCAL,
      realTime: $('ap-realtime').checked,
      seed: parseInt($('ap-seed').value, 10) || 0,
      request: {
        method: $('ap-method').value, url: $('ap-url').value,
        headers: rows.map(function (r) { return { name: r.name, value: r.value, enabled: r.enabled !== false }; }),
        body: $('ap-body').value
      },
      fault: fault,
      latency: { baseMs: numVal('ap-lat', 120), jitterMs: numVal('ap-jit', 40) },
      policy: {
        strategy: $('ap-strategy').value, baseMs: numVal('ap-base', 500), factor: numVal('ap-factor', 2),
        maxMs: numVal('ap-max-delay', 30000), maxAttempts: numVal('ap-attempts', 4), timeoutMs: numVal('ap-timeout', 3000),
        retryOn: { s5xx: $('ap-on-5xx').checked, s429: $('ap-on-429').checked, s408: $('ap-on-408').checked, network: $('ap-on-network').checked, timeout: $('ap-on-timeout').checked },
        honorRetryAfter: $('ap-honor-ra').checked, safeRetry: $('ap-safe').checked
      }
    };
  }
  function readFault() {
    var fault = { type: $('ap-fault').value };
    document.querySelectorAll('#ap-fault-fields [data-key]').forEach(function (el) { fault[el.getAttribute('data-key')] = el.value; });
    if (target === 'local' && $('ap-fault-path').value.trim()) fault.path = $('ap-fault-path').value.trim();
    return fault;
  }
  function simUrlFor(url) {
    /* Examples and shared links are written for the simulator; in Local server mode they go to the mock. */
    if (target === 'local' && String(url).indexOf(S.SIM_ORIGIN) === 0) return (local.base || DEFAULT_LOCAL) + String(url).slice(S.SIM_ORIGIN.length);
    return url;
  }
  function applyCfg(cfg, keepTarget) {
    if (!keepTarget) setTarget(cfg.target || 'sim', true);
    $('ap-method').value = cfg.request.method;
    $('ap-url').value = simUrlFor(cfg.request.url);
    rows = cfg.request.headers.map(function (h) { return { name: h.name, value: h.value, enabled: h.enabled !== false }; });
    renderHeaders();
    $('ap-body').value = cfg.request.body || '';
    $('ap-fault').value = cfg.fault.type;
    renderFaultFields(cfg.fault.type, cfg.fault);
    if (target !== 'local') { $('ap-lat').value = cfg.latency.baseMs; $('ap-jit').value = cfg.latency.jitterMs; }
    $('ap-seed').value = cfg.seed; $('ap-realtime').checked = !!cfg.realTime;
    var p = cfg.policy;
    $('ap-strategy').value = p.strategy; $('ap-base').value = p.baseMs; $('ap-factor').value = p.factor;
    $('ap-max-delay').value = p.maxMs; $('ap-attempts').value = p.maxAttempts; $('ap-timeout').value = p.timeoutMs;
    $('ap-on-5xx').checked = !!p.retryOn.s5xx; $('ap-on-429').checked = !!p.retryOn.s429; $('ap-on-408').checked = !!p.retryOn.s408;
    $('ap-on-network').checked = !!p.retryOn.network; $('ap-on-timeout').checked = !!p.retryOn.timeout;
    $('ap-honor-ra').checked = !!p.honorRetryAfter; $('ap-safe').checked = !!p.safeRetry;
    syncPolicyUi();
  }
  function syncPolicyUi() {
    var s = $('ap-strategy').value, none = s === 'none';
    ['ap-base', 'ap-attempts', 'ap-max-delay'].forEach(function (id) { $(id).disabled = none; });
    $('ap-factor').disabled = !(s === 'exponential' || s === 'full-jitter' || s === 'equal-jitter');
    $('ap-strategy-help').textContent = STRAT_HELP[s] || '';
  }
  function setTarget(t, quiet) {
    if (t !== 'sim' && t !== 'local' && t !== 'real') t = 'sim';
    var was = target;
    if (was === 'sim' && t !== 'sim') simKeep.latency = { baseMs: numVal('ap-lat', 120), jitterMs: numVal('ap-jit', 40) };
    target = t;
    var radio = document.querySelector('input[name="ap-target"][value="' + t + '"]');
    if (radio) radio.checked = true;
    document.querySelectorAll('[data-sim-only]').forEach(function (el) { el.hidden = (t !== 'sim'); });
    document.querySelectorAll('[data-real-only]').forEach(function (el) { el.hidden = (t !== 'real'); });
    document.querySelectorAll('[data-local-only]').forEach(function (el) { el.hidden = (t !== 'local'); });
    document.querySelectorAll('[data-mock-only]').forEach(function (el) { el.hidden = (t === 'real'); });
    $('ap').classList.toggle('is-local', t === 'local');
    $('ap-reset-server').textContent = t === 'local' ? 'Reset server data' : 'Reset simulated server';
    var localBase = local.base || DEFAULT_LOCAL;
    if (!quiet) {
      var u = $('ap-url').value;
      var onSim = u.indexOf(S.SIM_ORIGIN) === 0, onLocal = u.indexOf(localBase) === 0;
      if (t === 'real' && (onSim || (was === 'local' && onLocal))) $('ap-url').value = '';
      if (t === 'sim' && !onSim) $('ap-url').value = S.SIM_ORIGIN + (onLocal ? u.slice(localBase.length) || '/items' : '/items');
      if (t === 'local' && (onSim || !u)) $('ap-url').value = localBase + (onSim ? u.slice(S.SIM_ORIGIN.length) || '/items' : '/items');
    }
    $('ap-url').placeholder = t === 'real' ? 'https://your-api.example.com/health' : t === 'local' ? localBase + '/items' : S.SIM_ORIGIN + '/items';
    if (t === 'sim' && was !== 'sim') { $('ap-lat').value = simKeep.latency.baseMs; $('ap-jit').value = simKeep.latency.jitterMs; syncSimServer(); }
    if (t === 'local') { renderLocal(); if (local.state) applyServerState(local.state); }
    renderHeaders();
  }

  /* ---------- rendering ---------- */
  function badgeFor(r) {
    if (r.kind === 'response') {
      var cls = r.status < 300 ? 'ok' : r.status < 400 ? 'info' : r.status < 500 ? 'warn' : 'bad';
      return '<span class="ap-badge ap-b-' + cls + '">HTTP ' + r.status + '</span>';
    }
    if (r.kind === 'timeout') return '<span class="ap-badge ap-b-warn">Timed out</span>';
    if (r.kind === 'bodyError') return '<span class="ap-badge ap-b-bad">Body cut off</span>';
    return '<span class="ap-badge ap-b-bad">Connection failed</span>';
  }
  function segClass(r) {
    if (r.kind === 'response' && r.status < 400) return 'ok';
    return r.kind === 'timeout' ? 'timeout' : 'fail';
  }
  function labelFor(r) {
    return r.kind === 'response' ? 'HTTP ' + r.status : r.kind === 'timeout' ? 'Timed out' : r.kind === 'bodyError' ? 'Body cut off' : 'Connection failed';
  }
  function timelineHtml(attempts) {
    if (!attempts.length) return '';
    var segs = '', cursor = 0;
    attempts.forEach(function (r) {
      if (r.startMs > cursor) segs += '<span class="ap-tl-wait" style="flex:' + (r.startMs - cursor) + ' 1 0" title="Waiting ' + fmt(r.startMs - cursor) + '"></span>';
      segs += '<span class="ap-tl-' + segClass(r) + '" style="flex:' + Math.max(r.durationMs, 1) + ' 1 0" title="Attempt ' + r.n + ': ' + esc(labelFor(r)) + ' (' + fmt(r.durationMs) + ')"></span>';
      cursor = r.startMs + r.durationMs;
    });
    return '<div class="ap-tl" role="img" aria-label="Timeline of ' + attempts.length + ' attempt' + (attempts.length === 1 ? '' : 's') + ' over ' + fmt(cursor) + '">' + segs + '</div>' +
      '<div class="ap-tl-scale"><span>0</span><span>' + fmt(cursor) + '</span></div>';
  }
  function nextText(r) {
    switch (r.decision) {
      case 'success': return 'Done';
      case 'retry': return 'Wait ' + fmt(r.waitMs) + (r.waitReason === 'retry-after' ? ' (Retry-After)' : ' (backoff)') + ', then retry';
      case 'nonretryable': return 'Stop: not retryable';
      case 'unsafe': return 'Stop: unsafe to retry';
      case 'cap': return 'Stop: Retry-After too long';
      case 'max': return r.reason === 'retries are off' ? 'Stop: retries are off' : 'Stop: attempts used up';
      default: return '';
    }
  }
  function attemptsRows(attempts) {
    return attempts.map(function (r) {
      return '<tr><td>' + r.n + '</td><td>' + fmt(r.startMs) + '</td><td>' + fmt(r.durationMs) + '</td><td>' + badgeFor(r) + '</td><td>' + esc(nextText(r)) + '</td></tr>';
    }).join('');
  }
  function summaryHtml(res) {
    var n = res.attempts.length, plural = n === 1 ? '' : 's';
    switch (res.outcome) {
      case 'success': return '<span class="ap-badge ap-b-ok">Succeeded</span> on attempt ' + n + ' &middot; ' + fmt(res.totalMs) + ' in total';
      case 'not-retried': return '<span class="ap-badge ap-b-warn">Not retried</span> after ' + n + ' attempt' + plural + ' &middot; ' + fmt(res.totalMs);
      case 'cancelled': return '<span class="ap-badge ap-b-info">Cancelled</span> after ' + n + ' attempt' + plural;
      default: return '<span class="ap-badge ap-b-bad">Failed</span> after ' + n + ' attempt' + plural + ' &middot; ' + fmt(res.totalMs) + ' in total';
    }
  }
  function prettyBody(text) {
    if (!text) return '';
    var t = text;
    try { t = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* show raw */ }
    return t.length > 20000 ? t.slice(0, 20000) + '\n... (truncated for display)' : t;
  }
  function responseHtml(r) {
    if (!r) return '<p class="ap-dim">No response yet.</p>';
    var h = '';
    if (r.kind === 'response' || r.kind === 'bodyError') {
      h += '<div class="ap-resp-line">' + badgeFor(r) + ' <b>' + esc(S.STATUS_TEXT[r.status] || '') + '</b> <span class="ap-dim">' + fmt(r.durationMs) + '</span></div>';
      var keys = Object.keys(r.headers || {});
      if (keys.length) {
        h += '<table class="ap-table ap-hdrs"><tbody>' + keys.map(function (k) { return '<tr><th scope="row">' + esc(k) + '</th><td>' + esc(r.headers[k]) + '</td></tr>'; }).join('') + '</tbody></table>';
      }
      if (r.kind === 'bodyError') h += '<p class="ap-dim">Only part of the body arrived before the connection closed:</p>';
      h += r.body ? '<pre class="ap-pre">' + esc(prettyBody(r.body)) + '</pre>' : '<p class="ap-dim">No body.</p>';
    } else if (r.kind === 'timeout') {
      h += '<p>' + badgeFor(r) + ' ' + esc(r.message || 'No response arrived in time.') + '</p>';
    } else {
      h += '<p>' + badgeFor(r) + ' ' + esc(r.message || 'No response received.') + '</p>';
    }
    return h;
  }
  function seenHtml(res, cfg) {
    if (cfg.target !== 'sim' || !res.seen) return '';
    var h = '<p class="ap-dim">These are the headers the simulated server received. Headers browsers refuse to set never reach it.</p>';
    h += '<pre class="ap-pre">' + esc(JSON.stringify(res.seen.headers, null, 2)) + '</pre>';
    if (res.seen.dropped.length) {
      h += '<p><b>Dropped before sending:</b> ' + res.seen.dropped.map(function (d) { return '<code>' + esc(d.name) + '</code> (' + (d.reason === 'forbidden' ? 'forbidden header' : 'invalid name') + ')'; }).join(', ') + '</p>';
    }
    h += '<p class="ap-dim">Simulated server now holds ' + res.server.items.length + ' items' + (res.createdDuring ? ', ' + res.createdDuring + ' created by this run' : '') + '.</p>';
    return h;
  }
  function renderPartial(attempts) {
    $('ap-timeline').innerHTML = timelineHtml(attempts);
    $('ap-attempts-body').innerHTML = attemptsRows(attempts);
    $('ap-status').innerHTML = '<span class="ap-badge ap-b-info">Running</span> attempt ' + attempts.length + ' finished&hellip;';
  }
  function renderResult(res, cfg) {
    $('ap-status').innerHTML = summaryHtml(res);
    $('ap-timeline').innerHTML = timelineHtml(res.attempts);
    $('ap-attempts-body').innerHTML = attemptsRows(res.attempts);
    $('ap-attempts').hidden = !res.attempts.length;
    $('ap-notes').innerHTML = res.notes.length ? '<h3>What happened</h3><ul>' + res.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '';
    $('ap-response').innerHTML = responseHtml(res.final);
    $('ap-seen-body').innerHTML = seenHtml(res, cfg);
    $('ap-compare-out').innerHTML = '';
    renderCode();
  }
  function showError(msg) {
    $('ap-status').innerHTML = '<span class="ap-badge ap-b-bad">Check the request</span> ' + esc(msg);
    $('ap-timeline').innerHTML = ''; $('ap-attempts-body').innerHTML = ''; $('ap-notes').innerHTML = '';
    $('ap-response').innerHTML = ''; $('ap-seen-body').innerHTML = '';
  }
  function renderCode() {
    try {
      var sn = S.snippets(readCfg());
      $('ap-code-pre').textContent = sn[codeLang];
    } catch (e) { $('ap-code-pre').textContent = ''; }
    document.querySelectorAll('#ap-code-tabs button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === codeLang)); });
  }
  function toast(msg) {
    var t = $('ap-toast');
    t.textContent = msg;
    clearTimeout(toast.id);
    toast.id = setTimeout(function () { t.textContent = ''; }, 4000);
  }

  /* ---------- actions ---------- */
  function setBusy(b) {
    $('ap-send').disabled = b;
    $('ap-cancel').hidden = !(b && liveRun);
  }
  async function send() {
    if (running) return;
    var cfg = readCfg();
    var err = S.validate(cfg);
    if (err) { showError(err); return; }
    if (cfg.target === 'local' && !local.on) { showError('Connect to a local server first: run "npx ' + PKG + '" and paste the address it prints above.'); return; }
    running = true;
    liveRun = cfg.target !== 'sim' || cfg.realTime;
    setBusy(true);
    if (liveRun) { abortCtl = new AbortController(); cfg.signal = abortCtl.signal; cfg.onAttempt = function (rec, atts) { renderPartial(atts); }; }
    cfg.server = server;
    $('ap-status').innerHTML = '<span class="ap-badge ap-b-info">Running</span>';
    try {
      if (cfg.target === 'local') await prepareLocalRun(cfg);
      var res = await S.run(cfg);
      renderResult(res, cfg);
    } catch (e) {
      showError('Something went wrong: ' + (e && e.message ? e.message : e));
    } finally {
      running = false; liveRun = false; abortCtl = null; setBusy(false);
    }
  }
  async function runCompare() {
    var cfg = readCfg();
    if (cfg.target === 'real') return;
    var err = S.validate(cfg);
    if (err) { showError(err); return; }
    $('ap-compare-btn').disabled = true;
    try {
      var out = await S.compare(cfg);
      $('ap-compare-out').innerHTML = '<table class="ap-table"><thead><tr><th>Strategy</th><th>Attempts</th><th>Total time</th><th>Final result</th></tr></thead><tbody>' +
        out.map(function (r) {
          var cls = r.outcome === 'success' ? 'ok' : r.outcome === 'not-retried' ? 'warn' : 'bad';
          return '<tr><td>' + esc(r.name) + '</td><td>' + r.attempts + '</td><td>' + fmt(r.totalMs) + '</td><td><span class="ap-badge ap-b-' + cls + '">' + esc(r.label) + '</span></td></tr>';
        }).join('') + '</tbody></table><p class="ap-dim">Same request, same failures (same seed), different retry strategies. The named strategies use 4 attempts and a 500 ms base; they keep your timeout, retry rules and Retry-After setting.</p>';
    } finally { $('ap-compare-btn').disabled = false; }
  }
  function loadExample(id) {
    var cfg = S.exampleConfig(id);
    if (!cfg) return;
    var ex = S.EXAMPLES.filter(function (e) { return e.id === id; })[0];
    if (target === 'real') setTarget('sim', true);
    if (target === 'local') {
      if (!local.on) { toast('Connect to a local server first, or switch to Simulator.'); $('ap-example').value = ''; return; }
      applyCfg(cfg, true);
      $('ap-example-desc').textContent = ex.desc + ' The fault is now set on your local server, so your own app sees it too.';
      api('POST', '/reset').then(function () { return pushConfigNow(); }).then(send, function (e) { showError(e.message); });
      return;
    }
    resetSim();
    applyCfg(cfg);
    $('ap-example-desc').textContent = ex.desc;
    send();
  }
  function copyText(text, okMsg) {
    var done = function () { toast(okMsg); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }
  function encodeState(cfg) {
    var min = { realTime: cfg.realTime, seed: cfg.seed, request: cfg.request, fault: cfg.fault, latency: cfg.latency, policy: cfg.policy };
    var own = cleanRoutes().routes;
    if (own.length) min.routes = own;
    if (!$('ap-builtins').checked) min.builtins = false;
    return btoa(unescape(encodeURIComponent(JSON.stringify(min)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeState(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var o = JSON.parse(decodeURIComponent(escape(atob(s))));
    o.target = 'sim';
    return o;
  }

  /* ---------- simulator state ---------- */
  function resetSim() { server = S.newServerState(); syncSimServer(); }
  function syncSimServer() {
    var c = cleanRoutes();
    server.routes = c.routes;
    server.builtins = $('ap-builtins').checked;
  }

  /* ---------- mock routes editor ---------- */
  function toEditable(r) {
    var hdr = Object.keys(r.headers || {}).map(function (k) { return k + ': ' + r.headers[k]; }).join('\n');
    var body = r.body == null ? '' : (typeof r.body === 'object' ? JSON.stringify(r.body, null, 2) : String(r.body));
    return { method: r.method || 'GET', path: r.path || '/', status: r.status == null ? 200 : r.status, delayMs: r.delayMs || 0, headersText: hdr, bodyText: body, fault: r.fault || null, open: false };
  }
  function fromEditable(e) {
    var headers = {}, bad = null;
    String(e.headersText || '').split('\n').forEach(function (line) {
      if (!line.trim()) return;
      var at = line.indexOf(':');
      if (at < 1) { bad = line.trim(); return; }
      headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    });
    var body = e.bodyText === '' || e.bodyText == null ? null : e.bodyText;
    if (body != null && /^\s*[\[{]/.test(body)) { try { body = JSON.parse(body); } catch (err) { /* keep as text */ } }
    var out = { method: e.method, path: String(e.path || '').trim(), status: e.status === '' ? 200 : Number(e.status), headers: headers, body: body, delayMs: Number(e.delayMs) || 0 };
    if (e.fault) out.fault = e.fault;
    return { route: out, badHeader: bad };
  }
  function cleanRoutes() {
    var raw = [], errors = [];
    routes.forEach(function (e, i) {
      var r = fromEditable(e);
      if (r.badHeader) errors.push('Route ' + (i + 1) + ': write each header as "Name: value" (could not read "' + r.badHeader + '").');
      raw.push(r.route);
    });
    var n = S.normalizeRoutes(raw);
    return { routes: n.routes, errors: errors.concat(n.errors) };
  }
  function routeLabel(e) {
    return '<span class="ap-m ap-m-' + esc(String(e.method).toLowerCase().replace('*', 'any')) + '">' + esc(e.method === '*' ? 'ANY' : e.method) + '</span> <code>' + esc(e.path || '/') + '</code> <span class="ap-dim">&rarr; ' + esc(e.status === '' ? 200 : e.status) + (Number(e.delayMs) > 0 ? ', after ' + esc(fmt(Number(e.delayMs))) : '') + (e.fault ? ', own fault: ' + esc(e.fault.type) : '') + '</span>';
  }
  function renderRoutes() {
    var box = $('ap-routes');
    if (!routes.length) { box.innerHTML = '<p class="ap-dim ap-none">No routes of your own yet.</p>'; return; }
    box.innerHTML = routes.map(function (e, i) {
      var id = 'ap-r' + i + '-';
      return '<details class="ap-route" data-i="' + i + '"' + (e.open ? ' open' : '') + '><summary>' + routeLabel(e) + '</summary>' +
        '<div class="ap-fields ap-route-top">' +
        '<div class="ap-field"><label for="' + id + 'm">Method</label><select id="' + id + 'm" data-f="method">' + ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*'].map(function (m) { return '<option value="' + m + '"' + (m === e.method ? ' selected' : '') + '>' + (m === '*' ? 'Any' : m) + '</option>'; }).join('') + '</select></div>' +
        '<div class="ap-field ap-wide"><label for="' + id + 'p">Path</label><input id="' + id + 'p" data-f="path" type="text" spellcheck="false" autocomplete="off" placeholder="/users/:id" value="' + esc(e.path) + '"></div>' +
        '<div class="ap-field"><label for="' + id + 's">Status</label><input id="' + id + 's" data-f="status" type="number" min="200" max="599" value="' + esc(e.status) + '"></div>' +
        '<div class="ap-field"><label for="' + id + 'd">Delay (ms)</label><input id="' + id + 'd" data-f="delayMs" type="number" min="0" max="600000" value="' + esc(e.delayMs) + '"></div>' +
        '</div>' +
        '<div class="ap-field"><label for="' + id + 'b">Response body</label><textarea id="' + id + 'b" data-f="bodyText" spellcheck="false" placeholder=\'{ "id": "{{params.id | number}}", "name": "Ada" }\'>' + esc(e.bodyText) + '</textarea></div>' +
        '<div class="ap-field"><label for="' + id + 'h">Response headers, one per line (optional)</label><textarea id="' + id + 'h" class="ap-short" data-f="headersText" spellcheck="false" placeholder="Cache-Control: no-store">' + esc(e.headersText) + '</textarea></div>' +
        '<div class="ap-actions"><button type="button" class="ap-btn ap-small" data-act="try">Try it</button><button type="button" class="ap-btn ap-small" data-act="up"' + (i === 0 ? ' disabled' : '') + '>Move up</button><button type="button" class="ap-btn ap-small" data-act="del">Remove</button></div>' +
        '</details>';
    }).join('');
  }
  function routesChanged() {
    var c = cleanRoutes();
    $('ap-routes-err').textContent = c.errors.join(' ');
    if (target === 'local') { if (!c.errors.length) queuePush(true); }
    else syncSimServer();
  }
  function initRoutes() {
    var box = $('ap-routes');
    renderRoutes();
    box.addEventListener('input', function (ev) {
      var d = ev.target.closest('.ap-route'), f = ev.target.getAttribute('data-f');
      if (!d || !f) return;
      var e = routes[parseInt(d.getAttribute('data-i'), 10)]; if (!e) return;
      e[f] = ev.target.value;
      d.querySelector('summary').innerHTML = routeLabel(e);
      routesChanged();
    });
    box.addEventListener('toggle', function (ev) {
      var d = ev.target; if (!d.classList || !d.classList.contains('ap-route')) return;
      var e = routes[parseInt(d.getAttribute('data-i'), 10)]; if (e) e.open = d.open;
    }, true);
    box.addEventListener('click', function (ev) {
      var act = ev.target.getAttribute && ev.target.getAttribute('data-act'); if (!act) return;
      var d = ev.target.closest('.ap-route'), i = parseInt(d.getAttribute('data-i'), 10), e = routes[i];
      if (act === 'del') { routes.splice(i, 1); renderRoutes(); routesChanged(); }
      else if (act === 'up' && i > 0) { routes.splice(i - 1, 0, routes.splice(i, 1)[0]); renderRoutes(); routesChanged(); }
      else if (act === 'try') {
        var c = cleanRoutes();
        if (c.errors.length) { $('ap-routes-err').textContent = c.errors.join(' '); return; }
        var m = e.method === '*' ? 'GET' : e.method;
        $('ap-method').value = m;
        $('ap-url').value = (target === 'local' ? (local.base || DEFAULT_LOCAL) : S.SIM_ORIGIN) + String(e.path).replace(/:([A-Za-z0-9_]+)/g, '1').replace(/\*$/, 'anything');
        if (m !== 'GET' && m !== 'DELETE' && !$('ap-body').value) { $('ap-body').value = '{\n  "name": "Gizmo"\n}'; addHeader('Content-Type', 'application/json'); }
        $('ap-fault').value = 'none'; renderFaultFields('none', null);
        $('ap-h-req').scrollIntoView({ block: 'nearest' });
        if (target === 'local') pushConfigNow().then(send, function (er) { showError(er.message); }); else send();
      }
    });
    $('ap-route-add').addEventListener('click', function () {
      routes.push({ method: 'GET', path: '/hello', status: 200, delayMs: 0, headersText: '', bodyText: '{\n  "message": "Hello from your mock"\n}', fault: null, open: true });
      renderRoutes(); routesChanged();
      var last = $('ap-routes').querySelector('.ap-route:last-child [data-f="path"]'); if (last) { last.focus(); last.select(); }
    });
    $('ap-route-sample').addEventListener('click', function () {
      var have = {}; routes.forEach(function (e) { have[e.method + ' ' + e.path] = 1; });
      var added = 0;
      S.normalizeRoutes(S.SAMPLE_ROUTES).routes.forEach(function (r) { if (!have[r.method + ' ' + r.path]) { routes.push(toEditable(r)); added++; } });
      renderRoutes(); routesChanged();
      toast(added ? added + ' sample routes added. Open one to see how it is written.' : 'The sample routes are already in the list.');
    });
    $('ap-route-export').addEventListener('click', function () {
      var c = cleanRoutes();
      if (c.errors.length) { $('ap-routes-err').textContent = c.errors.join(' '); return; }
      var file = { routes: c.routes.map(function (r) { var o = { method: r.method, path: r.path, status: r.status }; if (Object.keys(r.headers).length) o.headers = r.headers; if (r.body != null) o.body = r.body; if (r.delayMs) o.delayMs = r.delayMs; if (r.fault) o.fault = r.fault; return o; }) };
      var f = readFault(); if (f.type !== 'none') file.fault = f;
      if (!$('ap-builtins').checked) file.builtins = false;
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' }));
      a.download = 'mock.json'; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast('mock.json saved. Run "npx ' + PKG + '" in the folder that holds it.');
    });
    $('ap-route-import').addEventListener('change', function () {
      var file = this.files && this.files[0], input = this; if (!file) return;
      var rd = new FileReader();
      rd.onload = function () {
        input.value = '';
        var data;
        try { data = JSON.parse(String(rd.result)); } catch (e) { $('ap-routes-err').textContent = 'That file is not valid JSON: ' + e.message; return; }
        var n = S.normalizeRoutes(Array.isArray(data) ? data : (data && data.routes));
        if (n.errors.length) { $('ap-routes-err').textContent = n.errors.join(' '); return; }
        routes = n.routes.map(toEditable);
        if (data && data.builtins === false) $('ap-builtins').checked = false;
        if (data && data.fault && data.fault.type) { $('ap-fault').value = data.fault.type; renderFaultFields(data.fault.type, data.fault); }
        renderRoutes(); routesChanged(); queuePush();
        toast(n.routes.length + ' routes loaded from ' + file.name + '.');
      };
      rd.readAsText(file);
    });
    $('ap-builtins').addEventListener('change', function () { if (target === 'local') queuePush(); else syncSimServer(); });
  }

  /* ---------- local server: connection, settings, request log ---------- */
  function api(method, path, body) {
    var init = { method: method, headers: { 'X-Mock-Token': local.token, 'X-Mock-Client': local.id }, cache: 'no-store' };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(local.base + '/__mock/api' + path, init).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) { var e = new Error(j && j.message ? j.message : 'The local server answered ' + r.status + '.'); e.status = r.status; throw e; }
        return j;
      });
    }, function () {
      throw new Error('Could not reach the local server at ' + local.base + '. Is "npx ' + PKG + '" still running?');
    });
  }
  function parseAddress(text) {
    text = String(text || '').trim();
    if (!text) return null;
    if (!/^[a-z]+:\/\//i.test(text)) text = 'http://' + text;
    var u;
    try { u = new URL(text); } catch (e) { return null; }
    var m = /(?:^|[#&?])k=([A-Za-z0-9_-]+)/.exec(u.hash) || /(?:^|[#&?])k=([A-Za-z0-9_-]+)/.exec(u.search);
    return { base: u.origin, token: m ? m[1] : '' };
  }
  function renderLocal(note) {
    var st = $('ap-local-status');
    $('ap-local-setup').hidden = local.on || !!BOOT;
    $('ap-local-on').hidden = !local.on;
    $('ap-local-disconnect').hidden = !!BOOT;
    if (local.on) {
      st.innerHTML = '<span class="ap-badge ap-b-ok">Connected</span> ' + esc(local.state ? local.state.name + ' ' + local.state.version : PKG) + (local.state && local.state.file ? ' &middot; routes from ' + esc(local.state.file) : '') + (note ? ' &middot; ' + esc(note) : '');
      $('ap-local-base').textContent = local.base;
    } else {
      st.innerHTML = note ? '<span class="ap-badge ap-b-bad">Not connected</span> ' + esc(note) : '<span class="ap-badge ap-b-info">Not connected</span>';
    }
  }
  function applyServerState(st) {
    local.state = st;
    if (target !== 'local') return;
    var c = st.config, active = document.activeElement;
    var busy = function (el) { return el && active === el; };
    /* fields the person is typing in are left alone */
    $('ap-fault').value = c.fault.type;
    if (!(active && active.closest && active.closest('#ap-fault-fields'))) renderFaultFields(c.fault.type, c.fault);
    if (!busy($('ap-fault-path'))) $('ap-fault-path').value = c.fault.path || '';
    if (!busy($('ap-lat'))) $('ap-lat').value = c.latency.baseMs;
    if (!busy($('ap-jit'))) $('ap-jit').value = c.latency.jitterMs;
    if (!busy($('ap-seed'))) $('ap-seed').value = c.seed;
    $('ap-repeat').checked = !!c.repeat; $('ap-cors').checked = !!c.cors; $('ap-builtins').checked = !!c.builtins;
    if (!(active && active.closest && active.closest('#ap-routes'))) {
      var open = {}; routes.forEach(function (e) { if (e.open) open[e.method + ' ' + e.path] = 1; });
      routes = (st.routes || []).map(toEditable);
      routes.forEach(function (e) { if (open[e.method + ' ' + e.path]) e.open = true; });
      renderRoutes(); $('ap-routes-err').textContent = '';
    }
  }
  function connectLocal(base, token, quiet) {
    disconnectLocal(true);
    local.base = base; local.token = token;
    return api('GET', '/state').then(function (st) {
      local.on = true; local.log = (st.requests || []).slice();
      try { if (!BOOT) sessionStorage.setItem('tinypdf-mock-conn', JSON.stringify({ base: base, token: token })); } catch (e) { /* private mode */ }
      var mine = cleanRoutes();
      var push = !BOOT && !st.routes.length && mine.routes.length && !mine.errors.length;
      setTarget('local', quiet);
      if ($('ap-url').value.indexOf(DEFAULT_LOCAL) === 0 && base !== DEFAULT_LOCAL) $('ap-url').value = base + $('ap-url').value.slice(DEFAULT_LOCAL.length);
      if (push) {
        return api('PUT', '/routes', { routes: mine.routes, by: local.id }).then(function (st2) { applyServerState(st2); toast('Sent your ' + mine.routes.length + ' mock routes to the local server.'); });
      }
      applyServerState(st);
    }).then(function () {
      renderLocal(); renderLog(); openStream();
    }, function (e) {
      local.on = false;
      renderLocal(e.status === 401 ? 'The token in that address was not accepted. Copy the full address the server printed, including the part after #k=.' : e.message);
      throw e;
    });
  }
  function openStream() {
    if (!window.EventSource) return;
    var es = new EventSource(local.base + '/__mock/api/events?k=' + encodeURIComponent(local.token));
    local.es = es;
    var down = false;
    es.addEventListener('request', function (ev) { var e = JSON.parse(ev.data); local.log.push(e); if (local.log.length > 300) local.log.shift(); renderLog(); });
    es.addEventListener('cleared', function () { local.log = []; local.selected = null; renderLog(); });
    es.addEventListener('config', function (ev) {
      var d = JSON.parse(ev.data);
      if (d.by === local.id || !local.state) return;
      local.state.config = d.config; local.state.routes = d.routes; applyServerState(local.state);
    });
    es.onerror = function () { if (local.es !== es) return; down = true; renderLocal('connection lost, trying again…'); };
    es.onopen = function () {
      if (local.es !== es || !down) return;
      down = false;
      api('GET', '/state').then(function (st) { local.log = (st.requests || []).slice(); applyServerState(st); renderLocal(); renderLog(); }, function () {});
    };
  }
  function disconnectLocal(keep) {
    if (local.es) { local.es.close(); local.es = null; }
    local.on = false; local.state = null; local.log = []; local.selected = null;
    if (!keep) { try { sessionStorage.removeItem('tinypdf-mock-conn'); } catch (e) { /* nothing stored */ } renderLocal(); renderLog(); }
  }
  function configPayload() {
    return { fault: readFault(), latency: { baseMs: numVal('ap-lat', 0), jitterMs: numVal('ap-jit', 0) }, seed: parseInt($('ap-seed').value, 10) || 0,
      repeat: $('ap-repeat').checked, cors: $('ap-cors').checked, builtins: $('ap-builtins').checked, by: local.id };
  }
  var routesDirty = false;
  function pushConfigNow() {
    if (local.pushTimer) { clearTimeout(local.pushTimer); local.pushTimer = null; }
    if (target !== 'local' || !local.on) return Promise.resolve();
    var sendRoutes = routesDirty; routesDirty = false;
    var chain = (local.pushing || Promise.resolve()).then(function () { return api('PUT', '/config', configPayload()); });
    if (sendRoutes) {
      var c = cleanRoutes();
      if (!c.errors.length) chain = chain.then(function () { return api('PUT', '/routes', { routes: c.routes, by: local.id }); });
    }
    local.pushing = chain.then(function (st) { if (local.state) { local.state.config = st.config; local.state.routes = st.routes; } local.pushing = null; },
      function (e) { local.pushing = null; $('ap-routes-err').textContent = sendRoutes ? e.message : ''; if (!sendRoutes) toast(e.message); });
    return local.pushing;
  }
  function queuePush(withRoutes) {
    if (target !== 'local' || !local.on) return;
    if (withRoutes) routesDirty = true;
    if (local.pushTimer) clearTimeout(local.pushTimer);
    local.pushTimer = setTimeout(pushConfigNow, 350);
  }
  function onMock(url) { try { return new URL(url).origin === local.base; } catch (e) { return false; } }
  function prepareLocalRun(cfg) {
    var url = S.normalizeUrl(cfg.request.url, local.base);
    cfg.attempt = localAttempt;
    return pushConfigNow().then(function () {
      if (!onMock(url)) return;
      /* A fresh run starts the fault counts again, like pressing Send in the simulator. */
      cfg.probe = function () { return api('GET', '/state').then(function (st) { return st.created; }); };
      return api('POST', '/rearm');
    });
  }
  function localAttempt(ctx) {
    var cfg = ctx.cfg, t0 = Date.now();
    return fetch(local.base + '/__mock/api/send', {
      method: 'POST', cache: 'no-store', signal: cfg.signal,
      headers: { 'Content-Type': 'application/json', 'X-Mock-Token': local.token },
      body: JSON.stringify({ method: String(cfg.request.method).toUpperCase(), url: ctx.url, headers: ctx.prep.sent, body: cfg.request.body || '', timeoutMs: S.num(cfg.policy.timeoutMs, 0) })
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.message || 'The local server answered ' + r.status); return j; }); })
      .catch(function (e) {
        if (cfg.signal && cfg.signal.aborted) throw { cancelled: true };
        return { kind: 'network', durationMs: Date.now() - t0, message: e && e.message && !/fetch/i.test(e.message) ? e.message : 'Could not reach the local server at ' + local.base + '. Is "npx ' + PKG + '" still running?' };
      });
  }
  function logBadge(e) {
    if (e.kind === 'preflight') return '<span class="ap-badge ap-b-info">CORS preflight</span>';
    if (e.clientClosed) return '<span class="ap-badge ap-b-warn">Client gave up</span>';
    if (e.kind === 'network') return '<span class="ap-badge ap-b-bad">Dropped</span>';
    if (e.kind === 'bodyError') return '<span class="ap-badge ap-b-bad">' + e.status + ', cut short</span>';
    var cls = e.status < 300 ? 'ok' : e.status < 400 ? 'info' : e.status < 500 ? 'warn' : 'bad';
    return '<span class="ap-badge ap-b-' + cls + '">' + e.status + '</span>';
  }
  function renderLog() {
    var showPre = $('ap-in-pre').checked;
    var list = local.log.filter(function (e) { return showPre || e.kind !== 'preflight'; }).slice(-100).reverse();
    $('ap-in-empty').hidden = list.length > 0;
    $('ap-in-wrap').hidden = !list.length;
    $('ap-in-count').textContent = list.length ? '(' + local.log.filter(function (e) { return showPre || e.kind !== 'preflight'; }).length + ')' : '';
    $('ap-in-body').innerHTML = list.map(function (e) {
      var t = new Date(e.time), hh = function (n) { return (n < 10 ? '0' : '') + n; };
      return '<tr data-id="' + e.id + '" tabindex="0"' + (local.selected === e.id ? ' class="is-on"' : '') + '><td class="ap-nw">' + hh(t.getHours()) + ':' + hh(t.getMinutes()) + ':' + hh(t.getSeconds()) + '</td>' +
        '<td><span class="ap-m ap-m-' + esc(e.method.toLowerCase()) + '">' + esc(e.method) + '</span> <code>' + esc(e.path + (e.query || '')) + '</code></td>' +
        '<td>' + logBadge(e) + (e.fault ? ' <span class="ap-dim">' + esc(e.fault) + ' #' + e.attempt + '</span>' : '') + '</td><td class="ap-nw">' + fmt(e.ms) + '</td></tr>';
    }).join('');
    renderLogDetail();
  }
  function kvTable(obj) {
    var keys = Object.keys(obj || {});
    if (!keys.length) return '<p class="ap-dim">None.</p>';
    return '<table class="ap-table ap-hdrs"><tbody>' + keys.map(function (k) { return '<tr><th scope="row">' + esc(k) + '</th><td>' + esc(Array.isArray(obj[k]) ? obj[k].join(', ') : obj[k]) + '</td></tr>'; }).join('') + '</tbody></table>';
  }
  function renderLogDetail() {
    var e = local.log.filter(function (x) { return x.id === local.selected; })[0], box = $('ap-in-detail');
    if (!e) { box.innerHTML = ''; return; }
    var h = '<div class="ap-in-card"><div class="ap-resp-line"><span class="ap-m ap-m-' + esc(e.method.toLowerCase()) + '">' + esc(e.method) + '</span> <code>' + esc(e.path + (e.query || '')) + '</code> ' + logBadge(e) + '</div>';
    if (e.message) h += '<p>' + esc(e.message) + '</p>';
    if (e.fault) h += '<p class="ap-dim">Injected fault: ' + esc(e.fault) + ', request number ' + e.attempt + ' in this round.</p>';
    else if (e.route) h += '<p class="ap-dim">Answered by your route ' + esc(e.route) + '.</p>';
    h += '<h3>Request headers</h3>' + kvTable(e.headers);
    h += '<h3>Request body' + (e.bodyBytes ? ' <span class="ap-dim">' + e.bodyBytes + ' bytes</span>' : '') + '</h3>' + (e.body ? '<pre class="ap-pre">' + esc(prettyBody(e.body)) + '</pre>' : '<p class="ap-dim">No body.</p>');
    if (e.kind !== 'network' && !e.clientClosed) {
      h += '<h3>Answer headers</h3>' + kvTable(e.responseHeaders);
      h += '<h3>Answer body</h3>' + (e.responseBody ? '<pre class="ap-pre">' + esc(prettyBody(e.responseBody)) + '</pre>' : '<p class="ap-dim">No body.</p>');
    }
    h += '<div class="ap-actions"><button type="button" class="ap-btn ap-small" id="ap-in-use">Copy to the request form</button><button type="button" class="ap-btn ap-small" id="ap-in-close">Close</button></div></div>';
    box.innerHTML = h;
    $('ap-in-close').onclick = function () { local.selected = null; renderLog(); };
    $('ap-in-use').onclick = function () {
      var skip = { host: 1, connection: 1, 'content-length': 1, 'accept-encoding': 1 };
      $('ap-method').value = e.method; if ($('ap-method').value !== e.method) $('ap-method').value = 'GET';
      $('ap-url').value = local.base + e.path + (e.query || '');
      rows = Object.keys(e.headers || {}).filter(function (k) { return !skip[k] && k.indexOf('sec-') !== 0; }).map(function (k) { return { name: k, value: String(e.headers[k]), enabled: true }; });
      renderHeaders(); $('ap-body').value = e.body || '';
      toast('Request copied to the form. Press Send to repeat it.');
      $('ap-h-req').scrollIntoView({ block: 'nearest' });
    };
  }
  function initLocal() {
    var addr = $('ap-local-addr');
    var go = function () {
      var a = parseAddress(addr.value);
      if (!a) { renderLocal('Paste the address the server printed, for example ' + DEFAULT_LOCAL + '/#k=…'); return; }
      if (!a.token) { renderLocal('That address has no token. Copy the whole line the server printed, including the part after #k=.'); return; }
      $('ap-local-status').innerHTML = '<span class="ap-badge ap-b-info">Connecting</span>';
      connectLocal(a.base, a.token).then(function () { addr.value = ''; }, function () {});
    };
    $('ap-local-connect').addEventListener('click', go);
    addr.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(); } });
    $('ap-local-disconnect').addEventListener('click', function () { disconnectLocal(); });
    $('ap-local-copy').addEventListener('click', function () { copyText(local.base, 'Address copied.'); });
    $('ap-npx-copy').addEventListener('click', function () { copyText('npx ' + PKG, 'Command copied.'); });
    $('ap-in-clear').addEventListener('click', function () { if (local.on) api('DELETE', '/requests').then(function () { local.log = []; local.selected = null; renderLog(); }, function (e) { toast(e.message); }); });
    $('ap-in-pre').addEventListener('change', renderLog);
    var pick = function (ev) {
      var tr = ev.target.closest('tr[data-id]'); if (!tr) return;
      if (ev.type === 'keydown' && ev.key !== 'Enter' && ev.key !== ' ') return;
      if (ev.type === 'keydown') ev.preventDefault();
      var id = parseInt(tr.getAttribute('data-id'), 10);
      local.selected = local.selected === id ? null : id; renderLog();
    };
    $('ap-in-body').addEventListener('click', pick);
    $('ap-in-body').addEventListener('keydown', pick);
    $('ap-rearm').addEventListener('click', function () { if (local.on) api('POST', '/rearm').then(function () { toast('Fault counts start again from the next request.'); }, function (e) { toast(e.message); }); });
    ['ap-repeat', 'ap-cors'].forEach(function (id) { $(id).addEventListener('change', function () { queuePush(); }); });
    ['ap-fault-path', 'ap-lat', 'ap-jit', 'ap-seed'].forEach(function (id) { $(id).addEventListener('input', function () { queuePush(); }); });
    $('ap-fault-fields').addEventListener('input', function () { queuePush(); });
    $('ap-fault-fields').addEventListener('change', function () { queuePush(); });
    renderLocal();
  }

  /* ---------- wiring ---------- */
  function init() {
    var ex = $('ap-example');
    ex.innerHTML = '<option value="">Load an example&hellip;</option>' + S.EXAMPLES.map(function (e) { return '<option value="' + e.id + '">' + esc(e.title) + '</option>'; }).join('');
    $('ap-fault').innerHTML = S.FAULTS.map(function (f) { return '<option value="' + f.type + '">' + esc(f.label) + '</option>'; }).join('');
    $('ap-hdr-preset').innerHTML = '<option value="">Add a common header&hellip;</option>' + PRESETS.map(function (p, i) { return '<option value="' + i + '">' + esc(p[0]) + '</option>'; }).join('');

    ex.addEventListener('change', function () { if (ex.value) { loadExample(ex.value); } });
    document.querySelectorAll('input[name="ap-target"]').forEach(function (r) {
      r.addEventListener('change', function () { setTarget(r.value); renderCode(); });
    });
    $('ap-fault').addEventListener('change', function () { renderFaultFields($('ap-fault').value, null); queuePush(); });
    initLocal();
    initRoutes();
    $('ap-strategy').addEventListener('change', syncPolicyUi);
    $('ap-send').addEventListener('click', send);
    $('ap-cancel').addEventListener('click', function () { if (abortCtl) abortCtl.abort(); });
    $('ap-compare-btn').addEventListener('click', runCompare);
    $('ap-reset-server').addEventListener('click', function () {
      if (target === 'local') {
        if (!local.on) return;
        api('POST', '/reset').then(function () { toast('Server data reset: 3 items, no stored Idempotency-Keys, fault counts at zero. Routes kept.'); }, function (e) { toast(e.message); });
        return;
      }
      resetSim(); toast('Simulated server reset: 3 items, no stored Idempotency-Keys.');
    });
    $('ap-hdr-add').addEventListener('click', function () {
      rows.push({ name: '', value: '', enabled: true }); renderHeaders();
      var inputs = $('ap-hdr-body').querySelectorAll('.h-name'); if (inputs.length) inputs[inputs.length - 1].focus();
    });
    $('ap-hdr-preset').addEventListener('change', function () {
      var p = PRESETS[parseInt(this.value, 10)];
      if (p) addHeader(p[1], p[2]);
      this.value = '';
    });
    var tb = $('ap-hdr-body');
    tb.addEventListener('input', function (e) {
      var tr = e.target.closest('tr'); if (!tr) return;
      var r = rows[parseInt(tr.getAttribute('data-i'), 10)]; if (!r) return;
      if (e.target.classList.contains('h-name')) { r.name = e.target.value; updateBlocked(tr, r); }
      else if (e.target.classList.contains('h-val')) r.value = e.target.value;
    });
    tb.addEventListener('change', function (e) {
      if (!e.target.classList.contains('h-on')) return;
      var tr = e.target.closest('tr'); var r = rows[parseInt(tr.getAttribute('data-i'), 10)];
      if (r) r.enabled = e.target.checked;
    });
    tb.addEventListener('click', function (e) {
      if (!e.target.classList.contains('ap-x')) return;
      var tr = e.target.closest('tr'); rows.splice(parseInt(tr.getAttribute('data-i'), 10), 1); renderHeaders();
    });
    document.querySelectorAll('#ap-code-tabs button').forEach(function (b) {
      b.addEventListener('click', function () { codeLang = b.getAttribute('data-lang'); renderCode(); });
    });
    $('ap-code').addEventListener('toggle', renderCode);
    $('ap-copy-code').addEventListener('click', function () { copyText($('ap-code-pre').textContent, 'Code copied.'); });
    $('ap-share').addEventListener('click', function () {
      var cfg = readCfg();
      if (cfg.target !== 'sim') { toast('Links are only available in Simulator mode, so no headers or tokens end up in a URL.'); return; }
      try { history.replaceState(null, '', '#s=' + encodeState(cfg)); } catch (e) { /* ignore */ }
      copyText(location.href, 'Link copied. It contains this setup.');
    });
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    });
    var panels = $('ap');
    panels.addEventListener('input', function () { if ($('ap-code').open) renderCode(); });

    var start = null;
    if (/^#s=/.test(location.hash)) { try { start = decodeState(location.hash.slice(3)); } catch (e) { start = null; } }
    if (BOOT) {
      var d0 = S.exampleConfig('flaky'); d0.fault = { type: 'none' }; applyCfg(d0);
      setTarget('local', true);
      $('ap-url').value = (BOOT.base || location.origin) + '/items';
      connectLocal(BOOT.base || location.origin, BOOT.token, true);
      return;
    }
    if (start) {
      applyCfg(start);
      if (start.routes) { routes = S.normalizeRoutes(start.routes).routes.map(toEditable); renderRoutes(); }
      if (start.builtins === false) $('ap-builtins').checked = false;
      syncSimServer();
      $('ap-example-desc').textContent = 'Setup loaded from the link you opened.';
    }
    else { var d = S.exampleConfig('flaky'); applyCfg(d); $('ap-example-desc').textContent = S.EXAMPLES[0].desc; ex.value = 'flaky'; }
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('tinypdf-mock-conn') || 'null'); } catch (e) { saved = null; }
    if (saved && saved.base && !start) { $('ap-local-addr').value = saved.base + '/#k=' + saved.token; }
    if (location.hash === '#local') setTarget('local');
    send();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
