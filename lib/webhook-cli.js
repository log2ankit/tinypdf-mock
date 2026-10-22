'use strict';
// "tinypdf-mock webhook send" and "tinypdf-mock webhook receive". See the README section "Webhooks".
const fs = require('fs');
const { sign, send, startReceiver, DEFAULT_TOLERANCE } = require('./webhook.js');

const HELP = `tinypdf-mock webhook: send and receive signed webhook deliveries

  tinypdf-mock webhook send <url> [options]
      --secret <text>      shared secret (or set TINYPDF_WEBHOOK_SECRET; prefer that, it stays out of shell history)
      --body <json>        the body to send (default: a small test event)
      --body-file <path>   read the body from a file
      --retries <n>        retries after a failed try (default 3)
      --age <seconds>      sign as if the event was sent this long ago, to test the tolerance
      --timeout <ms>       give up on one try after this long (default 10000)
      --base-ms <ms>       first retry wait (default 500), doubling up to --cap-ms (default 30000)
  Exit code 0 when delivered, 1 when not.

  tinypdf-mock webhook receive [options]
      -p, --port <n>       port to listen on (default 4848)
      --path <p>           path to accept deliveries on (default /hooks)
      --secret <text>      shared secret to check (or TINYPDF_WEBHOOK_SECRET)
      --tolerance <s>      how far the timestamp may differ from now (default ${DEFAULT_TOLERANCE})
      --fail-first <n>     answer 503 to the first n deliveries, to test retries
  Answers 200 when the signature is valid, 400 when the header is malformed, 401 otherwise.`;

function fail(msg) { process.stderr.write('tinypdf-mock webhook: ' + msg + '\n'); process.exit(1); }
const clock = () => new Date().toTimeString().slice(0, 8);

function parse(argv) {
  const o = { pos: [] };
  const names = { '--secret': 'secret', '--body': 'body', '--body-file': 'bodyFile', '--retries': 'retries', '--age': 'age', '--timeout': 'timeout',
    '--base-ms': 'baseMs', '--cap-ms': 'capMs', '--port': 'port', '-p': 'port', '--path': 'path', '--tolerance': 'tolerance', '--fail-first': 'failFirst', '--host': 'host' };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (names[a]) {
      if (v == null) v = argv[++i];
      if (v == null) fail('"' + a + '" needs a value.');
      o[names[a]] = v;
    } else if (a.startsWith('-')) fail('unknown option "' + a + '". Try: tinypdf-mock webhook --help');
    else o.pos.push(a);
  }
  return o;
}
function num(v, name, d) {
  if (v === undefined) return d;
  const n = Number(v);
  if (!isFinite(n) || n < 0) fail('"' + name + '" must be a number, got "' + v + '".');
  return n;
}
function secretOf(o) {
  const s = o.secret ?? process.env.TINYPDF_WEBHOOK_SECRET;
  if (!s) fail('give a secret with --secret or set TINYPDF_WEBHOOK_SECRET.');
  return s;
}

async function sendCmd(o) {
  const url = o.pos[0];
  if (!url) fail('give the address to send to, for example http://localhost:4848/hooks');
  if (!/^https?:\/\//.test(url)) fail('the address must start with http:// or https://.');
  try { new URL(url); } catch (e) { fail('"' + url + '" is not a valid address.'); }
  const secret = secretOf(o);
  let body = o.body;
  if (o.bodyFile) { try { body = fs.readFileSync(o.bodyFile, 'utf8'); } catch (e) { fail('cannot read ' + o.bodyFile + ' (' + e.code + ').'); } }
  if (body === undefined) body = JSON.stringify({ type: 'test.ping', sent: new Date().toISOString() });
  try { JSON.parse(body); } catch (e) { fail('the body is not valid JSON: ' + e.message); }
  const retries = num(o.retries, '--retries', 3);
  console.log(`${clock()}  sending to ${url}`);
  const res = await send({
    url, secret, body, retries, ageSeconds: num(o.age, '--age', 0), timeoutMs: num(o.timeout, '--timeout', 10000),
    baseMs: num(o.baseMs, '--base-ms', 500), capMs: num(o.capMs, '--cap-ms', 30000),
    onAttempt: (r) => {
      const what = r.error ? 'no answer (' + r.error + ')' : 'answered ' + r.status;
      const tail = r.ok ? '  delivered' : r.waitMs ? '  will retry in ' + r.waitMs + ' ms' : '  not retried';
      console.log(`${clock()}  try ${r.n}: ${what}  ${r.ms} ms${tail}`);
      if (!r.ok && r.body) console.log('           ' + r.body.replace(/\s+/g, ' ').slice(0, 200));
    },
  });
  console.log(`${clock()}  event ${res.eventId}: ${res.delivered ? 'delivered' : 'NOT delivered'} after ${res.attempts.length} ${res.attempts.length === 1 ? 'try' : 'tries'}`);
  process.exit(res.delivered ? 0 : 1);
}

async function receiveCmd(o) {
  const secret = secretOf(o);
  const port = num(o.port, '--port', 4848);
  const tolerance = num(o.tolerance, '--tolerance', DEFAULT_TOLERANCE);
  const failFirst = num(o.failFirst, '--fail-first', 0);
  let rx;
  try {
    rx = await startReceiver({ port, host: o.host || 'localhost', path: o.path || '/hooks', secret, tolerance, failFirst,
      onRequest: (e) => console.log(`${clock()}  ${e.method} ${e.path}  event ${e.eventId || '-'}  ${e.bytes} bytes  -> ${e.status} ${e.result}${e.reason && e.status !== 200 ? ': ' + e.reason : ''}`) });
  } catch (e) {
    if (e.code === 'EADDRINUSE') fail('port ' + port + ' is already in use. Pick another with --port.');
    fail(e.message);
  }
  console.log(`Receiving on http://localhost:${rx.port}${o.path || '/hooks'}  (tolerance ${tolerance} s${failFirst ? ', failing the first ' + failFirst : ''})`);
  console.log('Ctrl+C to stop.');
  const bye = () => rx.close().then(() => process.exit(0));
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

async function run(argv) {
  const sub = argv[0];
  const o = parse(argv.slice(1));
  if (!sub || sub === '--help' || sub === '-h' || o.help) {
    console.log(HELP);
    return;
  }
  if (sub === 'send') return sendCmd(o);
  if (sub === 'receive') return receiveCmd(o);
  fail('unknown command "' + sub + '". Use send or receive. Try --help.');
}

module.exports = { run };
