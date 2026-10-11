# tinypdf-mock

A mock API for your machine that can also misbehave on purpose.

- **Mock routes** from a small JSON file, with path parameters and templated bodies.
- **Fault injection over real HTTP**: 503s, 429 with `Retry-After`, slow answers, dropped connections, responses lost after the work was done, bodies cut off half way, invalid JSON.
- **A control page in your browser** that lists every request the server receives, lets you change routes and faults while it runs, and sends test requests with a retry policy.
- No dependencies. Needs Node.js 18 or newer.
- Open source (MIT) and small enough to read before you run it: see [What it does on your machine](#what-it-does-on-your-machine).

```
npx tinypdf-mock
```

```
  Mock API       http://localhost:4747
  Control page   http://localhost:4747/__mock/
```

The same mock runs in the browser, with nothing to install, at
[tinypdf.in/rest-api-playground.html](https://tinypdf.in/rest-api-playground.html).

## If you build a frontend

Mock the API your app will call, before it exists.

```
npx tinypdf-mock init     # writes a starter mock.json
npx tinypdf-mock          # serves it, and reloads when you edit the file
```

Point your app at `http://localhost:4747`. CORS headers and preflight answers are sent for you.
Then open the control page and switch on a problem to see how your screens cope:

| To see | Choose |
|---|---|
| Your loading state | Base latency 2000 ms, or a route with `"delayMs": 2000` |
| Your error state | Always fail, status 500 |
| A flaky network | Random failures, 30% |
| A request that never comes back | Slow responses, longer than your timeout |
| What a CORS failure looks like | Untick "Send CORS headers" |

## If you build a backend

Put it in place of a service your code depends on, then make that service fail.

```
npx tinypdf-mock --no-builtins --fault fail-first-n:n=2,status=503,retryAfter=1
```

Set the base address of your payment, email or other client to `http://localhost:4747`.
The control page shows each request your service sends, with headers and body, so you can
see whether it retried, how long it waited and whether it sent an `Idempotency-Key`.

`drop-after-process` is the one to try with POST: the mock does the work, then drops the
connection, exactly as a timeout looks from the caller's side. If your service retries
without an idempotency key, the request log shows the duplicate.

## In tests

```js
const { startMockServer } = require('tinypdf-mock');

const mock = await startMockServer({
  port: 0,                                   // any free port
  builtins: false,
  routes: [{ method: 'POST', path: '/charges', status: 201, body: { id: 'ch_1' } }],
  fault: { type: 'fail-first-n', n: 2, status: 503 },
});

await myClient.charge({ baseUrl: mock.url });   // your code under test

assert.equal(mock.requests().length, 3);        // two failures, then success
assert.ok(mock.requests()[0].headers['idempotency-key']);

await mock.stop();
```

Also available: `mock.setFault()`, `mock.setRoutes()`, `mock.setLatency()`, `mock.reset()`,
`mock.rearm()`, `mock.clearRequests()` and `mock.on('request', fn)`. Types are included.

## Routes file

`mock.json` in the folder you start from is loaded automatically, or pass a path.

```json
{
  "routes": [
    { "method": "GET", "path": "/users/:id", "status": 200,
      "body": { "id": "{{params.id | number}}", "name": "User {{params.id}}" } },
    { "method": "POST", "path": "/users", "status": 201,
      "headers": { "Location": "/users/3" },
      "body": { "id": 3, "name": "{{body.name}}" } },
    { "method": "GET", "path": "/report", "delayMs": 2000, "body": { "ready": true } },
    { "method": "*", "path": "/files/*", "body": "You asked for {{params.*}}" }
  ]
}
```

| Field | Meaning |
|---|---|
| `method` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, or `*` for any. Default `GET`. |
| `path` | Starts with `/`. `:name` matches one part, a final `*` matches the rest. |
| `status` | 200 to 599. Default 200. |
| `headers` | Response headers. |
| `body` | An object or list is sent as JSON; text is sent as it is. |
| `delayMs` | How long this route takes to answer. |
| `fault` | A fault for this route only, in place of the server-wide one. |

Values you can put in a body or header: `{{params.x}}`, `{{query.x}}`, `{{body.x}}` (from a JSON
request body), `{{headers.x}}`, `{{method}}`, `{{path}}`, `{{now}}`, `{{timestamp}}`, `{{uuid}}`.
A JSON value that is only a placeholder keeps its type, so `"{{body.tags}}"` becomes the list
that was sent. Add `| number` to turn text into a number.

Routes are checked in order, before the demo routes. Next to `routes` the file may also set
`port`, `fault`, `latency`, `seed`, `cors`, `repeat` and `builtins`.

The demo routes (`/items`, `/items/1`, `/secure`, `/status/503`, `/delay/1500`, `/headers`) are
there so the server is useful before you write anything. Turn them off with `--no-builtins`.

## Faults

Set one with `--fault`, in `mock.json`, from the control page or with `mock.setFault()`.

| Fault | What the caller gets |
|---|---|
| `fail-first-n:n=2,status=503,retryAfter=1` | The first N requests fail, then success. `retryAfter` adds a `Retry-After` header. |
| `random:pct=30` | Each request fails with 500, 502, 503 or 504 at this rate. The same `--seed` gives the same sequence. |
| `always:status=500` | Every request fails. |
| `drop-first-n:n=2` | The connection is closed with no response. The request is not processed. |
| `drop-after-process:n=1` | The request is processed, then the connection is closed with no response. |
| `rate-limit-until:sec=4` | 429 with `Retry-After` until this many seconds after the first request. |
| `slow-first-n:n=2,slowMs=5000` | The first N answers take this long. |
| `truncated-first-n:n=1` | Headers and half the body arrive, then the connection closes. |
| `malformed` | 200 OK with a body that is not valid JSON. |

Counts are kept per method and path. After a request gets through, the count starts over, so
"fail the first 2" fails the first 2 of every round; `--no-repeat` makes a fault fire once.
Add `path=/orders` to any fault to limit it to paths starting with that text.
Faulted responses carry an `X-Mock-Fault` header so you can tell them apart.

## Control page

`http://localhost:4747/__mock/` is served by the package and works offline.

- **Requests received**: each request with its headers, body and what the mock answered.
- **Server behavior** and **Mock routes**: edit them and the running server changes at once.
  Start with `--save` to write route edits back to `mock.json`.
- **Request form**: sends a request from the server, not from the browser, so there are no CORS
  limits and no blocked headers, to the mock or to any other address. A retry policy with a
  timeline shows each attempt and wait.

The page on tinypdf.in can drive the server too: choose "Local server" there and paste the
address printed at start-up. Some browsers refuse a web page access to localhost; the
control page above always works.

## Options

```
npx tinypdf-mock [file] [options]

  -p, --port <n>       port (default 4747; the next free one is used if it is taken)
      --host <name>    address to listen on (default localhost; 0.0.0.0 for other devices)
  -f, --fault <spec>   start with a fault
      --latency <ms>   delay added to every answer
      --jitter <ms>    random extra delay
      --seed <n>       seed for random failures and jitter
      --no-repeat      a "first N" fault fires once
      --no-builtins    serve only your routes
      --no-cors        do not add CORS headers
      --no-watch       do not reload the routes file when it changes
      --save           write routes edited in the control page back to the file
      --no-send        do not let the control page send requests
      --send-local-only  only send to this machine and private network addresses
      --insecure       accept self-signed certificates when sending
      --no-ui          do not serve the control page
      --allow-origin <url>   let a page on this origin control the server
      --token <text>   fixed control token
  -o, --open           open the control page
  -q, --quiet          no line per request
```

## What it does on your machine

You are about to run a server from the internet on your own computer, so here is all of it.

| | |
|---|---|
| **Listens** | On `localhost` only (127.0.0.1 and ::1), port 4747 or the next free one. Other machines cannot connect unless you pass `--host`. |
| **Connects out** | Only when you press Send on the control page, or call its `send` API with the token, and only to the address given. Nothing else: no telemetry, no update check, no analytics, no fonts or scripts loaded from elsewhere by the control page. |
| **Reads** | The routes file you name, or `./mock.json`, and its own files. |
| **Writes** | Nothing, unless you run `init` (creates `mock.json`) or `--save` (updates the routes file). |
| **Runs** | Nothing, unless you pass `--open`, which starts your browser on the control page. |
| **Depends on** | Node.js built-in modules only. `npm install` adds no other package and runs no install script. |
| **Remembers** | Requests it received (the last 200) are kept in memory and gone when it stops. |

The whole program is four plain JavaScript files, not minified or bundled:

| File | Lines | What it is |
|---|---|---|
| `bin/cli.js` | about 220 | Command line: reads options and the routes file, prints the log |
| `lib/server.js` | about 430 | The HTTP server: mock API, control API, request sender |
| `lib/sim-core.js` | about 890 | Routes, faults and the retry runner; the same file runs in the browser |
| `ui/rest-ui.js` | about 860 | The control page's behaviour |

To check that what npm gives you is what is in this repository:

```
npm pack tinypdf-mock            # downloads the published tarball without running it
tar -xzf tinypdf-mock-*.tgz      # unpack and compare package/ with a checkout of the same version tag
```

Releases are published from GitHub Actions with npm provenance, so each version on npm
names the commit it was built from.

## Safety

This is a development tool. It listens on localhost only unless you pass `--host`.

Everything under `/__mock/api/` needs the token printed at start-up, must be addressed as
localhost, and is refused for web pages on any origin other than the server itself,
`https://tinypdf.in` and those you add with `--allow-origin`. That matters because the control
API can send HTTP requests from your machine. `--send-local-only` limits those to this machine and private
network addresses, and `--no-send` turns sending off. A run from the control page makes at most 10 attempts.

The mock API itself (every other path) answers anyone who can reach the port, and with CORS on
it answers any web page you have open. Do not put real secrets in mock responses.

Found a way around these rules? See [SECURITY.md](SECURITY.md).

## Working on it

```
git clone https://github.com/log2ankit/tinypdf-mock
cd tinypdf-mock
npm test              # no install needed
node bin/cli.js       # run from the checkout
```

There is no build step. `lib/` and `bin/` are the server; `ui/` is the control page, served as it is.
`lib/sim-core.js` is shared: the server requires it and also hands it to the page.

The REST API Playground on tinypdf.in is built from this repository: it uses `lib/sim-core.js`,
`ui/rest-ui.js`, `ui/api.css` and the part of `ui/index.html` between the `<!--tool-->` markers.
Keep those markers in place when editing the page. `ui/play.css` is the site's base stylesheet,
copied here so the control page works offline.

Issues and pull requests are welcome.

## Licence

MIT
