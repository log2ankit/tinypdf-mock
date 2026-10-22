'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { sign, verify, backoff, send, startReceiver } = require('../lib/webhook.js');

const SECRET = 'whsec_test';
const BODY = '{"type":"invoice.paid","id":"evt_1"}';
const NOW = 1791400623;

test('header has the t=,v1= form and the HMAC is over "<t>.<body>"', () => {
  const h = sign(SECRET, BODY, NOW);
  const want = crypto.createHmac('sha256', SECRET).update(NOW + '.' + BODY).digest('hex');
  assert.equal(h, `t=${NOW},v1=${want}`);
});

test('a fresh signature verifies', () => {
  assert.equal(verify(sign(SECRET, BODY, NOW), SECRET, BODY, NOW).code, 'ok');
});

test('wrong secret, changed body and tampered signature are refused as mismatch', () => {
  const h = sign(SECRET, BODY, NOW);
  assert.equal(verify(h, 'other', BODY, NOW).code, 'mismatch');
  assert.equal(verify(h, SECRET, BODY + ' ', NOW).code, 'mismatch');
  assert.equal(verify(h.replace(/.$/, h.endsWith('0') ? '1' : '0'), SECRET, BODY, NOW).code, 'mismatch');
});

test('timestamps outside the tolerance are expired, on either side', () => {
  const h = sign(SECRET, BODY, NOW);
  assert.equal(verify(h, SECRET, BODY, NOW + 300).code, 'ok');
  assert.equal(verify(h, SECRET, BODY, NOW + 301).code, 'expired');
  assert.equal(verify(h, SECRET, BODY, NOW - 301).code, 'expired');
  assert.equal(verify(h, SECRET, BODY, NOW + 1000, 2000).code, 'ok');
});

test('a malformed header is refused as malformed', () => {
  for (const bad of ['', 'abc', 't=1,v1=xyz', 't=,v1=' + 'a'.repeat(64), undefined]) {
    assert.equal(verify(bad, SECRET, BODY, NOW).code, 'malformed', String(bad));
  }
});

test('back-off doubles from the base and stops at the cap', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((a) => backoff(a, 500, 4000)), [500, 1000, 2000, 4000, 4000, 4000]);
});

test('sends and the receiver accepts a valid delivery', async () => {
  const rx = await startReceiver({ port: 0, secret: SECRET, path: '/hooks' });
  try {
    const url = `http://localhost:${rx.port}/hooks`;
    const res = await send({ url, secret: SECRET, body: BODY, retries: 0 });
    assert.equal(res.delivered, true);
    assert.equal(res.attempts[0].status, 200);
  } finally { await rx.close(); }
});

test('a wrong secret is answered 401 and not retried', async () => {
  const rx = await startReceiver({ port: 0, secret: SECRET });
  try {
    const res = await send({ url: `http://localhost:${rx.port}/hooks`, secret: 'nope', body: BODY, retries: 3, baseMs: 1 });
    assert.equal(res.delivered, false);
    assert.equal(res.attempts.length, 1);
    assert.equal(res.attempts[0].status, 401);
  } finally { await rx.close(); }
});

test('an old event is answered 401 expired', async () => {
  const rx = await startReceiver({ port: 0, secret: SECRET });
  try {
    const res = await send({ url: `http://localhost:${rx.port}/hooks`, secret: SECRET, body: BODY, ageSeconds: 900, retries: 0 });
    assert.equal(res.delivered, false);
    assert.equal(res.attempts[0].status, 401);
  } finally { await rx.close(); }
});

test('retries after 503s and delivers on a later try', async () => {
  const seen = [];
  const rx = await startReceiver({ port: 0, secret: SECRET, failFirst: 2, onRequest: (e) => seen.push(e.status) });
  try {
    const res = await send({ url: `http://localhost:${rx.port}/hooks`, secret: SECRET, body: BODY, retries: 3, baseMs: 1, capMs: 2 });
    assert.equal(res.delivered, true);
    assert.deepEqual(res.attempts.map((a) => a.status), [503, 503, 200]);
    assert.deepEqual(seen, [503, 503, 200]);
  } finally { await rx.close(); }
});

test('gives up after the retries when nothing answers', async () => {
  const rx = await startReceiver({ port: 0, secret: SECRET });
  const port = rx.port;
  await rx.close();
  const res = await send({ url: `http://localhost:${port}/hooks`, secret: SECRET, body: BODY, retries: 2, baseMs: 1, capMs: 2 });
  assert.equal(res.delivered, false);
  assert.equal(res.attempts.length, 3);
  assert.ok(res.attempts.every((a) => a.error));
});

test('a request to the wrong path is answered 404', async () => {
  const rx = await startReceiver({ port: 0, secret: SECRET, path: '/hooks' });
  try {
    const res = await send({ url: `http://localhost:${rx.port}/other`, secret: SECRET, body: BODY, retries: 0 });
    assert.equal(res.attempts[0].status, 404);
  } finally { await rx.close(); }
});
