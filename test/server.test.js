'use strict';
/* Runs the mock server on a free port and calls it over real HTTP. node --test test/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMockServer, startMockServer } = require('../lib/server.js');

function call(url, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request(url, { method: opts.method || 'GET', headers: opts.headers || {}, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), ms: Date.now() - t0 }));
      res.on('error', (e) => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), cut: true, error: e.code, ms: Date.now() - t0 }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message, ms: Date.now() - t0 }));
    if (opts.timeout) req.setTimeout(opts.timeout, () => req.destroy(Object.assign(new Error('timeout'), { code: 'CLIENT_TIMEOUT' })));
    req.end(opts.body);
  });
}
const json = (r) => JSON.parse(r.body);
async function withMock(options, fn) {
  const mock = await startMockServer(Object.assign({ port: 0, token: 't0k' }, options));
  try { await fn(mock, mock.url); } finally { await mock.stop(); }
}
const ctl = (mock, method, path, body, headers) => call(mock.url + '/__mock/api' + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: Object.assign({ 'x-mock-token': 't0k', 'content-type': 'application/json' }, headers) });

test('demo routes answer and are logged', async () => {
  await withMock({}, async (mock, url) => {
    const r = await call(url + '/items');
    assert.equal(r.status, 200);
    assert.equal(json(r).items.length, 3);
    assert.equal(r.headers.server, 'tinypdf-mock');
    assert.equal(r.headers['access-control-allow-origin'], '*');
    const made = await call(url + '/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Gizmo","price":2}' });
    assert.equal(made.status, 201);
    assert.equal(json(made).id, 4);
    const log = mock.requests();
    assert.equal(log.length, 2);
    assert.equal(log[1].method, 'POST');
    assert.equal(log[1].body, '{"name":"Gizmo","price":2}');
    assert.equal(log[1].status, 201);
    assert.equal((await call(url + '/status/418')).status, 418);
    assert.equal((await call(url + '/nope')).status, 404);
  });
});

test('own routes: params, query, body, typed values, 405 and 204', async () => {
  const routes = [
    { method: 'GET', path: '/users/:id', body: { id: '{{params.id | number}}', q: '{{query.q}}', label: 'User {{params.id}}' } },
    { method: 'POST', path: '/echo', status: 201, headers: { 'X-Kind': 'echo-{{method}}' }, body: { name: '{{body.name}}', tags: '{{body.tags}}' } },
    { method: 'DELETE', path: '/users/:id', status: 204 },
    { method: '*', path: '/files/*', body: 'file {{params.*}}' }
  ];
  await withMock({ routes, builtins: false }, async (mock, url) => {
    const u = await call(url + '/users/42?q=hi%20there');
    assert.deepEqual(json(u), { id: 42, q: 'hi there', label: 'User 42' });
    assert.match(u.headers['content-type'], /application\/json/);
    const e = await call(url + '/echo', { method: 'POST', body: '{"name":"Ada","tags":["a","b"]}' });
    assert.equal(e.status, 201);
    assert.equal(e.headers['x-kind'], 'echo-POST');
    assert.deepEqual(json(e), { name: 'Ada', tags: ['a', 'b'] });
    const d = await call(url + '/users/1', { method: 'DELETE' });
    assert.equal(d.status, 204); assert.equal(d.body, '');
    const f = await call(url + '/files/a/b.txt', { method: 'PUT' });
    assert.equal(f.body, 'file a/b.txt');
    assert.match(f.headers['content-type'], /text\/plain/);
    const wrong = await call(url + '/users/1', { method: 'PATCH' });
    assert.equal(wrong.status, 405);
    assert.equal((await call(url + '/items')).status, 404, 'demo routes are off');
    assert.equal(mock.requests()[0].route, 'GET /users/:id');
  });
});

test('fail-first-n fails N times, succeeds, then starts over; Retry-After is sent', async () => {
  await withMock({ fault: { type: 'fail-first-n', n: 2, status: 503, retryAfter: 7 } }, async (mock, url) => {
    const seen = [];
    for (let i = 0; i < 6; i++) seen.push((await call(url + '/items')).status);
    assert.deepEqual(seen, [503, 503, 200, 503, 503, 200]);
    const first = await call(url + '/items');
    assert.equal(first.headers['retry-after'], '7');
    assert.equal(first.headers['x-mock-fault'], 'fail-first-n');
    assert.equal((await call(url + '/headers')).status, 503, 'each address has its own count');
  });
  await withMock({ fault: { type: 'fail-first-n', n: 1, status: 500 }, repeat: false }, async (mock, url) => {
    const seen = [];
    for (let i = 0; i < 4; i++) seen.push((await call(url + '/items')).status);
    assert.deepEqual(seen, [500, 200, 200, 200]);
    mock.rearm();
    assert.equal((await call(url + '/items')).status, 500);
  });
});

test('a fault can be limited to some paths', async () => {
  await withMock({ fault: { type: 'always', status: 500, path: '/items' } }, async (mock, url) => {
    assert.equal((await call(url + '/items/1')).status, 500);
    assert.equal((await call(url + '/headers')).status, 200);
  });
});

test('dropped connections, lost responses and cut-off bodies happen on the wire', async () => {
  await withMock({ fault: { type: 'drop-first-n', n: 1 } }, async (mock, url) => {
    const r = await call(url + '/items');
    assert.equal(r.error, 'ECONNRESET');
    assert.equal((await call(url + '/items')).status, 200);
    assert.equal(mock.requests()[0].kind, 'network');
  });
  await withMock({ fault: { type: 'drop-after-process', n: 1 } }, async (mock, url) => {
    const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Twice"}' };
    assert.equal((await call(url + '/items', post)).error, 'ECONNRESET');
    assert.equal((await call(url + '/items', post)).status, 201);
    mock.setFault(null);
    const items = json(await call(url + '/items')).items;
    assert.equal(items.filter((x) => x.name === 'Twice').length, 2, 'the lost request was still processed');
  });
  await withMock({ fault: { type: 'truncated-first-n', n: 1 } }, async (mock, url) => {
    const r = await call(url + '/items');
    assert.ok(r.cut || r.error, 'the body should end early');
    assert.throws(() => JSON.parse(r.body || ''));
    assert.doesNotThrow(() => json({ body: '{}' }));
    assert.equal((await call(url + '/items')).status, 200);
  });
  await withMock({ fault: { type: 'malformed' } }, async (mock, url) => {
    const r = await call(url + '/items');
    assert.equal(r.status, 200);
    assert.throws(() => JSON.parse(r.body));
  });
});

test('slow answers, latency and a client that gives up', async () => {
  await withMock({ fault: { type: 'slow-first-n', n: 1, slowMs: 300 } }, async (mock, url) => {
    const slow = await call(url + '/items');
    assert.equal(slow.status, 200); assert.ok(slow.ms >= 280, 'took ' + slow.ms);
    assert.ok((await call(url + '/items')).ms < 200);
    mock.rearm();
    const gaveUp = await call(url + '/items', { timeout: 80 });
    assert.equal(gaveUp.error, 'CLIENT_TIMEOUT');
    await new Promise((r) => setTimeout(r, 60));
    const last = mock.requests().pop();
    assert.equal(last.clientClosed, true);
  });
  await withMock({ latency: { baseMs: 150 }, routes: [{ path: '/wait', delayMs: 250, body: 'ok' }] }, async (mock, url) => {
    assert.ok((await call(url + '/items')).ms >= 140);
    assert.ok((await call(url + '/wait')).ms >= 240);
  });
});

test('429 until the window has passed', async () => {
  await withMock({ fault: { type: 'rate-limit-until', sec: 1 } }, async (mock, url) => {
    const r = await call(url + '/items');
    assert.equal(r.status, 429); assert.equal(r.headers['retry-after'], '1');
    await new Promise((res) => setTimeout(res, 1050));
    assert.equal((await call(url + '/items')).status, 200);
  });
});

test('a route can carry its own fault', async () => {
  await withMock({ routes: [{ path: '/pay', body: { ok: true }, fault: { type: 'fail-first-n', n: 1, status: 502 } }] }, async (mock, url) => {
    assert.equal((await call(url + '/pay')).status, 502);
    assert.equal((await call(url + '/pay')).status, 200);
    assert.equal((await call(url + '/items')).status, 200);
  });
});

test('CORS: preflight is answered, and can be switched off', async () => {
  await withMock({}, async (mock, url) => {
    const pre = await call(url + '/items', { method: 'OPTIONS', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-app' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'http://localhost:3000');
    assert.equal(pre.headers['access-control-allow-headers'], 'content-type, x-app');
    const r = await call(url + '/items', { headers: { origin: 'http://localhost:3000' } });
    assert.equal(r.headers['access-control-allow-credentials'], 'true');
    assert.match(r.headers['access-control-expose-headers'], /etag/);
    mock.setConfig({ cors: false });
    assert.equal((await call(url + '/items', { headers: { origin: 'http://localhost:3000' } })).headers['access-control-allow-origin'], undefined);
  });
});

test('control API needs the token, a local host name and an allowed origin', async () => {
  await withMock({ allowOrigins: ['http://localhost:5173'] }, async (mock) => {
    assert.equal((await call(mock.url + '/__mock/api/state')).status, 401);
    assert.equal((await ctl(mock, 'GET', '/state', undefined, { 'x-mock-token': 'nope' })).status, 401);
    const ok = await ctl(mock, 'GET', '/state');
    assert.equal(ok.status, 200); assert.equal(json(ok).name, 'tinypdf-mock');
    assert.equal((await ctl(mock, 'GET', '/state', undefined, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await ctl(mock, 'GET', '/state', undefined, { host: 'evil.example' })).status, 403, 'DNS rebinding');
    const site = await ctl(mock, 'GET', '/state', undefined, { origin: 'https://tinypdf.in' });
    assert.equal(site.status, 200); assert.equal(site.headers['access-control-allow-origin'], 'https://tinypdf.in');
    assert.equal((await ctl(mock, 'GET', '/state', undefined, { origin: 'http://localhost:5173' })).status, 200);
    const pre = await call(mock.url + '/__mock/api/state', { method: 'OPTIONS', headers: { origin: 'https://tinypdf.in', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type,x-mock-token', 'access-control-request-private-network': 'true' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'https://tinypdf.in');
    assert.equal(pre.headers['access-control-allow-private-network'], 'true');
    const allowed = pre.headers['access-control-allow-headers'].split(',').map((h) => h.trim());
    /* every header ui/rest-ui.js sends to the control API must be named here, or browsers on tinypdf.in refuse the call */
    const sent = new Set();
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'ui', 'rest-ui.js'), 'utf8');
    for (const m of src.matchAll(/'(X-Mock-[A-Za-z-]+|Content-Type)'\s*:/g)) sent.add(m[1].toLowerCase());
    assert.ok(sent.has('x-mock-token'));
    for (const h of sent) assert.ok(allowed.includes(h), 'the page sends ' + h + ' but the preflight does not allow it');
    assert.match(pre.headers['access-control-allow-methods'], /PUT/); assert.match(pre.headers['access-control-allow-methods'], /DELETE/);
    assert.equal((await call(mock.url + '/__mock/api/state', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } })).status, 403);
    const page = await call(mock.url + '/__mock/');
    assert.equal(page.status, 200); assert.match(page.body, /window\.TINY_MOCK=/); assert.match(page.body, /"token":"t0k"/);
    assert.equal(page.headers['access-control-allow-origin'], undefined, 'other sites cannot read the page that holds the token');
    assert.equal((await call(mock.url + '/__mock/ui/rest-ui.js')).status, 200);
    assert.equal((await call(mock.url + '/__mock/ui/..%2Fpackage.json')).status, 404);
    assert.equal(mock.requests().length, 0, 'control calls are not logged as mock requests');
  });
});

test('control API changes routes and faults while running', async () => {
  await withMock({}, async (mock, url) => {
    const bad = await ctl(mock, 'PUT', '/routes', { routes: [{ path: 'no-slash' }] });
    assert.equal(bad.status, 400); assert.match(json(bad).message, /must start with/);
    assert.equal((await ctl(mock, 'PUT', '/routes', { routes: [{ path: '/hello', body: { hi: 1 } }] })).status, 200);
    assert.deepEqual(json(await call(url + '/hello')), { hi: 1 });
    assert.equal((await ctl(mock, 'PUT', '/config', { fault: { type: 'always', status: 502 } })).status, 200);
    assert.equal((await call(url + '/hello')).status, 502);
    assert.equal((await ctl(mock, 'PUT', '/config', { fault: { type: 'bogus' } })).status, 400);
    await ctl(mock, 'PUT', '/config', { fault: { type: 'none' } });
    await call(url + '/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' });
    assert.equal(json(await ctl(mock, 'GET', '/state')).created, 1);
    const reset = json(await ctl(mock, 'POST', '/reset'));
    assert.equal(reset.created, 0); assert.equal(reset.routes.length, 1, 'routes survive a reset');
    assert.equal((await ctl(mock, 'DELETE', '/requests')).status, 200);
    assert.equal(mock.requests().length, 0);
  });
});

test('the sender reaches other servers and reports real failures', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/slow') return void setTimeout(() => res.end('late'), 400);
    if (req.url === '/cut') { res.writeHead(200, { 'content-length': '100' }); res.write('half'); return void setTimeout(() => req.socket.destroy(), 20); }
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => { res.writeHead(207, { 'content-type': 'application/json', 'x-seen-cookie': req.headers.cookie || '' }); res.end(JSON.stringify({ method: req.method, body })); });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const up = 'http://127.0.0.1:' + upstream.address().port;
  try {
    await withMock({}, async (mock) => {
      const ok = json(await ctl(mock, 'POST', '/send', { method: 'POST', url: up + '/x', headers: [{ name: 'Cookie', value: 'a=1' }, { name: 'Content-Type', value: 'text/plain' }], body: 'hello' }));
      assert.equal(ok.kind, 'response'); assert.equal(ok.status, 207);
      assert.equal(ok.headers['x-seen-cookie'], 'a=1', 'headers a browser blocks are sent');
      assert.deepEqual(JSON.parse(ok.body), { method: 'POST', body: 'hello' });
      const slow = json(await ctl(mock, 'POST', '/send', { url: up + '/slow', timeoutMs: 100 }));
      assert.equal(slow.kind, 'timeout');
      const cut = json(await ctl(mock, 'POST', '/send', { url: up + '/cut' }));
      assert.equal(cut.kind, 'bodyError'); assert.equal(cut.body, 'half');
      const dead = json(await ctl(mock, 'POST', '/send', { url: 'http://127.0.0.1:9/' }));
      assert.equal(dead.kind, 'network'); assert.equal(dead.code, 'ECONNREFUSED');
      assert.equal(json(await ctl(mock, 'POST', '/send', { url: 'ftp://x/' })).kind, 'network');
      assert.equal((await call(mock.url + '/__mock/api/send', { method: 'POST', body: '{}' })).status, 401);
    });
    await withMock({ send: false }, async (mock) => {
      assert.equal((await ctl(mock, 'POST', '/send', { url: up + '/x' })).status, 403);
    });
  } finally { upstream.close(); }
});

test('--send-local-only keeps the sender on this machine and private networks', async () => {
  const { isLocalAddress } = require('../lib/server.js');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5', '169.254.1.1', '::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isLocalAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8', 'example.com', '']) assert.equal(isLocalAddress(ip), false, ip);
  const upstream = http.createServer((req, res) => res.end('hi'));
  /* no host: listens on IPv4 and IPv6, since "localhost" means ::1 first on Node 18 and 127.0.0.1 on others */
  await new Promise((r) => upstream.listen(0, r));
  const port = upstream.address().port;
  try {
    await withMock({ sendLocalOnly: true }, async (mock) => {
      assert.equal(json(await ctl(mock, 'POST', '/send', { url: 'http://127.0.0.1:' + port + '/' })).status, 200);
      assert.equal(json(await ctl(mock, 'POST', '/send', { url: 'http://localhost:' + port + '/' })).status, 200, 'a name that resolves to loopback');
      const out = json(await ctl(mock, 'POST', '/send', { url: 'http://93.184.216.34/' }));
      assert.equal(out.kind, 'network'); assert.equal(out.code, 'NOT_LOCAL');
      assert.equal(json(await ctl(mock, 'POST', '/send', { url: 'http://[2606:4700::1111]/' })).code, 'NOT_LOCAL');
      assert.equal(json(await ctl(mock, 'GET', '/state')).sendLocalOnly, true);
    });
  } finally { upstream.close(); }
});

test('events stream delivers each request to the page', async () => {
  await withMock({}, async (mock, url) => {
    const got = await new Promise((resolve, reject) => {
      const req = http.get(mock.url + '/__mock/api/events?k=t0k', (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; const m = /event: request\ndata: (.*)\n/.exec(buf); if (m) { req.destroy(); resolve(JSON.parse(m[1])); } });
        call(url + '/items/2');
      });
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    });
    assert.equal(got.path, '/items/2'); assert.equal(got.status, 200);
  });
});

test('bad options are refused up front', () => {
  assert.throws(() => createMockServer({ routes: [{ path: 'x' }] }), /must start with/);
  assert.throws(() => createMockServer({ fault: { type: 'nope' } }), /Unknown fault/);
});

test('an explicit port that is taken is an error', async () => {
  const a = await startMockServer({ port: 0 });
  const b = createMockServer({ port: a.port });
  await assert.rejects(() => b.start(), /EADDRINUSE/);
  await a.stop();
});
