export interface MockRoute {
  /** GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS or "*" for any. Default GET. */
  method?: string;
  /** Starts with "/". May hold :name parts and a trailing "*". */
  path: string;
  /** 200 to 599. Default 200. */
  status?: number;
  headers?: Record<string, string>;
  /** An object is sent as JSON. Text may hold {{params.x}}, {{query.x}}, {{body.x}}, {{now}}, {{uuid}}. */
  body?: unknown;
  /** How long this route takes to answer. */
  delayMs?: number;
  /** A fault for this route only; replaces the server-wide fault. */
  fault?: MockFault;
  enabled?: boolean;
}
export interface MockFault {
  type: 'none' | 'fail-first-n' | 'random' | 'always' | 'drop-first-n' | 'drop-after-process' | 'rate-limit-until' | 'slow-first-n' | 'truncated-first-n' | 'malformed';
  n?: number; status?: number; retryAfter?: number | ''; pct?: number; sec?: number; slowMs?: number;
  /** Only requests whose path starts with this are affected. */
  path?: string;
}
export interface MockOptions {
  /** Default 4747, moving to the next free port when taken. Use 0 for any free port. */
  port?: number;
  host?: string;
  routes?: MockRoute[];
  fault?: MockFault;
  latency?: { baseMs?: number; jitterMs?: number };
  seed?: number;
  cors?: boolean;
  /** Start a "first N" fault over after each success. Default true. */
  repeat?: boolean;
  /** Serve the demo routes (/items, /status/:code, /delay/:ms, /secure, /headers). Default true. */
  builtins?: boolean;
  ui?: boolean;
  send?: boolean;
  token?: string;
  allowOrigins?: string[];
  maxLog?: number;
}
export interface MockRequest {
  id: number; time: string; method: string; path: string; query: string;
  headers: Record<string, string | string[] | undefined>; body: string; bodyBytes: number;
  kind: 'response' | 'network' | 'bodyError' | 'preflight';
  status: number | null; fault: string | null; attempt: number; route: string | null;
  responseHeaders: Record<string, string>; responseBody: string; ms: number;
  clientClosed?: boolean; message?: string;
}
export interface MockServer {
  start(): Promise<MockServer>;
  stop(): Promise<void>;
  readonly port: number;
  /** For example http://localhost:4747 */
  readonly url: string;
  readonly token: string;
  readonly controlUrl: string;
  readonly connectUrl: string;
  requests(): MockRequest[];
  clearRequests(): void;
  routes(): MockRoute[];
  config(): { fault: MockFault; latency: { baseMs: number; jitterMs: number }; seed: number; cors: boolean; repeat: boolean; builtins: boolean };
  setFault(fault?: MockFault | null): void;
  setLatency(baseMs: number, jitterMs?: number): void;
  setConfig(patch: Partial<Pick<MockOptions, 'fault' | 'latency' | 'seed' | 'cors' | 'repeat' | 'builtins'>>): void;
  setRoutes(routes: MockRoute[]): MockRoute[];
  reset(): void;
  rearm(): void;
  on(event: 'request', listener: (request: MockRequest) => void): MockServer;
  on(event: 'routes' | 'config', listener: (value: any) => void): MockServer;
  off(event: string, listener: (...args: any[]) => void): MockServer;
}
export function createMockServer(options?: MockOptions): MockServer;
export function startMockServer(options?: MockOptions): Promise<MockServer>;
export const DEFAULT_PORT: number;
export const FAULTS: Array<{ type: string; label: string; help: string; fields: Array<{ key: string; label: string; def: number | string }> }>;
