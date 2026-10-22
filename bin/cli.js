#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { createMockServer, core, DEFAULT_PORT } = require('../lib/server.js');
const pkg = require('../package.json');

const HELP = `${pkg.name} ${pkg.version}
A local mock API with fault injection, a live request log and a browser control page.

Usage
  npx ${pkg.name} [file] [options]
  npx ${pkg.name} init [file]        write a starter mock.json
  npx ${pkg.name} webhook send|receive   send signed webhooks, or check them (see the README)

  file                 routes file to load (default: ./mock.json when it exists)

Options
  -p, --port <n>       port to listen on (default ${DEFAULT_PORT}; the next free port is used if it is taken)
      --host <name>    address to listen on (default localhost; 0.0.0.0 lets other devices connect)
  -f, --fault <spec>   start with a fault, for example  fail-first-n:n=2,status=503,retryAfter=1
      --latency <ms>   delay added to every answer
      --jitter <ms>    random extra delay, 0 to this many ms
      --seed <n>       seed for random failures and jitter (default 42)
      --no-repeat      a "first N" fault fires once, instead of starting over after each success
      --no-builtins    serve only your routes, not the demo routes (/items, /status/503, ...)
      --no-cors        do not add CORS headers (to see how a browser app fails without them)
      --no-watch       do not reload the routes file when it changes
      --save           write routes edited in the control page back to the routes file
      --no-send        do not let the control page send requests through this server
      --send-local-only  only send to this machine and private network addresses
      --insecure       accept self-signed certificates when sending requests
      --no-ui          do not serve the control page
      --allow-origin <url>   let a page on this origin control the server (repeatable)
      --token <text>   fixed control token (default: a new random one each start)
  -o, --open           open the control page in your browser
  -q, --quiet          do not print a line per request
  -v, --version
  -h, --help

Faults
${core.FAULTS.map((f) => '  ' + (f.type + (f.fields.length ? ':' + f.fields.map((x) => x.key + '=' + (x.def === '' ? '..' : x.def)).join(',') : '')).padEnd(44) + f.label).join('\n')}

Routes file (mock.json)
  { "routes": [ { "method": "GET", "path": "/users/:id", "status": 200,
                  "body": { "id": "{{params.id | number}}", "name": "Ada" } } ] }
  Bodies may use {{params.x}} {{query.x}} {{body.x}} {{headers.x}} {{now}} {{uuid}}.
  Optional settings beside "routes": port, fault, latency, seed, cors, repeat, builtins.

Docs: ${pkg.homepage}`;

function fail(msg) { process.stderr.write(pkg.name + ': ' + msg + '\n'); process.exit(1); }

/* The "graphql" key of a routes file: { path, schema | schemaFile, data | dataFile }.
 * Relative file names are read from the folder that holds the routes file. */
function resolveGraphQL(g, file) {
  if (!g || typeof g !== 'object') return undefined;
  const base = file ? path.dirname(file) : process.cwd();
  const read = (name) => fs.readFileSync(path.resolve(base, String(name)), 'utf8');
  let schema = g.schema;
  if (schema == null && g.schemaFile) schema = read(g.schemaFile);
  let data = g.data;
  if (data === undefined && g.dataFile) data = JSON.parse(read(g.dataFile));
  return { path: g.path || '/graphql', schema: schema, data: data };
}

function parseArgs(argv) {
  const o = { allowOrigins: [], files: [] };
  const flags = { '--no-repeat': ['repeat', false], '--no-builtins': ['builtins', false], '--no-cors': ['cors', false], '--no-watch': ['watch', false],
    '--save': ['save', true], '--no-send': ['send', false], '--send-local-only': ['sendLocalOnly', true], '--insecure': ['insecure', true], '--no-ui': ['ui', false], '--open': ['open', true], '-o': ['open', true],
    '--quiet': ['quiet', true], '-q': ['quiet', true], '--help': ['help', true], '-h': ['help', true], '--version': ['version', true], '-v': ['version', true] };
  const values = { '--port': 'port', '-p': 'port', '--host': 'host', '--fault': 'fault', '-f': 'fault', '--latency': 'latency', '--jitter': 'jitter', '--seed': 'seed',
    '--token': 'token', '--allow-origin': 'allowOrigin', '--routes': 'file', '-r': 'file' };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v = null;
    const eq = a.indexOf('=');
    if (a.indexOf('--') === 0 && eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    if (flags[a]) { o[flags[a][0]] = flags[a][1]; continue; }
    if (values[a]) {
      if (v == null) v = argv[++i];
      if (v == null) fail('"' + a + '" needs a value. Try --help.');
      if (values[a] === 'allowOrigin') o.allowOrigins.push(v);
      else if (values[a] === 'file') o.files.push(v);
      else o[values[a]] = v;
      continue;
    }
    if (a.charAt(0) === '-') fail('unknown option "' + a + '". Try --help.');
    o.files.push(a);
  }
  return o;
}
function parseFault(spec) {
  const at = spec.indexOf(':');
  const f = { type: at < 0 ? spec : spec.slice(0, at) };
  if (at >= 0) spec.slice(at + 1).split(',').forEach((kv) => {
    const eq = kv.indexOf('=');
    if (eq < 1) fail('could not read "' + kv + '" in --fault. Write it as key=value.');
    f[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  });
  const def = core.FAULTS.filter((x) => x.type === f.type)[0];
  if (!def) fail('unknown fault "' + f.type + '". Known faults: ' + core.FAULTS.map((x) => x.type).join(', '));
  Object.keys(f).forEach((k) => { if (k !== 'type' && k !== 'path' && !def.fields.some((x) => x.key === k)) fail('fault "' + f.type + '" has no setting "' + k + '". It takes: ' + (def.fields.map((x) => x.key).join(', ') || 'no settings') + ', path.'); });
  return f;
}
function readFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error('cannot read ' + file + ' (' + e.code + ').'); }
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(file + ' is not valid JSON: ' + e.message); }
  if (Array.isArray(data)) data = { routes: data };
  if (!data || typeof data !== 'object') throw new Error(file + ' must hold an object with a "routes" list.');
  const r = core.normalizeRoutes(data.routes || []);
  if (r.errors.length) throw new Error(file + ': ' + r.errors.join(' '));
  return data;
}
function describeFault(f) {
  if (!f || f.type === 'none') return 'none';
  const rest = Object.keys(f).filter((k) => k !== 'type' && f[k] !== '' && f[k] != null).map((k) => k + '=' + f[k]);
  return f.type + (rest.length ? ' (' + rest.join(', ') + ')' : '');
}
/* Routes as a person would write them: no empty headers, no zero delay. */
function tidy(list) {
  return list.map((r) => {
    const o = { method: r.method, path: r.path, status: r.status };
    if (r.headers && Object.keys(r.headers).length) o.headers = r.headers;
    if (r.body != null) o.body = r.body;
    if (r.delayMs) o.delayMs = r.delayMs;
    if (r.fault) o.fault = r.fault;
    if (r.enabled === false) o.enabled = false;
    return o;
  });
}
function time() { return new Date().toTimeString().slice(0, 8); }
function line(e) {
  let what;
  if (e.kind === 'preflight') what = '204 CORS preflight';
  else if (e.clientClosed) what = 'client gave up';
  else if (e.kind === 'network') what = 'connection dropped';
  else if (e.kind === 'bodyError') what = e.status + ' body cut short';
  else what = String(e.status);
  const tag = e.fault ? '  [' + e.fault + ' #' + e.attempt + ']' : '';
  return time() + '  ' + e.method.padEnd(8) + (e.path + (e.query || '')).padEnd(28) + ' -> ' + what + '  ' + e.ms + ' ms' + tag;
}

async function main() {
  if (process.argv[2] === 'webhook') return require('../lib/webhook-cli.js').run(process.argv.slice(3));
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  if (o.version) { console.log(pkg.version); return; }

  if (o.files[0] === 'init') {
    const target = path.resolve(o.files[1] || 'mock.json');
    if (fs.existsSync(target)) fail(path.basename(target) + ' already exists. Remove it first or pick another name.');
    fs.writeFileSync(target, JSON.stringify({ routes: core.SAMPLE_ROUTES }, null, 2) + '\n');
    console.log('Wrote ' + path.relative(process.cwd(), target) + ' with ' + core.SAMPLE_ROUTES.length + ' sample routes. Start it with: npx ' + pkg.name);
    return;
  }
  if (o.files.length > 1) fail('give one routes file, not ' + o.files.length + '.');

  let file = o.files[0] ? path.resolve(o.files[0]) : null;
  if (!file && fs.existsSync(path.resolve('mock.json'))) file = path.resolve('mock.json');
  let fromFile = {};
  if (file) { try { fromFile = readFile(file); } catch (e) { fail(e.message); } }
  if (o.save && !file) file = path.resolve('mock.json');

  const num = (v, name) => { if (v == null) return undefined; const n = Number(v); if (!isFinite(n) || n < 0) fail('"' + name + '" must be a number, got "' + v + '".'); return n; };
  const pick = (cli, key, d) => (cli !== undefined ? cli : (fromFile[key] !== undefined ? fromFile[key] : d));
  const port = num(o.port, '--port');
  const options = {
    port: port !== undefined ? port : (fromFile.port !== undefined ? Number(fromFile.port) : undefined),
    host: o.host, token: o.token, allowOrigins: o.allowOrigins, insecure: !!o.insecure,
    routes: fromFile.routes || [],
    graphql: resolveGraphQL(fromFile.graphql, file),
    fault: o.fault ? parseFault(o.fault) : fromFile.fault,
    latency: { baseMs: pick(num(o.latency, '--latency'), 'latency', 0), jitterMs: pick(num(o.jitter, '--jitter'), 'jitter', 0) },
    seed: pick(num(o.seed, '--seed'), 'seed', 42),
    cors: pick(o.cors, 'cors', true), repeat: pick(o.repeat, 'repeat', true), builtins: pick(o.builtins, 'builtins', true),
    ui: o.ui, send: o.send, sendLocalOnly: !!o.sendLocalOnly, file: file ? path.basename(file) : null
  };
  if (fromFile.latency && typeof fromFile.latency === 'object') {
    if (o.latency === undefined) options.latency.baseMs = Number(fromFile.latency.baseMs) || 0;
    if (o.jitter === undefined) options.latency.jitterMs = Number(fromFile.latency.jitterMs) || 0;
  }

  let mock;
  try { mock = await createMockServer(options).start(); }
  catch (e) {
    if (e.code === 'EADDRINUSE') fail('port ' + options.port + ' is already in use. Pick another with --port.');
    if (e.code === 'EACCES') fail('not allowed to listen on port ' + options.port + '. Use a port above 1024.');
    fail(e.message);
  }

  const routes = mock.routes().length, cfg = mock.config();
  const out = [
    '', pkg.name + ' ' + pkg.version, '',
    '  Mock API       ' + mock.url,
    options.ui === false ? null : '  Control page   ' + mock.controlUrl,
    '  Routes         ' + routes + (file && fs.existsSync(file) ? ' from ' + path.relative(process.cwd(), file) + (o.watch === false ? '' : ' (reloads when it changes)') : '') + (cfg.builtins ? (routes ? ' + demo routes' : ' of your own; demo routes are on (try ' + mock.url + '/items)') : ''),
    options.graphql ? '  GraphQL        POST ' + mock.url + options.graphql.path + '   (restart to pick up schema changes)' : null,
    '  Fault          ' + describeFault(cfg.fault) + (cfg.latency.baseMs || cfg.latency.jitterMs ? '   latency ' + cfg.latency.baseMs + ' ms + up to ' + cfg.latency.jitterMs + ' ms' : ''),
    options.ui === false ? null : '',
    options.ui === false ? null : '  To use the page on tinypdf.in instead, paste this there:',
    options.ui === false ? null : '    ' + mock.connectUrl,
    '', '  Ctrl+C to stop.', ''
  ].filter((x) => x !== null);
  console.log(out.join('\n'));
  if (options.port !== undefined && mock.port !== options.port && options.port !== 0) console.log('  (port ' + options.port + ' was taken)\n');

  if (!o.quiet) mock.on('request', (e) => console.log(line(e)));

  if (file && o.watch !== false) {
    let last = '';
    try { last = fs.readFileSync(file, 'utf8'); } catch (e) { /* created later by --save */ }
    fs.watchFile(file, { interval: 400 }, () => {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
      if (text === last) return;
      last = text;
      try { const d = readFile(file); mock.setRoutes(d.routes || []); console.log(time() + '  reloaded ' + path.basename(file) + ': ' + mock.routes().length + ' routes'); }
      catch (e) { console.log(time() + '  ' + e.message + ' Keeping the routes already loaded.'); }
    });
    if (o.save) mock.on('routes', (list) => {
      const d = Object.assign({}, fs.existsSync(file) ? (() => { try { return readFile(file); } catch (e) { return {}; } })() : {}, { routes: tidy(list) });
      last = JSON.stringify(d, null, 2) + '\n';
      try { fs.writeFileSync(file, last); console.log(time() + '  saved ' + list.length + ' routes to ' + path.basename(file)); } catch (e) { console.log(time() + '  could not save ' + path.basename(file) + ': ' + e.message); }
    });
  } else if (o.save && file) {
    mock.on('routes', (list) => { try { fs.writeFileSync(file, JSON.stringify({ routes: tidy(list) }, null, 2) + '\n'); } catch (e) { /* reported on next start */ } });
  }

  if (o.open && options.ui !== false) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', mock.controlUrl] : [mock.controlUrl];
    try { require('child_process').spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch (e) { /* open it by hand */ }
  }
  const bye = () => { if (file) fs.unwatchFile(file); mock.stop().then(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
main().catch((e) => fail(e && e.message || String(e)));
