'use strict';
/* The shared core: mock routes, faults and the retry runner. No server involved. */
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/sim-core.js');

test('every example runs to its expected end', async () => {
  const want = { flaky: ['success', 3], 'rate-limit': ['success', 2], timeouts: ['success', 3], 'duplicate-post': ['success', 2], 'safe-retry': ['not-retried', 1],
    auth: ['failed', 1], 'content-type': ['failed', 1], etag: ['success', 1], echo: ['success', 1], truncated: ['success', 2], malformed: ['success', 1] };
  for (const e of S.EXAMPLES) {
    const r = await S.run(S.exampleConfig(e.id));
    assert.deepEqual([r.outcome, r.attempts.length], want[e.id], e.id);
  }
});

test('a run never makes more than 10 attempts', async () => {
  const c = S.exampleConfig('flaky'); c.fault = { type: 'always', status: 503 }; c.policy.maxAttempts = 5000; c.policy.baseMs = 1;
  const r = await S.run(c);
  assert.equal(r.attempts.length, 10); assert.equal(r.outcome, 'failed');
  assert.match(S.snippets(c).fetch, /MAX_ATTEMPTS = 10;/);
});

test('the same seed gives the same run', async () => {
  const mk = () => { const c = S.exampleConfig('flaky'); c.fault = { type: 'random', pct: 60 }; c.policy.strategy = 'full-jitter'; c.seed = 7; return c; };
  const a = await S.run(mk()), b = await S.run(mk());
  assert.deepEqual(a.attempts.map((x) => [x.status, x.waitMs]), b.attempts.map((x) => [x.status, x.waitMs]));
});

test('own routes are matched before the demo routes', () => {
  const st = S.newServerState({ routes: [
    { path: '/items', body: { mine: true } },
    { method: 'POST', path: '/orders/:id/pay', status: 202, headers: { 'X-Order': '{{params.id}}' }, body: { order: '{{params.id | number}}', amount: '{{body.amount}}', note: 'paid by {{headers.x-user}}' } },
    { method: 'GET', path: '/off', enabled: false, body: 'x' },
  ] });
  const q = (method, path, body, headers) => S.handle(st, { method, url: 'https://api.sim.local' + path, headers: headers || {}, body: body || '' });
  assert.deepEqual(JSON.parse(q('GET', '/items').body), { mine: true });
  const p = q('POST', '/orders/12/pay', '{"amount": 9.5}', { 'x-user': 'ada' });
  assert.equal(p.status, 202); assert.equal(p.headers['x-order'], '12');
  assert.deepEqual(JSON.parse(p.body), { order: 12, amount: 9.5, note: 'paid by ada' });
  assert.equal(q('GET', '/orders/12/pay').status, 405);
  assert.equal(q('GET', '/off').status, 404);
  assert.equal(q('GET', '/items/1').status, 200, 'demo route still answers');
  st.builtins = false;
  assert.equal(q('GET', '/items/1').status, 404);
});

test('routes are checked before use', () => {
  const r = S.normalizeRoutes([{ path: '/ok' }, { path: 'bad' }, { path: '/a b' }, { path: '/s', status: 99 }, { path: '/h', headers: { 'bad name': 'x' } }, { method: 'any', path: '/any' }]);
  assert.equal(r.routes.length, 2); assert.equal(r.errors.length, 4);
  assert.equal(r.routes[1].method, '*');
  assert.match(S.normalizeRoutes('nope').errors[0], /must be a list/);
});

test('the fault planner reports whether it stepped in', () => {
  const rng = S.mulberry32(1), exec = () => ({ status: 200, headers: {}, body: '{"a":1}' });
  const plan = (fault, attempt, t) => S.planAttempt({ fault, attempt, t: t || 0, rng, latency: { baseMs: 0, jitterMs: 0 }, exec });
  assert.equal(plan({ type: 'fail-first-n', n: 1, status: 503 }, 1).fault, 'fail-first-n');
  assert.equal(plan({ type: 'fail-first-n', n: 1, status: 503 }, 2).fault, null);
  assert.equal(plan({ type: 'drop-first-n', n: 1 }, 1).kind, 'network');
  assert.equal(plan({ type: 'truncated-first-n', n: 1 }, 1).kind, 'bodyError');
  assert.equal(plan({ type: 'rate-limit-until', sec: 2 }, 5, 1000).status, 429);
  assert.equal(plan({ type: 'rate-limit-until', sec: 2 }, 6, 2500).status, 200);
  assert.equal(plan({ type: 'none' }, 1).fault, null);
  assert.equal(S.faultApplies({ type: 'always', path: '/pay' }, '/pay/1'), true);
  assert.equal(S.faultApplies({ type: 'always', path: '/pay' }, '/users'), false);
  assert.equal(S.faultApplies({ type: 'none' }, '/pay'), false);
});

test('local server mode uses the given sender and keeps blocked headers', async () => {
  const cfg = S.exampleConfig('echo'); cfg.target = 'local'; cfg.localBase = 'http://localhost:4747'; cfg.request.url = '/headers';
  cfg.policy.baseMs = 1;
  const seen = [];
  cfg.attempt = async (ctx) => { seen.push(ctx); return seen.length < 2 ? { kind: 'network', durationMs: 1, message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' } : { kind: 'response', status: 200, headers: {}, body: '{}', durationMs: 1 }; };
  const r = await S.run(cfg);
  assert.equal(r.outcome, 'success'); assert.equal(seen.length, 2);
  assert.equal(seen[0].url, 'http://localhost:4747/headers');
  assert.ok(seen[0].prep.sent.some((h) => h.name === 'Cookie'), 'Cookie is sent from the local server');
  assert.equal(S.validate(cfg), null);
  assert.match(S.snippets(cfg).curl, /localhost:4747\/headers/);
  assert.match(S.snippets(cfg).curl, /Cookie: session=abc123/);
});
