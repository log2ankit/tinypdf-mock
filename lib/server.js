/* tinypdf-mock: a local mock API with fault injection, a request log and a control page.
   No dependencies. The mock rules and faults come from sim-core.js, the same file the
   REST API Playground on tinypdf.in runs in the browser. */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const core = require('./sim-core.js');
const pkg = require('../package.json');

const PREFIX = '/__mock';
const UI_DIR = path.join(__dirname, '..', 'ui');
const DEFAULT_PORT = 4747;
const DEFAULT_ORIGINS = ['https://tinypdf.in'];
const MAX_BODY = 5 * 1024 * 1024;      // largest request body the mock accepts
const MAX_LOG_BODY = 64 * 1024;        // how much of a body is kept in the request log
const MAX_SEND_BODY = 2 * 1024 * 1024; // how much of a response the sender reads
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function clip(text, max) {
  text = text == null ? '' : String(text);
  return text.length > max ? text.slice(0, max) : text;
}
function hostName(host) {
  host = String(host || '').toLowerCase();
  if (host.charAt(0) === '[') return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0];
}
function cleanFault(f) {
  if (!f || typeof f !== 'object' || !f.type) return { type: 'none' };
  const def = core.FAULTS.filter((x) => x.type === f.type)[0];
  if (!def) throw new Error('Unknown fault "' + f.type + '". Known faults: ' + core.FAULTS.map((x) => x.type).join(', '));
  const out = { type: def.type };
  def.fields.forEach((fd) => { out[fd.key] = f[fd.key] == null ? fd.def : f[fd.key]; });
  if (f.path) out.path = String(f.path);
  return out;
}

function createMockServer(options) {
  options = options || {};
  const events = new EventEmitter();
  const token = options.token || crypto.randomBytes(12).toString('hex');
  const allowOrigins = DEFAULT_ORIGINS.concat(options.allowOrigins || []).map((o) => String(o).replace(/\/+$/, ''));
  const maxLog = options.maxLog > 0 ? options.maxLog : 200;
  const bindHost = options.host || 'localhost';
  const loopbackOnly = LOOPBACK.indexOf(bindHost) >= 0;
  const cfg = {
    fault: cleanFault(options.fault),
    latency: { baseMs: Math.max(0, core.num(options.latency && options.latency.baseMs, 0)), jitterMs: Math.max(0, core.num(options.latency && options.latency.jitterMs, 0)) },
    seed: core.num(options.seed, 42),
    cors: options.cors !== false,
    repeat: options.repeat !== false
  };
  const first = core.normalizeRoutes(options.routes || []);
  if (first.errors.length) throw new Error(first.errors.join(' '));
  let data = core.newServerState({ routes: first.routes, builtins: options.builtins !== false });
  let rng = core.mulberry32(cfg.seed >>> 0);
  let counters = new Map();
  let log = [];
  let seq = 0;
  let port = 0;
  const servers = [];
  const streams = new Set();
  let beat = null;

  /* ---------- small helpers ---------- */
  function baseUrl() { return 'http://localhost:' + port; }
  function publicConfig() { return Object.assign({}, core.clone(cfg), { builtins: data.builtins }); }
  function broadcast(event, payload) {
    const text = 'event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n';
    streams.forEach((res) => { try { res.write(text); } catch (e) { /* the tab went away */ } });
  }
  function json(res, status, obj, extra) {
    const body = JSON.stringify(obj);
    res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }, extra || {}));
    res.end(body);
  }
  function readBody(req, limit, cb) {
    const chunks = []; let size = 0, over = false;
    req.on('data', (c) => { size += c.length; if (size <= limit) chunks.push(c); else over = true; });
    req.on('end', () => cb(over, Buffer.concat(chunks), size));
    req.on('error', () => { /* the client went away; 'close' on the response handles it */ });
  }
  function record(entry) {
    log.push(entry);
    if (log.length > maxLog) log.splice(0, log.length - maxLog);
    broadcast('request', entry);
    events.emit('request', entry);
  }

  /* ---------- the mock API ---------- */
  function corsHeaders(req, exposed) {
    if (!cfg.cors) return {};
    const origin = req.headers.origin;
    const h = { 'access-control-allow-origin': origin || '*' };
    if (origin) { h['access-control-allow-credentials'] = 'true'; h.vary = 'Origin'; }
    if (exposed && exposed.length) h['access-control-expose-headers'] = exposed.join(', ');
    return h;
  }
  function handleMock(req, res) {
    const startedAt = Date.now();
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const method = String(req.method).toUpperCase();
    readBody(req, MAX_BODY, (over, buf, size) => {
      const body = buf.toString('utf8');
      const entry = {
        id: ++seq, time: new Date(startedAt).toISOString(), method: method, path: url.pathname, query: url.search,
        headers: Object.assign({}, req.headers), body: clip(body, MAX_LOG_BODY), bodyBytes: size
      };
      const finish = (extra) => { Object.assign(entry, extra, { ms: Date.now() - startedAt }); record(entry); };

      if (cfg.cors && method === 'OPTIONS' && req.headers['access-control-request-method']) {
        const h = corsHeaders(req);
        h['access-control-allow-methods'] = 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS';
        h['access-control-allow-headers'] = req.headers['access-control-request-headers'] || '*';
        h['access-control-max-age'] = '600';
        if (req.headers['access-control-request-private-network']) h['access-control-allow-private-network'] = 'true';
        res.writeHead(204, h); res.end();
        return finish({ kind: 'preflight', status: 204, responseHeaders: h, responseBody: '', fault: null, attempt: 0, route: null });
      }
      if (over) {
        const big = JSON.stringify({ error: 'payload_too_large', message: 'The mock accepts bodies up to ' + (MAX_BODY / 1048576) + ' MB' });
        const bh = Object.assign({ 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(big) }, corsHeaders(req));
        res.writeHead(413, bh); res.end(big);
        return finish({ kind: 'response', status: 413, responseHeaders: bh, responseBody: big, fault: null, attempt: 0, route: null });
      }

      const own = core.matchRoute(data.routes, method, url.pathname);
      let fault = { type: 'none' }, key = 'g ' + method + ' ' + url.pathname;
      if (own && own.route.fault) { fault = own.route.fault; key = 'r' + own.index + ' ' + key; }
      else if (core.faultApplies(cfg.fault, url.pathname)) fault = cfg.fault;
      let counter = counters.get(key);
      if (!counter) { counter = { n: 0, t0: startedAt }; counters.set(key, counter); }
      counter.n++;
      let d;
      try {
        d = core.planAttempt({
          fault: fault, attempt: counter.n, t: startedAt - counter.t0, rng: rng, latency: cfg.latency,
          exec: () => core.handle(data, { method: method, url: url.href, headers: req.headers, body: body })
        });
      } catch (e) {
        d = { kind: 'response', status: 500, headers: { 'content-type': 'application/json; charset=utf-8' }, latencyMs: 0, fault: null,
          body: JSON.stringify({ error: 'mock_failed', message: String(e && e.message || e) }) };
      }
      if (fault.type !== 'none' && !d.fault && cfg.repeat) counters.delete(key);
      if (cfg.latency.baseMs + cfg.latency.jitterMs === 0 && d.latencyMs <= 1) d.latencyMs = 0;

      const seen = { kind: d.kind, status: d.status, fault: d.fault, attempt: counter.n, route: d.route || null };
      let timer = null, sent = false;
      const perform = () => {
        timer = null; sent = true;
        if (d.kind === 'network') {
          req.socket.destroy();
          return finish(Object.assign(seen, { status: null, responseHeaders: {}, responseBody: '', message: d.message }));
        }
        const headers = Object.assign({}, d.headers);
        headers.server = 'tinypdf-mock';
        if (d.fault) headers['x-mock-fault'] = d.fault;
        Object.assign(headers, corsHeaders(req, Object.keys(headers)));
        const text = d.body || '';
        const noBody = d.status === 204 || d.status === 304 || method === 'HEAD';
        if (d.kind === 'bodyError') {
          headers['content-length'] = String(Buffer.byteLength(text) * 2 + 2);
          res.writeHead(d.status, headers);
          res.write(text, () => req.socket.destroy());
        } else {
          if (!noBody) headers['content-length'] = String(Buffer.byteLength(text)); else delete headers['content-length'];
          res.writeHead(d.status, headers);
          res.end(noBody ? undefined : text);
        }
        finish(Object.assign(seen, { responseHeaders: headers, responseBody: clip(text, MAX_LOG_BODY), message: d.message }));
      };
      res.on('close', () => {
        if (sent) return;
        if (timer) clearTimeout(timer);
        sent = true;
        finish(Object.assign(seen, { clientClosed: true, responseHeaders: {}, responseBody: '', message: 'The client closed the connection before the mock answered (after ' + (Date.now() - startedAt) + ' ms). The mock was going to wait ' + d.latencyMs + ' ms.' }));
      });
      if (d.latencyMs > 0) timer = setTimeout(perform, d.latencyMs); else perform();
    });
  }

  /* ---------- the control API and page ---------- */
  function setConfig(patch) {
    patch = patch || {};
    if (patch.fault !== undefined) cfg.fault = cleanFault(patch.fault);
    if (patch.latency) {
      cfg.latency = { baseMs: Math.max(0, Math.min(600000, core.num(patch.latency.baseMs, cfg.latency.baseMs))), jitterMs: Math.max(0, Math.min(600000, core.num(patch.latency.jitterMs, cfg.latency.jitterMs))) };
    }
    if (patch.seed !== undefined) { cfg.seed = core.num(patch.seed, cfg.seed); rng = core.mulberry32(cfg.seed >>> 0); }
    if (patch.cors !== undefined) cfg.cors = !!patch.cors;
    if (patch.repeat !== undefined) cfg.repeat = !!patch.repeat;
    if (patch.builtins !== undefined) data.builtins = !!patch.builtins;
    counters = new Map();
  }
  function setRoutes(list) {
    const r = core.normalizeRoutes(list);
    if (r.errors.length) { const e = new Error(r.errors.join(' ')); e.errors = r.errors; throw e; }
    data.routes = r.routes;
    counters = new Map();
    return r.routes;
  }
  function reset() {
    const keep = { routes: data.routes, builtins: data.builtins };
    data = core.newServerState(); data.routes = keep.routes; data.builtins = keep.builtins;
    counters = new Map(); rng = core.mulberry32(cfg.seed >>> 0);
  }
  function state() {
    return { name: pkg.name, version: pkg.version, base: baseUrl(), config: publicConfig(), routes: core.clone(data.routes),
      items: data.items.length, created: data.created, requests: log, canSend: options.send !== false, file: options.file || null };
  }
  function controlHeaders(req) {
    const origin = req.headers.origin;
    if (!origin || allowOrigins.indexOf(origin) < 0) return {};
    return { 'access-control-allow-origin': origin, vary: 'Origin' };
  }
  function ownOrigin(origin) {
    try { const u = new URL(origin); return u.protocol === 'http:' && LOOPBACK.indexOf(hostName(u.host)) >= 0 && String(u.port || 80) === String(port); } catch (e) { return false; }
  }
  function handleControl(req, res, url) {
    const method = String(req.method).toUpperCase();
    const sub = url.pathname.slice(PREFIX.length) || '/';
    const origin = req.headers.origin;
    /* A page on another site must not be able to drive this server: check where the request
       says it comes from, which name it used to reach us, and the token printed at start-up. */
    if (loopbackOnly && LOOPBACK.indexOf(hostName(req.headers.host)) < 0) return json(res, 403, { error: 'forbidden', message: 'Open the control page with the localhost address.' });
    if (origin && !ownOrigin(origin) && allowOrigins.indexOf(origin) < 0) return json(res, 403, { error: 'forbidden', message: 'This origin may not control the mock server. Start it with --allow-origin ' + origin + ' to allow it.' });
    const ch = controlHeaders(req);

    if (method === 'OPTIONS') {
      res.writeHead(204, Object.assign({ 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, x-mock-token, x-mock-client', 'access-control-max-age': '600', 'access-control-allow-private-network': 'true' }, ch));
      return res.end();
    }
    if (sub === '/' && method === 'GET') {
      if (options.ui === false) return json(res, 404, { error: 'no_ui', message: 'The control page is switched off (--no-ui).' });
      if (!url.pathname.endsWith('/')) { res.writeHead(302, { location: PREFIX + '/' }); return res.end(); }
      let html;
      try { html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8'); } catch (e) { return json(res, 500, { error: 'no_ui', message: 'The control page files are missing from this install.' }); }
      const boot = '<script>window.TINY_MOCK=' + JSON.stringify({ token: token, version: pkg.version, base: baseUrl() }) + '</script>';
      html = html.replace('<!--mock-boot-->', boot);
      res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      return res.end(html);
    }
    if (sub.indexOf('/ui/') === 0 && method === 'GET') {
      const name = path.basename(sub);
      const file = name === 'sim-core.js' ? path.join(__dirname, 'sim-core.js') : path.join(UI_DIR, name);
      if (name === 'index.html' || !TYPES[path.extname(name)] || !fs.existsSync(file)) return json(res, 404, { error: 'not_found' });
      res.writeHead(200, { 'content-type': TYPES[path.extname(name)], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      return res.end(fs.readFileSync(file));
    }
    if (sub.indexOf('/api/') !== 0) return json(res, 404, { error: 'not_found' }, ch);
    const given = req.headers['x-mock-token'] || url.searchParams.get('k') || '';
    if (given !== token) return json(res, 401, { error: 'bad_token', message: 'Missing or wrong token. Use the address tinypdf-mock printed when it started.' }, ch);

    const api = sub.slice(4);
    if (api === '/events' && method === 'GET') {
      res.writeHead(200, Object.assign({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' }, ch));
      res.write('retry: 2000\n\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    if (api === '/state' && method === 'GET') return json(res, 200, state(), ch);
    if (api === '/requests' && method === 'DELETE') { log = []; broadcast('cleared', {}); return json(res, 200, { ok: true }, ch); }
    if (api === '/reset' && method === 'POST') { reset(); broadcast('config', { config: publicConfig(), routes: data.routes, by: url.searchParams.get('by') || req.headers['x-mock-client'] || null }); return json(res, 200, state(), ch); }
    if (api === '/rearm' && method === 'POST') { counters = new Map(); return json(res, 200, { ok: true }, ch); }
    if ((api === '/config' || api === '/routes' || api === '/send') && (method === 'PUT' || method === 'POST')) {
      return readBody(req, MAX_BODY, (over, buf) => {
        let body;
        try { body = JSON.parse(buf.toString('utf8') || '{}'); } catch (e) { return json(res, 400, { error: 'invalid_json', message: String(e.message) }, ch); }
        const by = body && body.by || null;
        try {
          if (api === '/config') { setConfig(body); events.emit('config', publicConfig()); }
          else if (api === '/routes') { setRoutes(Array.isArray(body) ? body : body.routes); events.emit('routes', core.clone(data.routes), 'page'); }
          else {
            if (options.send === false) return json(res, 403, { error: 'send_off', message: 'Sending is switched off (--no-send).' }, ch);
            return sendOut(body, res, (out) => { if (!res.writableEnded && !res.destroyed) json(res, 200, out, ch); });
          }
        } catch (e) { return json(res, 400, { error: 'invalid', message: String(e.message), errors: e.errors || [String(e.message)] }, ch); }
        broadcast('config', { config: publicConfig(), routes: data.routes, by: by });
        json(res, 200, state(), ch);
      });
    }
    json(res, 404, { error: 'not_found' }, ch);
  }

  /* Sends one request on behalf of the page. Running it here means there are no CORS rules,
     no blocked headers, and a real reason when a connection fails. */
  function sendOut(spec, resIn, done) {
    spec = spec || {};
    let u;
    try { u = new URL(String(spec.url)); } catch (e) { return done({ kind: 'network', durationMs: 0, message: 'That URL is not valid.' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return done({ kind: 'network', durationMs: 0, message: 'Only http: and https: addresses can be called.' });
    const method = String(spec.method || 'GET').toUpperCase();
    const headers = {};
    (spec.headers || []).forEach((h) => {
      if (!h || !h.name) return;
      const k = String(h.name), v = String(h.value == null ? '' : h.value);
      headers[k] = headers[k] === undefined ? v : [].concat(headers[k], v);
    });
    const hasBody = method !== 'GET' && method !== 'HEAD' && spec.body != null && spec.body !== '';
    const payload = hasBody ? Buffer.from(String(spec.body), 'utf8') : null;
    if (payload && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) headers['Content-Length'] = payload.length;
    const timeoutMs = core.num(spec.timeoutMs, 0);
    const t0 = Date.now();
    let finished = false, timer = null, out = null;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      r.durationMs = Date.now() - t0;
      done(r);
    };
    try {
      out = (u.protocol === 'https:' ? https : http).request(u, { method: method, headers: headers, agent: false, rejectUnauthorized: !options.insecure }, (r) => {
        const chunks = []; let size = 0, cut = false;
        const hs = {};
        Object.keys(r.headers).forEach((k) => { hs[k] = Array.isArray(r.headers[k]) ? r.headers[k].join(', ') : r.headers[k]; });
        const text = () => Buffer.concat(chunks).toString('utf8');
        r.on('data', (c) => { size += c.length; if (size <= MAX_SEND_BODY) chunks.push(c); else cut = true; });
        r.on('end', () => finish({ kind: 'response', status: r.statusCode, statusText: r.statusMessage, headers: hs, body: text(),
          note: cut ? 'The response was larger than ' + (MAX_SEND_BODY / 1048576) + ' MB; only the first part is shown.' : undefined }));
        const broken = () => finish({ kind: 'bodyError', status: r.statusCode, headers: hs, body: text(), message: 'Connection closed after part of the body' });
        r.on('error', broken);
        r.on('aborted', broken);
        r.on('close', () => { if (!r.complete) broken(); });
      });
    } catch (e) {
      return finish({ kind: 'network', message: String(e && e.message || e), code: e && e.code });
    }
    out.on('error', (e) => finish({ kind: 'network', message: (e && e.message) || 'Network error', code: e && e.code }));
    if (timeoutMs > 0) timer = setTimeout(() => { finish({ kind: 'timeout', message: 'No response within ' + core.fmtMs(timeoutMs) }); out.destroy(); }, timeoutMs);
    /* the page pressed Cancel or went away: stop the outgoing request too */
    resIn.on('close', () => { if (!finished) { finished = true; if (timer) clearTimeout(timer); out.destroy(); } });
    out.end(payload || undefined);
  }

  function onRequest(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
    try {
      if (url.pathname === PREFIX || url.pathname.indexOf(PREFIX + '/') === 0) return handleControl(req, res, url);
      handleMock(req, res);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: 'mock_failed', message: String(e && e.message || e) });
    }
  }

  /* ---------- start and stop ---------- */
  function listen(server, p, host) {
    return new Promise((resolve, reject) => {
      const fail = (e) => { server.removeListener('listening', ok); reject(e); };
      const ok = () => { server.removeListener('error', fail); resolve(server.address().port); };
      server.once('error', fail); server.once('listening', ok);
      server.listen(p, host);
    });
  }
  async function start() {
    const wanted = options.port == null ? DEFAULT_PORT : Number(options.port);
    const tries = options.port == null ? 20 : 1;
    const hosts = bindHost === 'localhost' ? ['127.0.0.1', '::1'] : [bindHost];
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      const main = http.createServer(onRequest);
      try { port = await listen(main, wanted === 0 ? 0 : wanted + i, hosts[0]); }
      catch (e) { lastErr = e; if (e.code === 'EADDRINUSE' && i + 1 < tries) continue; throw e; }
      servers.push(main);
      if (hosts[1]) {
        /* "localhost" can mean ::1 as well as 127.0.0.1, so answer on both when the machine has both. */
        const second = http.createServer(onRequest);
        try { await listen(second, port, hosts[1]); servers.push(second); } catch (e) { /* no IPv6 loopback here */ }
      }
      lastErr = null;
      break;
    }
    if (lastErr) throw lastErr;
    beat = setInterval(() => streams.forEach((res) => { try { res.write(': keep-alive\n\n'); } catch (e) { /* gone */ } }), 15000);
    if (beat.unref) beat.unref();
    return api;
  }
  function stop() {
    if (beat) clearInterval(beat);
    streams.forEach((res) => { try { res.end(); } catch (e) { /* gone */ } });
    streams.clear();
    return Promise.all(servers.splice(0).map((s) => new Promise((resolve) => {
      s.close(() => resolve());
      if (s.closeAllConnections) s.closeAllConnections();
    }))).then(() => undefined);
  }

  const api = {
    start: start,
    stop: stop,
    get port() { return port; },
    get url() { return baseUrl(); },
    get token() { return token; },
    get controlUrl() { return baseUrl() + PREFIX + '/'; },
    get connectUrl() { return baseUrl() + '/#k=' + token; },
    /** Requests received so far, oldest first. */
    requests: function () { return log.slice(); },
    clearRequests: function () { log = []; broadcast('cleared', {}); },
    config: publicConfig,
    routes: function () { return core.clone(data.routes); },
    setFault: function (fault) { setConfig({ fault: fault || { type: 'none' } }); broadcast('config', { config: publicConfig(), routes: data.routes, by: null }); },
    setLatency: function (baseMs, jitterMs) { setConfig({ latency: { baseMs: baseMs, jitterMs: jitterMs || 0 } }); broadcast('config', { config: publicConfig(), routes: data.routes, by: null }); },
    setConfig: function (patch) { setConfig(patch); broadcast('config', { config: publicConfig(), routes: data.routes, by: null }); },
    setRoutes: function (list) { const r = setRoutes(list); broadcast('config', { config: publicConfig(), routes: data.routes, by: null }); return r; },
    /** Puts the demo data back and starts every fault count again. Routes stay. */
    reset: function () { reset(); },
    /** Starts every fault count again, so "fail the first N" fails the next N. */
    rearm: function () { counters = new Map(); },
    on: function (name, fn) { events.on(name, fn); return api; },
    off: function (name, fn) { events.off(name, fn); return api; }
  };
  return api;
}

/** Starts a mock server and resolves once it is listening. */
function startMockServer(options) { return createMockServer(options).start(); }

module.exports = { createMockServer, startMockServer, core, DEFAULT_PORT, FAULTS: core.FAULTS };
