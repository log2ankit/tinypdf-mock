/* TinyPDF.in API playgrounds: shared simulation core (no dependencies).
   Runs in the browser (the control page here, and the REST API Playground on tinypdf.in) and in Node (lib/server.js):
   mock server state, your own mock routes, fault injection, retry/backoff runner, code snippets.
   In simulator mode everything runs in the page and no network request is made. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TinySim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SIM_ORIGIN = 'https://api.sim.local';
  var JSON_CT = 'application/json; charset=utf-8';
  var STATUS_TEXT = {
    200: 'OK', 201: 'Created', 204: 'No Content', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout',
    415: 'Unsupported Media Type', 422: 'Unprocessable Content', 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout'
  };

  /* ---------- small helpers ---------- */
  function num(v, d) {
    if (v === '' || v == null) return d;
    var x = Number(v);
    return isFinite(x) ? x : d;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function fmtMs(ms) {
    ms = Math.round(ms);
    if (ms < 1000) return ms + ' ms';
    var s = ms / 1000;
    return (s >= 10 ? s.toFixed(1) : s.toFixed(2)).replace(/\.?0+$/, '') + ' s';
  }

  /* ---------- headers ---------- */
  var FORBIDDEN = ['accept-charset', 'accept-encoding', 'access-control-request-headers',
    'access-control-request-method', 'connection', 'content-length', 'cookie', 'cookie2', 'date',
    'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer', 'te', 'trailer',
    'transfer-encoding', 'upgrade', 'via'];
  function isForbiddenHeader(name) {
    var n = String(name).trim().toLowerCase();
    return FORBIDDEN.indexOf(n) >= 0 || n.indexOf('proxy-') === 0 || n.indexOf('sec-') === 0;
  }
  function prepareHeaders(list, allowForbidden) {
    var sent = [], dropped = [];
    (list || []).forEach(function (h) {
      if (h.enabled === false) return;
      var name = String(h.name == null ? '' : h.name).trim();
      if (!name) return;
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) { dropped.push({ name: name, reason: 'invalid' }); return; }
      if (!allowForbidden && isForbiddenHeader(name)) { dropped.push({ name: name, reason: 'forbidden' }); return; }
      sent.push({ name: name, value: String(h.value == null ? '' : h.value) });
    });
    return { sent: sent, dropped: dropped };
  }
  function lowerMap(list) {
    var m = {};
    list.forEach(function (h) {
      var k = h.name.toLowerCase();
      m[k] = (k in m) ? m[k] + ', ' + h.value : h.value;
    });
    return m;
  }
  function parseRetryAfter(v) {
    if (v == null) return null;
    v = String(v).trim();
    if (/^\d+$/.test(v)) return parseInt(v, 10) * 1000;
    var d = Date.parse(v);
    return isNaN(d) ? null : Math.max(0, d - Date.now());
  }

  /* ---------- URLs ---------- */
  /* base: '' or missing for the simulator, true for a real address, or the address of a local mock server. */
  function normalizeUrl(url, base) {
    var real = base === true, origin = (typeof base === 'string' && base) ? base.replace(/\/+$/, '') : SIM_ORIGIN;
    url = String(url == null ? '' : url).trim();
    if (!url) return real ? '' : origin + '/';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
    if (url.charAt(0) === '/') return (real ? '' : origin) + url;
    if (typeof base === 'string' && base) return (/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url) ? 'http://' : 'https://') + url;
    return (real ? 'https://' : origin + '/') + url;
  }
  function urlBase(cfg) { return cfg.target === 'real' ? true : cfg.target === 'local' ? (cfg.localBase || 'http://localhost:4747') : ''; }
  function validate(cfg) {
    var r = cfg.request || {};
    if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].indexOf(String(r.method).toUpperCase()) < 0) return 'Choose a method.';
    var u;
    var sim = cfg.target !== 'real' && cfg.target !== 'local';
    try { u = new URL(normalizeUrl(r.url, urlBase(cfg))); }
    catch (e) { return 'That URL is not valid. Example: ' + (sim ? SIM_ORIGIN : 'http://localhost:4747') + '/items'; }
    if (sim && u.origin !== SIM_ORIGIN) {
      return 'Simulator mode only serves ' + SIM_ORIGIN + '. Switch to "Local server" or "Real URL" to call another address.';
    }
    if (!sim && u.protocol !== 'https:' && u.protocol !== 'http:') return 'Only http: and https: addresses can be called.';
    return null;
  }

  /* ---------- simulated server ---------- */
  function newServerState(opts) {
    opts = opts || {};
    return {
      items: [{ id: 1, name: 'Widget', price: 9.5 }, { id: 2, name: 'Gadget', price: 19 }, { id: 3, name: 'Doohickey', price: 4.25 }],
      nextId: 4, idem: {}, version: 1, reqSeq: 0, created: 0,
      routes: opts.routes ? normalizeRoutes(opts.routes).routes : [], builtins: opts.builtins !== false
    };
  }

  /* ---------- your own mock routes ----------
     A route is { method, path, status, headers, body, delayMs }. Paths may hold :name parts and a
     trailing *. Bodies may hold {{params.id}}, {{query.q}}, {{body.name}}, {{headers.x-id}},
     {{method}}, {{path}}, {{now}}, {{timestamp}} and {{uuid}}. */
  var ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*'];
  function normalizeRoutes(list) {
    var routes = [], errors = [];
    if (list == null) list = [];
    if (!Array.isArray(list)) return { routes: routes, errors: ['"routes" must be a list.'] };
    list.forEach(function (r, i) {
      var where = 'Route ' + (i + 1) + ': ';
      if (!r || typeof r !== 'object') { errors.push(where + 'must be an object.'); return; }
      var method = String(r.method == null ? 'GET' : r.method).trim().toUpperCase();
      if (method === 'ANY' || method === 'ALL') method = '*';
      if (ROUTE_METHODS.indexOf(method) < 0) { errors.push(where + 'unknown method "' + r.method + '".'); return; }
      var path = String(r.path == null ? '' : r.path).trim();
      if (path.charAt(0) !== '/') { errors.push(where + 'the path must start with "/".'); return; }
      if (/[?#\s]/.test(path)) { errors.push(where + 'the path cannot hold a space, "?" or "#".'); return; }
      var status = r.status == null || r.status === '' ? 200 : Number(r.status);
      if (!(status >= 200 && status <= 599) || status !== Math.floor(status)) { errors.push(where + 'the status must be a number from 200 to 599.'); return; }
      var headers = {};
      if (r.headers != null) {
        if (typeof r.headers !== 'object' || Array.isArray(r.headers)) { errors.push(where + '"headers" must be an object of name and value.'); return; }
        var badName = null;
        Object.keys(r.headers).forEach(function (k) {
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) badName = k;
          else headers[k.toLowerCase()] = String(r.headers[k]);
        });
        if (badName != null) { errors.push(where + 'header name "' + badName + '" is not valid.'); return; }
      }
      var delay = Math.max(0, Math.min(600000, num(r.delayMs, 0)));
      var out = { method: method, path: path, status: status, headers: headers, body: r.body == null ? null : (typeof r.body === 'object' ? clone(r.body) : String(r.body)), delayMs: delay };
      if (r.fault && typeof r.fault === 'object' && r.fault.type) out.fault = clone(r.fault);
      if (r.enabled === false) out.enabled = false;
      routes.push(out);
    });
    return { routes: routes, errors: errors };
  }
  var pathCache = {};
  function compilePath(path) {
    if (pathCache[path]) return pathCache[path];
    var keys = [];
    var src = path.replace(/\/+$/, '').split('/').map(function (seg) {
      if (seg === '*') { keys.push('*'); return '(.*)'; }
      if (seg.charAt(0) === ':' && seg.length > 1) { keys.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    return (pathCache[path] = { re: new RegExp('^' + src + '$'), keys: keys });
  }
  function matchRoute(routes, method, path) {
    var p = String(path).replace(/\/+$/, ''), m = method === 'HEAD' ? 'GET' : method, wrongMethod = null;
    for (var i = 0; i < (routes || []).length; i++) {
      var rt = routes[i];
      if (rt.enabled === false) continue;
      var c = compilePath(rt.path), hit = c.re.exec(p);
      if (!hit) continue;
      if (rt.method !== '*' && rt.method !== m && rt.method !== method) { wrongMethod = wrongMethod || rt; continue; }
      var params = {};
      for (var k = 0; k < c.keys.length; k++) { try { params[c.keys[k]] = decodeURIComponent(hit[k + 1]); } catch (e) { params[c.keys[k]] = hit[k + 1]; } }
      return { route: rt, params: params, index: i };
    }
    return null;
  }
  function makeUuid() {
    var c = (typeof crypto !== 'undefined') ? crypto : null;
    if (c && c.randomUUID) return c.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
      var r = Math.random() * 16 | 0; return (ch === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }
  function lookup(expr, ctx) {
    var parts = String(expr).split('|'), key = parts[0].trim(), filter = (parts[1] || '').trim();
    var v;
    if (key === 'uuid') v = makeUuid();
    else if (key === 'now') v = new Date().toISOString();
    else if (key === 'timestamp') v = Date.now();
    else {
      v = ctx;
      var segs = key.split('.');
      for (var i = 0; i < segs.length && v != null; i++) v = (typeof v === 'object') ? v[i === 1 && segs[0] === 'headers' ? segs[i].toLowerCase() : segs[i]] : undefined;
    }
    if (filter === 'number') { var n = Number(v); return isFinite(n) && v !== '' && v != null ? n : null; }
    if (filter === 'json') return v === undefined ? 'null' : JSON.stringify(v);
    return v;
  }
  function fillText(text, ctx) {
    return String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (all, expr) {
      var v = lookup(expr, ctx);
      return v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    });
  }
  function fillValue(v, ctx) {
    if (typeof v === 'string') {
      var whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(v);
      if (whole) { var x = lookup(whole[1], ctx); return x === undefined ? null : x; }
      return fillText(v, ctx);
    }
    if (Array.isArray(v)) return v.map(function (x) { return fillValue(x, ctx); });
    if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { o[k] = fillValue(v[k], ctx); }); return o; }
    return v;
  }
  function routeResponse(hit, c) {
    var rt = hit.route, query = {}, parsed = null;
    c.u.searchParams.forEach(function (v, k) { query[k] = v; });
    if (c.req.body) { try { parsed = JSON.parse(c.req.body); } catch (e) { parsed = null; } }
    var ctx = { params: hit.params, query: query, body: parsed, headers: c.h, method: c.req.method, path: c.u.pathname };
    var headers = {}, body = '';
    Object.keys(rt.headers || {}).forEach(function (k) { headers[k] = fillText(rt.headers[k], ctx); });
    if (rt.body != null && typeof rt.body === 'object') {
      body = JSON.stringify(fillValue(rt.body, ctx), null, 2);
      if (!headers['content-type']) headers['content-type'] = JSON_CT;
    } else if (rt.body != null && rt.body !== '') {
      body = fillText(rt.body, ctx);
      if (!headers['content-type']) headers['content-type'] = /^\s*[\[{]/.test(body) ? JSON_CT : 'text/plain; charset=utf-8';
    }
    if (rt.status === 204 || rt.status === 304) body = '';
    var r = { status: rt.status, headers: headers, body: body, route: rt.method + ' ' + rt.path };
    if (rt.delayMs > 0) r.latencyOverride = rt.delayMs;
    if (rt.fault) r.routeFault = rt.fault;
    return r;
  }
  function jsonResp(status, obj, extra) {
    var headers = { 'content-type': JSON_CT };
    if (extra) Object.keys(extra).forEach(function (k) { headers[k.toLowerCase()] = extra[k]; });
    return { status: status, headers: headers, body: JSON.stringify(obj, null, 2) };
  }
  function errorResponse(status, extra) {
    return jsonResp(status, {
      error: 'simulated_failure', status: status,
      message: 'Injected ' + status + ' ' + (STATUS_TEXT[status] || '') + ' for this demo'
    }, extra);
  }

  var ROUTES = [
    { re: /^\/$/, methods: ['GET'], fn: function () {
      return jsonResp(200, { name: 'TinyPDF API simulator', routes: ['GET /items', 'POST /items', 'GET /items/1', 'GET /secure (Bearer secret123)', 'GET /status/503', 'GET /delay/1500', 'GET /headers'] });
    } },
    { re: /^\/headers$/, methods: ['GET'], fn: function (c) { return jsonResp(200, { headers: c.h }); } },
    { re: /^\/status\/(\d{3})$/, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], fn: function (c) {
      var code = parseInt(c.m[1], 10);
      if (code < 200 || code > 599) return jsonResp(400, { error: 'bad_status', message: 'Use a status between 200 and 599' });
      var body = (code === 204 || code === 304) ? '' : JSON.stringify({ status: code, message: STATUS_TEXT[code] || 'Status ' + code }, null, 2);
      return { status: code, headers: body ? { 'content-type': JSON_CT } : {}, body: body };
    } },
    { re: /^\/delay\/(\d{1,5})$/, methods: ['GET'], fn: function (c) {
      var ms = Math.min(parseInt(c.m[1], 10), 60000);
      var r = jsonResp(200, { delayed_ms: ms });
      r.latencyOverride = ms;
      return r;
    } },
    { re: /^\/secure$/, methods: ['GET'], fn: function (c) {
      var a = c.h['authorization'];
      if (!a) return jsonResp(401, { error: 'unauthorized', message: 'Missing Authorization header' }, { 'www-authenticate': 'Bearer realm="sim"' });
      var m = /^Bearer\s+(.+)$/i.exec(a);
      if (!m || m[1] !== 'secret123') return jsonResp(401, { error: 'invalid_token', message: 'Token not recognised. The demo token is secret123' }, { 'www-authenticate': 'Bearer error="invalid_token"' });
      return jsonResp(200, { message: 'Hello, you are authenticated', user: 'demo' });
    } },
    { re: /^\/items$/, methods: ['GET', 'POST'], fn: function (c) {
      var st = c.state;
      var etag = 'W/"items-' + st.version + '"';
      if (c.method === 'GET') {
        var inm = c.h['if-none-match'];
        if (inm) {
          var strip = function (v) { return v.trim().replace(/^W\//, ''); };
          var hit = inm.split(',').some(function (v) { return strip(v) === strip(etag) || v.trim() === '*'; });
          if (hit) return { status: 304, headers: { etag: etag }, body: '' };
        }
        var r = jsonResp(200, { items: st.items }, { etag: etag, 'cache-control': 'no-cache' });
        return r;
      }
      var ct = c.h['content-type'] || '';
      if (!/application\/([\w.+-]+\+)?json/i.test(ct)) {
        return jsonResp(415, { error: 'unsupported_media_type', message: 'Send Content-Type: application/json', received: ct || null });
      }
      var key = c.h['idempotency-key'];
      if (key && st.idem[key]) {
        var saved = clone(st.idem[key]);
        saved.headers['idempotent-replayed'] = 'true';
        return saved;
      }
      var data;
      try { data = JSON.parse(c.req.body || ''); } catch (e) { return jsonResp(400, { error: 'invalid_json', message: String(e.message) }); }
      if (!data || typeof data.name !== 'string' || !data.name) return jsonResp(422, { error: 'validation_failed', fields: { name: 'required string' } });
      var item = { id: st.nextId++, name: data.name, price: typeof data.price === 'number' ? data.price : null };
      st.items.push(item); st.version++; st.created++;
      var resp = jsonResp(201, item, { location: '/items/' + item.id });
      if (key) st.idem[key] = clone(resp);
      return resp;
    } },
    { re: /^\/items\/(\d+)$/, methods: ['GET'], fn: function (c) {
      var id = parseInt(c.m[1], 10);
      var it = c.state.items.filter(function (x) { return x.id === id; })[0];
      return it ? jsonResp(200, it) : jsonResp(404, { error: 'not_found', message: 'No item with id ' + id });
    } }
  ];

  function handle(state, req) {
    state.reqSeq++;
    var out = dispatch();
    var common = { 'x-request-id': 'req_' + (1000 + state.reqSeq), 'server': 'tinypdf-sim' };
    Object.keys(common).forEach(function (k) { if (!(k in out.headers)) out.headers[k] = common[k]; });
    if (req.method === 'HEAD') out.body = '';
    return out;

    function dispatch() {
      var u;
      try { u = new URL(req.url); } catch (e) { return jsonResp(400, { error: 'bad_url' }); }
      var path = u.pathname.replace(/\/+$/, '') || '/';
      var method = req.method === 'HEAD' ? 'GET' : req.method;
      var h = req.headers, m = null, route = null;
      var own = matchRoute(state.routes, req.method, path);
      if (own) return routeResponse(own, { req: req, h: h, u: u });
      var others = (state.routes || []).filter(function (r) { return r.enabled !== false && compilePath(r.path).re.test(path.replace(/\/+$/, '')); })
        .map(function (r) { return r.method; });
      if (others.length) {
        if (req.method === 'OPTIONS') return { status: 204, headers: { allow: others.join(', ') }, body: '' };
        return jsonResp(405, { error: 'method_not_allowed', allowed: others }, { allow: others.join(', ') });
      }
      if (state.builtins === false) {
        return jsonResp(404, { error: 'not_found', message: 'No mock route for ' + req.method + ' ' + path,
          routes: (state.routes || []).filter(function (r) { return r.enabled !== false; }).map(function (r) { return r.method + ' ' + r.path; }) });
      }
      for (var i = 0; i < ROUTES.length; i++) {
        m = ROUTES[i].re.exec(path);
        if (m) { route = ROUTES[i]; break; }
      }
      if (!route) return jsonResp(404, { error: 'not_found', message: 'No route for ' + path, try: ['/items', '/secure', '/status/503', '/delay/1500', '/headers'] });
      if (method === 'OPTIONS') return { status: 204, headers: { allow: route.methods.join(', ') }, body: '' };
      if (route.methods.indexOf(method) < 0) return jsonResp(405, { error: 'method_not_allowed', allowed: route.methods }, { allow: route.methods.join(', ') });
      var accept = h['accept'];
      if (accept && !/\*\/\*|application\/(\*|json)|\+json/i.test(accept)) {
        return jsonResp(406, { error: 'not_acceptable', message: 'This API only serves application/json', accept: accept });
      }
      return route.fn({ state: state, req: req, h: h, u: u, m: m, method: method });
    }
  }

  /* ---------- fault injection ---------- */
  var FAULTS = [
    { type: 'none', label: 'None (healthy server)', help: 'The server answers normally. Use this with the header presets to see how headers change responses.', fields: [] },
    { type: 'fail-first-n', label: 'Fail the first N attempts', help: 'Classic transient outage: the first attempts fail, later ones succeed. Add Retry-After to see whether the client honors it.',
      fields: [{ key: 'n', label: 'Failures', def: 2, min: 1, max: 10 },
        { key: 'status', label: 'Status', def: 503, options: [500, 502, 503, 504, 429, 408] },
        { key: 'retryAfter', label: 'Retry-After (s)', def: '', min: 0, max: 3600, optional: true }] },
    { type: 'random', label: 'Random failures', help: 'Each attempt fails with 500, 502, 503 or 504 at the chosen rate. The same seed gives the same sequence.',
      fields: [{ key: 'pct', label: 'Failure rate (%)', def: 30, min: 0, max: 100 }] },
    { type: 'always', label: 'Always fail', help: 'Every attempt fails. Shows what a retry policy costs when the server never recovers.',
      fields: [{ key: 'status', label: 'Status', def: 500, options: [500, 502, 503, 504, 429, 401, 403, 404] }] },
    { type: 'drop-first-n', label: 'Drop the connection (first N)', help: 'The connection dies before any response. The server never saw the request.',
      fields: [{ key: 'n', label: 'Dropped attempts', def: 2, min: 1, max: 10 }] },
    { type: 'drop-after-process', label: 'Process, then drop the response (first N)', help: 'The server does the work, then the response is lost. The client cannot tell it apart from a dropped request. Try it with POST.',
      fields: [{ key: 'n', label: 'Lost responses', def: 1, min: 1, max: 10 }] },
    { type: 'rate-limit-until', label: '429 until N seconds have passed', help: 'The server answers 429 with a Retry-After header until the given time has passed since the first attempt.',
      fields: [{ key: 'sec', label: 'Seconds', def: 4, min: 1, max: 3600 }] },
    { type: 'slow-first-n', label: 'Slow responses (first N)', help: 'The first responses take longer than your timeout. The server still processes them.',
      fields: [{ key: 'n', label: 'Slow attempts', def: 2, min: 1, max: 10 },
        { key: 'slowMs', label: 'Response time (ms)', def: 5000, min: 100, max: 60000 }] },
    { type: 'truncated-first-n', label: 'Cut the body short (first N)', help: 'Headers arrive, then the connection closes mid-body. Clients see a read error, which most treat like a network failure.',
      fields: [{ key: 'n', label: 'Truncated attempts', def: 1, min: 1, max: 10 }] },
    { type: 'malformed', label: 'Return invalid JSON (200 OK)', help: 'A perfectly valid HTTP response with a broken body. Status codes do not guarantee usable data.', fields: [] }
  ];

  function simulateAttempt(env) {
    var cfg = env.cfg, state = env.server;
    var prep = prepareHeaders(cfg.request.headers);
    var req = { method: String(cfg.request.method).toUpperCase(), url: normalizeUrl(cfg.request.url), headers: lowerMap(prep.sent), body: cfg.request.body || '' };
    var r = planAttempt({ fault: env.fault, attempt: env.attempt, t: env.t, rng: env.rng, latency: cfg.latency, exec: function () { return handle(state, req); } });
    r.seen = { headers: req.headers, dropped: prep.dropped };
    return r;
  }
  /* Decides what one attempt gets: env = { fault, attempt (1-based), t (ms since the first attempt),
     rng, latency: { baseMs, jitterMs }, exec() -> { status, headers, body } }.
     Returns a description: kind 'response' | 'network' | 'bodyError', latencyMs, and fault (the
     injected fault type, or null when the request went through untouched). */
  function planAttempt(env) {
    var f = env.fault || { type: 'none' }, n = env.attempt, rng = env.rng, lat = env.latency || {};
    var latency = Math.max(1, Math.round(num(lat.baseMs, 120) + rng() * num(lat.jitterMs, 40)));
    var N = num(f.n, 1), injected = true;
    function handle() { return env.exec(); }
    function done(r) { r.kind = r.kind || 'response'; r.latencyMs = r.latencyOverride || r.latencyMs || latency; r.fault = injected && f.type !== 'none' ? f.type : null; return r; }

    switch (f.type) {
      case 'drop-first-n':
        if (n <= N) return done({ kind: 'network', latencyMs: Math.max(1, Math.round(latency / 3)), message: 'Connection reset before any response' });
        break;
      case 'drop-after-process':
        if (n <= N) { handle(); return done({ kind: 'network', message: 'Connection closed before the response arrived. The server had already processed the request.', processed: true }); }
        break;
      case 'fail-first-n':
        if (n <= N) {
          var ra = (f.retryAfter === '' || f.retryAfter == null) ? null : num(f.retryAfter, null);
          return done(errorResponse(num(f.status, 503), ra != null ? { 'retry-after': String(Math.round(ra)) } : null));
        }
        break;
      case 'random':
        if (rng() * 100 < num(f.pct, 30)) return done(errorResponse([500, 502, 503, 504][Math.floor(rng() * 4)]));
        break;
      case 'always':
        return done(errorResponse(num(f.status, 500)));
      case 'rate-limit-until':
        var until = num(f.sec, 4) * 1000;
        if (env.t < until) {
          return done(jsonResp(429, { error: 'rate_limited', message: 'Too many requests' },
            { 'retry-after': String(Math.ceil((until - env.t) / 1000)), 'x-ratelimit-remaining': '0' }));
        }
        break;
      case 'slow-first-n':
        if (n <= N) { var s = handle(); s.latencyMs = num(f.slowMs, 5000); s.latencyOverride = 0; return done(s); }
        break;
      case 'truncated-first-n':
        if (n <= N) {
          var t = handle();
          if (t.body) {
            t.headers['content-length'] = String(t.body.length);
            return done({ kind: 'bodyError', status: t.status, headers: t.headers, fullLength: t.body.length, route: t.route, body: t.body.slice(0, Math.max(1, Math.floor(t.body.length / 2))), message: 'Connection closed after part of the body' });
          }
          injected = false;
          return done(t);
        }
        break;
      case 'malformed':
        var mres = handle();
        if (mres.status >= 200 && mres.status < 300 && mres.body) mres.body = '{"items": [{"id": 1, "name": "Widget", ';
        else injected = false;
        return done(mres);
    }
    injected = false;
    return done(handle());
  }
  /* True when a fault is limited to some paths (fault.path, a prefix) and this request is outside them. */
  function faultApplies(fault, path) {
    if (!fault || !fault.type || fault.type === 'none') return false;
    var pre = String(fault.path == null ? '' : fault.path).trim();
    return !pre || String(path).indexOf(pre) === 0;
  }

  /* ---------- clocks ---------- */
  function virtualClock() {
    var v = 0;
    return { now: function () { return v; }, sleep: function (ms) { v += ms; return Promise.resolve(); } };
  }
  function realClock(signal) {
    var t0 = Date.now();
    return {
      now: function () { return Date.now() - t0; },
      sleep: function (ms) {
        return new Promise(function (resolve, reject) {
          if (signal && signal.aborted) return reject({ cancelled: true });
          var id = setTimeout(function () { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
          function onAbort() { clearTimeout(id); reject({ cancelled: true }); }
          if (signal) signal.addEventListener('abort', onAbort);
        });
      }
    };
  }

  /* ---------- retry policy ---------- */
  function defaultPolicy() {
    return {
      strategy: 'exponential', baseMs: 500, factor: 2, maxMs: 30000, maxAttempts: 4, timeoutMs: 3000,
      retryOn: { s5xx: true, s429: true, s408: true, network: true, timeout: true },
      honorRetryAfter: true, safeRetry: true
    };
  }
  function defaultConfig() {
    return {
      target: 'sim', realTime: false, seed: 42,
      request: { method: 'GET', url: SIM_ORIGIN + '/items', headers: [{ name: 'Accept', value: 'application/json', enabled: true }], body: '' },
      fault: { type: 'fail-first-n', n: 2, status: 503, retryAfter: '' },
      latency: { baseMs: 120, jitterMs: 40 },
      policy: defaultPolicy()
    };
  }
  function backoffDelay(p, n, rng) {
    var base = num(p.baseMs, 500), cap = num(p.maxMs, 30000), f = num(p.factor, 2), d;
    var expo = Math.min(cap, base * Math.pow(f, n - 1));
    switch (p.strategy) {
      case 'none': return 0;
      case 'fixed': d = base; break;
      case 'linear': d = base * n; break;
      case 'exponential': d = base * Math.pow(f, n - 1); break;
      case 'full-jitter': return Math.round(rng() * expo);
      case 'equal-jitter': return Math.round(expo / 2 + rng() * expo / 2);
      default: d = base;
    }
    return Math.round(Math.min(cap, d));
  }
  function classify(rec) {
    if (rec.kind === 'timeout') return 'timeout';
    if (rec.kind === 'network' || rec.kind === 'bodyError') return 'network';
    if (rec.status < 400) return 'ok';
    if (rec.status === 429) return 's429';
    if (rec.status === 408) return 's408';
    if (rec.status >= 500) return 's5xx';
    return '4xx';
  }
  function decide(p, method, hasKey, rec, n, maxAttempts, rng) {
    var cls = classify(rec);
    if (cls === 'ok') return { type: 'success' };
    var allowed = { timeout: p.retryOn.timeout, network: p.retryOn.network, s429: p.retryOn.s429, s408: p.retryOn.s408, s5xx: p.retryOn.s5xx, '4xx': false }[cls];
    if (!allowed) return { type: 'nonretryable', reason: cls === '4xx' ? 'client error' : 'this kind of failure is switched off in your retry rules' };
    if (p.strategy === 'none') return { type: 'max', reason: 'retries are off' };
    if (p.safeRetry && (method === 'POST' || method === 'PATCH') && !hasKey) {
      return { type: 'unsafe', reason: method + ' without an Idempotency-Key' };
    }
    if (n >= maxAttempts) return { type: 'max', reason: 'all attempts used' };
    var backoff = backoffDelay(p, n, rng);
    var wait = backoff, why = 'backoff';
    var ra = rec.headers ? parseRetryAfter(rec.headers['retry-after']) : null;
    rec.retryAfterMs = ra;
    if (ra != null && p.honorRetryAfter) {
      if (ra > num(p.maxMs, 30000)) return { type: 'cap', reason: 'Retry-After of ' + fmtMs(ra) + ' is longer than your max delay of ' + fmtMs(num(p.maxMs, 30000)) };
      if (ra >= backoff) { wait = ra; why = 'retry-after'; }
    }
    rec.backoffMs = backoff;
    return { type: 'retry', waitMs: wait, waitReason: why };
  }

  /* ---------- runner ---------- */
  async function simAttempt(cfg, server, clock, n, start, faultRng) {
    var d = simulateAttempt({ cfg: cfg, fault: cfg.fault, attempt: n, t: start, rng: faultRng, server: server });
    var timeout = num(cfg.policy.timeoutMs, 0) > 0 ? num(cfg.policy.timeoutMs, 0) : Infinity;
    if (d.latencyMs > timeout) {
      await clock.sleep(timeout);
      return { kind: 'timeout', durationMs: timeout, seen: d.seen, message: 'No response within ' + fmtMs(timeout) };
    }
    await clock.sleep(d.latencyMs);
    d.durationMs = d.latencyMs;
    return d;
  }
  async function realAttempt(cfg, prep) {
    var req = cfg.request, method = String(req.method).toUpperCase();
    var ac = new AbortController(), timedOut = false, userAbort = false;
    var timeout = num(cfg.policy.timeoutMs, 0);
    var timer = timeout > 0 ? setTimeout(function () { timedOut = true; ac.abort(); }, timeout) : null;
    var onAbort = function () { userAbort = true; ac.abort(); };
    if (cfg.signal) { if (cfg.signal.aborted) onAbort(); else cfg.signal.addEventListener('abort', onAbort); }
    var t0 = Date.now();
    var headers = new Headers();
    prep.sent.forEach(function (h) { try { headers.append(h.name, h.value); } catch (e) { /* skip invalid */ } });
    try {
      var init = { method: method, headers: headers, signal: ac.signal, cache: 'no-store' };
      if (method !== 'GET' && method !== 'HEAD' && req.body) init.body = req.body;
      var r = await fetch(normalizeUrl(req.url, true), init);
      var text = await r.text();
      var hs = {};
      r.headers.forEach(function (v, k) { hs[k] = v; });
      return { kind: 'response', status: r.status, headers: hs, body: text, durationMs: Date.now() - t0 };
    } catch (e) {
      if (userAbort) throw { cancelled: true };
      if (timedOut) return { kind: 'timeout', durationMs: Date.now() - t0, message: 'No response within ' + fmtMs(timeout) };
      return { kind: 'network', durationMs: Date.now() - t0, message: (e && e.message) || 'Network error', realFailure: true };
    } finally {
      if (timer) clearTimeout(timer);
      if (cfg.signal) cfg.signal.removeEventListener('abort', onAbort);
    }
  }

  async function run(cfg) {
    var p = cfg.policy, req = cfg.request, isReal = cfg.target === 'real', isLocal = cfg.target === 'local';
    var method = String(req.method).toUpperCase();
    var seed = num(cfg.seed, 42) >>> 0;
    var faultRng = mulberry32(seed), jitterRng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    var clock = (isReal || isLocal || cfg.realTime) ? realClock(cfg.signal) : virtualClock();
    var server = cfg.server || newServerState();
    var createdBefore = cfg.probe ? await cfg.probe() : server.created;
    var prep = prepareHeaders(req.headers, isLocal);
    var hasKey = prep.sent.some(function (h) { return h.name.toLowerCase() === 'idempotency-key'; });
    var maxAttempts = p.strategy === 'none' ? 1 : Math.max(1, num(p.maxAttempts, 4) | 0);
    var attempts = [], outcome = 'failed', n = 0, seen = null;
    try {
      while (true) {
        n++;
        var start = clock.now();
        var res = cfg.attempt ? await cfg.attempt({ n: n, prep: prep, cfg: cfg, url: normalizeUrl(req.url, urlBase(cfg)) })
          : isReal ? await realAttempt(cfg, prep) : await simAttempt(cfg, server, clock, n, start, faultRng);
        if (res.seen && !seen) seen = res.seen;
        var rec = { n: n, startMs: start, durationMs: res.durationMs, kind: res.kind, status: res.status, headers: res.headers || {}, body: res.body, message: res.message, realFailure: res.realFailure, code: res.code, note: res.note };
        var dec = decide(p, method, hasKey, rec, n, maxAttempts, jitterRng);
        rec.decision = dec.type; rec.reason = dec.reason; rec.waitMs = dec.waitMs || 0; rec.waitReason = dec.waitReason;
        attempts.push(rec);
        if (cfg.onAttempt) cfg.onAttempt(rec, attempts);
        if (dec.type === 'retry') { await clock.sleep(dec.waitMs); continue; }
        outcome = dec.type === 'success' ? 'success' : (dec.type === 'unsafe' ? 'not-retried' : 'failed');
        break;
      }
    } catch (e) {
      if (e && e.cancelled) outcome = 'cancelled'; else throw e;
    }
    var last = attempts[attempts.length - 1] || null;
    var createdAfter = createdBefore;
    try { createdAfter = cfg.probe ? await cfg.probe() : server.created; } catch (e) { /* the count is only used for a note */ }
    var result = {
      outcome: outcome, attempts: attempts, final: last, totalMs: last ? last.startMs + last.durationMs : 0,
      seen: seen, server: server, createdDuring: Math.max(0, num(createdAfter, 0) - num(createdBefore, 0)), hasKey: hasKey
    };
    result.notes = explain(result, cfg);
    return result;
  }

  async function compare(cfg) {
    var variants = [
      { name: 'No retries', p: { strategy: 'none' } },
      { name: 'Fixed, 500 ms', p: { strategy: 'fixed', baseMs: 500, maxAttempts: 4 } },
      { name: 'Exponential from 500 ms', p: { strategy: 'exponential', baseMs: 500, factor: 2, maxAttempts: 4 } },
      { name: 'Exponential + full jitter', p: { strategy: 'full-jitter', baseMs: 500, factor: 2, maxAttempts: 4 } },
      { name: 'Your settings', p: {} }
    ];
    var rows = [];
    for (var i = 0; i < variants.length; i++) {
      var c = clone(cfg);
      c.target = 'sim'; c.realTime = false; c.signal = undefined; c.onAttempt = undefined; c.attempt = undefined; c.probe = undefined;
      c.policy = Object.assign({}, cfg.policy, variants[i].p);
      c.server = newServerState({ routes: cfg.server && cfg.server.routes, builtins: !cfg.server || cfg.server.builtins });
      var r = await run(c);
      rows.push({ name: variants[i].name, attempts: r.attempts.length, totalMs: r.totalMs, outcome: r.outcome,
        label: r.final ? (r.final.kind === 'response' ? 'HTTP ' + r.final.status : r.final.kind === 'timeout' ? 'Timed out' : 'Connection failed') : '-' });
    }
    return rows;
  }

  /* ---------- plain-language notes ---------- */
  function explain(result, cfg) {
    var notes = [], a = result.attempts, p = cfg.policy, method = String(cfg.request.method).toUpperCase();
    var last = a[a.length - 1];
    if (!last) return notes;
    if (result.outcome === 'success') {
      notes.push(a.length === 1 ? 'Succeeded on the first attempt (' + fmtMs(result.totalMs) + ').'
        : 'Succeeded on attempt ' + a.length + ' after ' + (a.length - 1) + (a.length === 2 ? ' retry' : ' retries') + ', ' + fmtMs(result.totalMs) + ' in total.');
    }
    a.forEach(function (r) {
      if (r.kind === 'response' && r.headers && r.headers['retry-after'] != null && r.status >= 400) {
        var ra = r.headers['retry-after'];
        if (r.waitReason === 'retry-after') {
          notes.push('Attempt ' + r.n + ' got HTTP ' + r.status + ' with Retry-After: ' + ra + '. The client waited ' + fmtMs(r.waitMs) + ' as the server asked, instead of its own backoff of ' + fmtMs(r.backoffMs) + '.');
        } else if (!p.honorRetryAfter && r.decision === 'retry') {
          notes.push('Attempt ' + r.n + ' got HTTP ' + r.status + ' with Retry-After: ' + ra + ', but "Honor Retry-After" is off, so the client retried after ' + fmtMs(r.waitMs) + ' and risks being rejected again.');
        }
      }
      if (r.kind === 'bodyError') notes.push('Attempt ' + r.n + ': headers arrived but the body was cut short. Clients treat a read error like a network failure.');
    });
    if (last.decision === 'nonretryable' && last.kind === 'response') {
      var s = last.status, why;
      if (s === 401) why = 'A 401 means credentials are missing or wrong. Retrying cannot fix that: change the Authorization header.';
      else if (s === 415) why = 'A 415 means the Content-Type is not accepted. Retrying will not help: send Content-Type: application/json.';
      else if (s === 406) why = 'A 406 means the Accept header asks for a format the server does not offer.';
      else if (s === 404) why = 'A 404 will not change on retry: check the URL.';
      else if (s === 422 || s === 400) why = 'HTTP ' + s + ' says the request itself is invalid. Retrying sends the same invalid request.';
      else why = 'HTTP ' + s + ' is not retried by your rules.';
      notes.push(why);
    }
    if (last.decision === 'unsafe') {
      notes.push(method + ' was not retried because it has no Idempotency-Key. If the first request reached the server, a retry could do the work twice. Add an Idempotency-Key header to retry safely, or switch the safety rule off to see what happens.');
    }
    if (last.decision === 'cap') notes.push('Gave up: ' + last.reason + '.');
    if (last.decision === 'max' && result.outcome === 'failed' && p.strategy !== 'none') notes.push('Gave up after ' + a.length + ' attempts. The last result was ' + describe(last) + '.');
    if (last.decision === 'max' && p.strategy === 'none') notes.push('Retries are off, so the first failure is final.');
    if (method !== 'GET' && method !== 'HEAD' && a.some(function (r) { return r.kind === 'timeout' || r.kind === 'network'; })) {
      notes.push('A timeout or dropped connection does not tell you whether the server did the work. For ' + method + ' requests that is why retries need an Idempotency-Key.');
    }
    if (cfg.target !== 'real' && method === 'POST') {
      if (result.createdDuring > 1) notes.push('The server created ' + result.createdDuring + ' items from this one request. That is the duplicate problem: add an Idempotency-Key header and send again (reset the server data first).');
      else if (result.createdDuring === 1 && a.length > 1 && last.headers && last.headers['idempotent-replayed']) notes.push('The retry carried the same Idempotency-Key, so the server returned its stored response instead of creating a second item (see the Idempotent-Replayed header).');
    }
    if (last.kind === 'response' && last.status < 400 && last.body && /json/i.test(last.headers['content-type'] || '')) {
      try { JSON.parse(last.body); } catch (e) { notes.push('HTTP ' + last.status + ' arrived, but the body is not valid JSON. A success status does not guarantee usable data: validate before you use it.'); }
    }
    var CODES = {
      ECONNREFUSED: 'Nothing is listening at that address. Check the port, and that the server is running.',
      ECONNRESET: 'The server closed the connection without answering.',
      ENOTFOUND: 'That host name could not be found. Check the spelling of the address.',
      EAI_AGAIN: 'The host name lookup failed. Check your network connection.',
      ETIMEDOUT: 'The connection attempt timed out before the server answered.',
      EHOSTUNREACH: 'That address cannot be reached from this machine.',
      CERT: 'The TLS certificate was not accepted. For a self-signed local certificate, start tinypdf-mock with --insecure.'
    };
    if (last.code) {
      var hint = CODES[last.code] || (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(last.code) ? CODES.CERT : null);
      if (hint) notes.push(last.code + ': ' + hint);
    }
    a.forEach(function (r) { if (r.note && notes.indexOf(r.note) < 0) notes.push(r.note); });
    if (last.realFailure) notes.push('"Failed to fetch" is all a browser reveals. Common causes: the server sends no CORS headers (Access-Control-Allow-Origin), the address is wrong or offline, an http: address is called from this https: page, or an extension blocks it.');
    return notes;
  }
  function describe(r) {
    if (r.kind === 'response') return 'HTTP ' + r.status;
    if (r.kind === 'timeout') return 'a timeout';
    if (r.kind === 'bodyError') return 'a cut-off body';
    return 'a connection failure';
  }

  /* ---------- code snippets ---------- */
  function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
  function snippets(cfg) {
    var p = cfg.policy, r = cfg.request, method = String(r.method).toUpperCase();
    var url = normalizeUrl(r.url, urlBase(cfg));
    var heads = prepareHeaders(r.headers, cfg.target === 'local').sent;
    var hasBody = !!r.body && method !== 'GET' && method !== 'HEAD';
    var simNote = (cfg.target !== 'real' && cfg.target !== 'local') ? '(' + SIM_ORIGIN + ' exists only in this simulator; replace it with your API)' : '';
    var max = p.strategy === 'none' ? 1 : Math.max(1, num(p.maxAttempts, 4) | 0);
    var timeoutS = num(p.timeoutMs, 0) / 1000;

    /* curl */
    var c = [];
    if (simNote) c.push('# ' + simNote);
    c.push('curl -X ' + method + ' ' + shq(url) + ' \\');
    heads.forEach(function (h) { c.push('  -H ' + shq(h.name + ': ' + h.value) + ' \\'); });
    if (hasBody) c.push('  --data-raw ' + shq(r.body) + ' \\');
    if (timeoutS > 0) c.push('  --max-time ' + timeoutS + ' \\');
    if (max > 1) {
      var tail = '  --retry ' + (max - 1);
      if (p.strategy === 'fixed') tail += ' --retry-delay ' + Math.max(1, Math.round(num(p.baseMs, 500) / 1000));
      if (p.retryOn.network) tail += ' --retry-all-errors';
      c.push(tail + ' \\');
    }
    c.push('  -i');
    var curl = c.join('\n') + (max > 1 ? '\n# curl backs off exponentially (1 s, 2 s, 4 s...) unless --retry-delay is set, and it honors Retry-After.' : '');

    /* fetch */
    var jsB;
    var b = num(p.baseMs, 500), cap = num(p.maxMs, 30000), f = num(p.factor, 2);
    switch (p.strategy) {
      case 'fixed': jsB = 'const backoff = () => ' + b + ';'; break;
      case 'linear': jsB = 'const backoff = (n) => Math.min(' + cap + ', ' + b + ' * n);'; break;
      case 'exponential': jsB = 'const backoff = (n) => Math.min(' + cap + ', ' + b + ' * ' + f + ' ** (n - 1));'; break;
      case 'full-jitter': jsB = 'const backoff = (n) => Math.random() * Math.min(' + cap + ', ' + b + ' * ' + f + ' ** (n - 1));'; break;
      case 'equal-jitter': jsB = 'const backoff = (n) => {\n  const e = Math.min(' + cap + ', ' + b + ' * ' + f + ' ** (n - 1));\n  return e / 2 + Math.random() * e / 2;\n};'; break;
      default: jsB = 'const backoff = () => 0;';
    }
    var cond = [];
    if (p.retryOn.s5xx) cond.push('status >= 500');
    if (p.retryOn.s429) cond.push('status === 429');
    if (p.retryOn.s408) cond.push('status === 408');
    var errRetry = p.retryOn.network || p.retryOn.timeout;
    var hdrObj = heads.length ? '{\n' + heads.map(function (h) { return '    ' + JSON.stringify(h.name) + ': ' + JSON.stringify(h.value); }).join(',\n') + '\n  }' : '{}';
    var js = [];
    if (simNote) js.push('// ' + simNote);
    js.push('const MAX_ATTEMPTS = ' + max + ';', 'const TIMEOUT_MS = ' + (num(p.timeoutMs, 0) || 0) + ';', jsB,
      'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
      'const shouldRetry = (status) => ' + (cond.length ? cond.join(' || ') : 'false') + ';', '',
      'async function fetchWithRetry(url, options) {',
      '  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {',
      '    const ctrl = new AbortController();',
      '    const timer = TIMEOUT_MS ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;',
      '    let res;',
      '    try {',
      '      res = await fetch(url, { ...options, signal: ctrl.signal });',
      '    } catch (err) {',
      '      clearTimeout(timer);',
      '      if (' + (errRetry ? 'attempt === MAX_ATTEMPTS' : 'true') + ') throw err;',
      '      await sleep(backoff(attempt));',
      '      continue;',
      '    }',
      '    clearTimeout(timer);',
      '    if (!shouldRetry(res.status) || attempt === MAX_ATTEMPTS) return res;');
    if (p.honorRetryAfter) js.push('    const retryAfter = Number(res.headers.get("Retry-After")) * 1000 || 0;', '    await sleep(Math.max(retryAfter, backoff(attempt)));');
    else js.push('    await sleep(backoff(attempt));');
    js.push('  }', '}', '',
      'const res = await fetchWithRetry(' + JSON.stringify(url) + ', {',
      '  method: ' + JSON.stringify(method) + ',',
      '  headers: ' + hdrObj + ',' + (hasBody ? '\n  body: ' + JSON.stringify(r.body) + ',' : ''),
      '});',
      'console.log(res.status, await res.text());');

    /* python */
    var pyB;
    var bs = b / 1000, caps = cap / 1000;
    switch (p.strategy) {
      case 'fixed': pyB = 'def backoff(n):\n    return ' + bs; break;
      case 'linear': pyB = 'def backoff(n):\n    return min(' + caps + ', ' + bs + ' * n)'; break;
      case 'exponential': pyB = 'def backoff(n):\n    return min(' + caps + ', ' + bs + ' * ' + f + ' ** (n - 1))'; break;
      case 'full-jitter': pyB = 'def backoff(n):\n    return random.uniform(0, min(' + caps + ', ' + bs + ' * ' + f + ' ** (n - 1)))'; break;
      case 'equal-jitter': pyB = 'def backoff(n):\n    e = min(' + caps + ', ' + bs + ' * ' + f + ' ** (n - 1))\n    return e / 2 + random.uniform(0, e / 2)'; break;
      default: pyB = 'def backoff(n):\n    return 0';
    }
    var pcond = [];
    if (p.retryOn.s5xx) pcond.push('status >= 500');
    if (p.retryOn.s429) pcond.push('status == 429');
    if (p.retryOn.s408) pcond.push('status == 408');
    var py = [];
    if (simNote) py.push('# ' + simNote);
    py.push('import random', 'import time', 'import requests', '',
      'URL = ' + JSON.stringify(url),
      'METHOD = ' + JSON.stringify(method),
      'HEADERS = {' + heads.map(function (h) { return JSON.stringify(h.name) + ': ' + JSON.stringify(h.value); }).join(', ') + '}',
      hasBody ? 'BODY = ' + JSON.stringify(r.body) : 'BODY = None',
      'MAX_ATTEMPTS = ' + max,
      'TIMEOUT_S = ' + (timeoutS > 0 ? timeoutS : 'None'), '', pyB, '',
      'def should_retry(status):',
      '    return ' + (pcond.length ? pcond.join(' or ') : 'False'), '',
      'for attempt in range(1, MAX_ATTEMPTS + 1):',
      '    try:',
      '        res = requests.request(METHOD, URL, headers=HEADERS, data=BODY, timeout=TIMEOUT_S)',
      '    except requests.RequestException:',
      '        if ' + (errRetry ? 'attempt == MAX_ATTEMPTS' : 'True') + ':',
      '            raise',
      '        time.sleep(backoff(attempt))',
      '        continue',
      '    if not should_retry(res.status_code) or attempt == MAX_ATTEMPTS:',
      '        break');
    if (p.honorRetryAfter) py.push('    retry_after = res.headers.get("Retry-After", "")', '    wait = float(retry_after) if retry_after.isdigit() else 0', '    time.sleep(max(wait, backoff(attempt)))');
    else py.push('    time.sleep(backoff(attempt))');
    py.push('', 'print(res.status_code, res.text)');

    return { curl: curl, fetch: js.join('\n'), python: py.join('\n') };
  }

  /* ---------- ready-made examples ---------- */
  var EXAMPLES = [
    { id: 'flaky', title: 'Flaky server: 503 twice, then success', desc: 'Two transient failures, then a healthy response. Watch exponential backoff space out the retries.',
      request: { method: 'GET', url: SIM_ORIGIN + '/items', headers: [{ name: 'Accept', value: 'application/json', enabled: true }], body: '' },
      fault: { type: 'fail-first-n', n: 2, status: 503, retryAfter: '' } },
    { id: 'rate-limit', title: 'Rate limited: 429 with Retry-After', desc: 'The server says wait 4 seconds. Turn off "Honor Retry-After" and send again to see attempts wasted.',
      request: { method: 'GET', url: SIM_ORIGIN + '/items', headers: [{ name: 'Accept', value: 'application/json', enabled: true }], body: '' },
      fault: { type: 'rate-limit-until', sec: 4 }, policy: { baseMs: 250 } },
    { id: 'timeouts', title: 'Timeouts: slow server, short timeout', desc: 'The first two responses take 5 s but the timeout is 2 s. Change the timeout to 6000 and compare.',
      request: { method: 'GET', url: SIM_ORIGIN + '/items', headers: [{ name: 'Accept', value: 'application/json', enabled: true }], body: '' },
      fault: { type: 'slow-first-n', n: 2, slowMs: 5000 }, policy: { timeoutMs: 2000 } },
    { id: 'duplicate-post', title: 'POST retried: duplicate vs Idempotency-Key', desc: 'The server creates the item, then the response is lost. Without a key the retry creates a duplicate. Tick the Idempotency-Key row, reset the simulated server and send again.',
      request: { method: 'POST', url: SIM_ORIGIN + '/items',
        headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }, { name: 'Idempotency-Key', value: 'order-123', enabled: false }],
        body: '{\n  "name": "Gizmo",\n  "price": 12\n}' },
      fault: { type: 'drop-after-process', n: 1 }, policy: { safeRetry: false } },
    { id: 'safe-retry', title: 'POST not retried without a key', desc: 'The same lost response, but the safety rule is on: the client refuses to retry an unsafe POST.',
      request: { method: 'POST', url: SIM_ORIGIN + '/items',
        headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
        body: '{\n  "name": "Gizmo",\n  "price": 12\n}' },
      fault: { type: 'drop-after-process', n: 1 } },
    { id: 'auth', title: 'Wrong token: 401 is not retried', desc: 'A client error will not fix itself. Change the token to secret123 and send again.',
      request: { method: 'GET', url: SIM_ORIGIN + '/secure', headers: [{ name: 'Authorization', value: 'Bearer wrong-token', enabled: true }], body: '' },
      fault: { type: 'none' } },
    { id: 'content-type', title: 'Wrong Content-Type: 415', desc: 'The body is JSON but the header says text/plain. Fix the Content-Type row.',
      request: { method: 'POST', url: SIM_ORIGIN + '/items',
        headers: [{ name: 'Content-Type', value: 'text/plain', enabled: true }], body: '{ "name": "Gizmo" }' },
      fault: { type: 'none' } },
    { id: 'etag', title: 'Conditional GET: 304 Not Modified', desc: 'If-None-Match matches the current ETag, so the server sends no body. Change the value and send again.',
      request: { method: 'GET', url: SIM_ORIGIN + '/items', headers: [{ name: 'If-None-Match', value: 'W/"items-1"', enabled: true }], body: '' },
      fault: { type: 'none' } },
    { id: 'echo', title: 'Which headers does the server really see?', desc: 'Cookie is a forbidden header: browsers drop it silently. X-Debug is kept. Compare "Request as the server saw it".',
      request: { method: 'GET', url: SIM_ORIGIN + '/headers',
        headers: [{ name: 'Cookie', value: 'session=abc123', enabled: true }, { name: 'X-Debug', value: '1', enabled: true }, { name: 'Accept', value: 'application/json', enabled: true }], body: '' },
      fault: { type: 'none' } },
    { id: 'truncated', title: 'Body cut off mid-response', desc: 'Headers arrive, then the connection closes. The client sees a read error and retries.',
      request: { method: 'GET', url: SIM_ORIGIN + '/items', headers: [{ name: 'Accept', value: 'application/json', enabled: true }], body: '' },
      fault: { type: 'truncated-first-n', n: 1 } },
    { id: 'malformed', title: '200 OK with invalid JSON', desc: 'The status is fine, the body is broken. Status codes alone are not enough.',
      request: { method: 'GET', url: SIM_ORIGIN + '/items', headers: [{ name: 'Accept', value: 'application/json', enabled: true }], body: '' },
      fault: { type: 'malformed' } }
  ];
  /* A small starter set, used by "Add sample routes" and by `tinypdf-mock init`. */
  var SAMPLE_ROUTES = [
    { method: 'GET', path: '/users', status: 200, body: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Linus' }] },
    { method: 'GET', path: '/users/:id', status: 200, body: { id: '{{params.id | number}}', name: 'User {{params.id}}', fetchedAt: '{{now}}' } },
    { method: 'POST', path: '/users', status: 201, headers: { Location: '/users/3' }, body: { id: 3, name: '{{body.name}}' } },
    { method: 'DELETE', path: '/users/:id', status: 204 },
    { method: 'GET', path: '/slow', status: 200, delayMs: 2000, body: { ok: true } }
  ];
  function exampleConfig(id) {
    var ex = EXAMPLES.filter(function (e) { return e.id === id; })[0];
    if (!ex) return null;
    var cfg = defaultConfig();
    cfg.request = clone(ex.request);
    cfg.fault = clone(ex.fault);
    if (ex.policy) cfg.policy = Object.assign(cfg.policy, clone(ex.policy));
    return cfg;
  }

  return {
    SIM_ORIGIN: SIM_ORIGIN, STATUS_TEXT: STATUS_TEXT, FAULTS: FAULTS, EXAMPLES: EXAMPLES, SAMPLE_ROUTES: SAMPLE_ROUTES,
    handle: handle, planAttempt: planAttempt, faultApplies: faultApplies, normalizeRoutes: normalizeRoutes, matchRoute: matchRoute,
    lowerMap: lowerMap, parseRetryAfter: parseRetryAfter, clone: clone,
    newServerState: newServerState, defaultConfig: defaultConfig, defaultPolicy: defaultPolicy, exampleConfig: exampleConfig,
    run: run, compare: compare, validate: validate, snippets: snippets, explain: explain,
    isForbiddenHeader: isForbiddenHeader, prepareHeaders: prepareHeaders, backoffDelay: backoffDelay,
    mulberry32: mulberry32, fmtMs: fmtMs, normalizeUrl: normalizeUrl, num: num
  };
});
