'use strict';
// Webhook support for tinypdf-mock: sign and check webhook deliveries, send one with retries, and
// receive them. Signature format matches the webhook playground on tinypdf.in: the header is
// "t=<unix seconds>,v1=<hex HMAC-SHA256>" and the HMAC is over "<t>.<body>" with the shared secret.
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const HEADER = 'X-Webhook-Signature';
const ID_HEADER = 'X-Webhook-Id';
const DEFAULT_TOLERANCE = 300; // seconds

function hmacHex(secret, text) {
  return crypto.createHmac('sha256', secret).update(text, 'utf8').digest('hex');
}

// Header value for a body signed at Unix time ts (seconds).
function sign(secret, body, ts = Math.floor(Date.now() / 1000)) {
  return `t=${ts},v1=${hmacHex(secret, ts + '.' + body)}`;
}

// Checks a header against the body. Returns { code, reason } where code is one of:
// 'ok', 'malformed', 'mismatch' (wrong secret or changed body), 'expired' (too old or too far ahead).
function verify(header, secret, body, now = Math.floor(Date.now() / 1000), tolerance = DEFAULT_TOLERANCE) {
  const m = /^t=(\d{1,15}),v1=([0-9a-f]{64})$/i.exec(String(header || '').trim());
  if (!m) return { code: 'malformed', reason: 'The signature header is missing or not in the form t=<seconds>,v1=<64 hex characters>.' };
  const ts = Number(m[1]);
  const expected = Buffer.from(hmacHex(secret, ts + '.' + body), 'hex');
  const given = Buffer.from(m[2].toLowerCase(), 'hex');
  if (!crypto.timingSafeEqual(expected, given)) {
    return { code: 'mismatch', reason: 'The signature does not match. Check the secret, and that the body was not changed after signing.' };
  }
  if (Math.abs(now - ts) > tolerance) {
    return { code: 'expired', reason: `The timestamp is ${Math.round(Math.abs(now - ts))} s from now, outside the ${tolerance} s tolerance.` };
  }
  return { code: 'ok', reason: 'The signature is valid and the timestamp is within tolerance.' };
}

// Wait before retry number `attempt` (1 for the first retry), in ms: doubles from baseMs up to capMs.
function backoff(attempt, baseMs = 500, capMs = 30000) {
  let v = baseMs;
  for (let i = 1; i < attempt && v < capMs; i++) v *= 2;
  return Math.min(v, capMs);
}

// One HTTP POST. Resolves { status, ms, body } or { error } when the connection fails.
function post(url, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = lib.request(u, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < 4096) text += c; });
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - started, body: text }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out after ' + timeoutMs + ' ms')));
    req.on('error', (e) => resolve({ error: e.message, ms: Date.now() - started }));
    req.end(body);
  });
}

// Sends one signed delivery, retrying on connection errors, 408, 429 and 5xx. Other 4xx answers are final.
// onAttempt(record) is called after each try. Returns { delivered, attempts: [...] }.
async function send({ url, secret, body, retries = 3, baseMs = 500, capMs = 30000, timeoutMs = 10000, ageSeconds = 0, eventId, onAttempt = () => {} }) {
  const id = eventId || crypto.randomUUID();
  const ts = Math.floor(Date.now() / 1000) - ageSeconds;
  const headers = { 'Content-Type': 'application/json', [ID_HEADER]: id, [HEADER]: sign(secret, body, ts) };
  const attempts = [];
  for (let n = 1; n <= retries + 1; n++) {
    const r = await post(url, headers, body, timeoutMs);
    const retryable = r.error !== undefined || r.status === 408 || r.status === 429 || r.status >= 500;
    const ok = r.status >= 200 && r.status < 300;
    const wait = !ok && retryable && n <= retries ? backoff(n, baseMs, capMs) : 0;
    const rec = { n, status: r.status, ms: r.ms, error: r.error, body: r.body, ok, waitMs: wait };
    attempts.push(rec);
    onAttempt(rec);
    if (ok || !retryable) return { delivered: ok, eventId: id, attempts };
    if (wait) await new Promise((res) => setTimeout(res, wait));
  }
  return { delivered: false, eventId: id, attempts };
}

// A receiver that checks each signed delivery. Answers 200 when valid, 400 when malformed,
// 401 when the signature does not match or the timestamp is outside tolerance. failFirst makes it
// answer 503 for the first N deliveries, to test retries. onRequest(entry) is called for each one.
function startReceiver({ port = 4848, host = '127.0.0.1', path = '/hooks', secret, tolerance = DEFAULT_TOLERANCE, failFirst = 0, onRequest = () => {} }) {
  let seen = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const entry = { at: new Date().toISOString(), method: req.method, path: req.url, eventId: req.headers[ID_HEADER.toLowerCase()] || '', bytes: Buffer.byteLength(body) };
      const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.method !== 'POST' || req.url.split('?')[0] !== path) {
        entry.status = 404; entry.result = 'not found'; onRequest(entry);
        return reply(404, { error: 'Send POST to ' + path });
      }
      seen++;
      if (seen <= failFirst) {
        entry.status = 503; entry.result = 'failed on purpose (--fail-first)'; onRequest(entry);
        return reply(503, { error: 'Failed on purpose for testing. Retry.' });
      }
      const v = verify(req.headers[HEADER.toLowerCase()], secret, body, Math.floor(Date.now() / 1000), tolerance);
      const status = v.code === 'ok' ? 200 : v.code === 'malformed' ? 400 : 401;
      entry.status = status; entry.result = v.code; entry.reason = v.reason; onRequest(entry);
      reply(status, { verified: v.code === 'ok', result: v.code, reason: v.reason });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

module.exports = { sign, verify, backoff, send, startReceiver, HEADER, ID_HEADER, DEFAULT_TOLERANCE };
