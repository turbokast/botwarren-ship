/**
 * Shared adapter test kit: fake local servers, a host runner and the CANARY leak check.
 * A canary is a unique string planted where a real machine would have secrets. Two kinds:
 *   CONTENT canary  (prompts, tool output, titles, summaries, env values): must NEVER appear anywhere in anything emitted.
 *   PATH canary     (folder names): may appear ONLY inside a private `cwd`, never in public projections, other event
 *                   fields or logs.
 */
import { createServer as createHttp, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNet, type Server as NetServer, type Socket } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect } from 'vitest';
import { CanonicalEvent, projectPublic, type CanonicalEventInput } from '../../src/vendor/core/contract.ts';
import { AdapterHost } from '../../src/adapters/host.ts';
import type { Adapter, AdapterSettings } from '../../src/adapters/api.ts';
import type { Host } from '../../src/paths.ts';

export const CANARY_CONTENT = 'CANARY_CONTENT_9f3a1c7e_do-not-leak';
export const CANARY_PATH = 'CANARY_PATH_5b2d8e41';

export const mkTmp = (): string => mkdtempSync(join(tmpdir(), 'bw-adp-'));
export const rmTmp = (p: string): void => rmSync(p, { recursive: true, force: true });

export function linuxHost(home: string, env: Record<string, string | undefined> = {}): Host { return { platform: 'linux', home, env: { ...env } }; }

export interface Recorded { method: string; url: string }

/** A loopback HTTP server answering from a route table; records every request it receives. */
export async function fakeHttp(routes: Record<string, unknown | ((req: IncomingMessage) => unknown)>, opts: { sse?: { path: string; lines: string[] } } = {}): Promise<{ port: number; requests: Recorded[]; close: () => Promise<void>; server: HttpServer }> {
  const requests: Recorded[] = [];
  const server = createHttp((req: IncomingMessage, res: ServerResponse) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' });
    if (opts.sse && req.url === opts.sse.path) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const l of opts.sse.lines) res.write(`data: ${l}\n\n`);
      return; // keep the stream open
    }
    const r = routes[req.url ?? ''];
    if (r === undefined) { res.writeHead(404); res.end('not found'); return; }
    const body = typeof r === 'function' ? (r as (q: IncomingMessage) => unknown)(req) : r;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { port, requests, server, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/**
 * The endpoint a fake Herdr listens on for the config directory `dir`: `<dir>/herdr.sock` on POSIX; on Windows a named pipe whose
 * name is derived from `dir` (stable, so a restarted fake reuses the same endpoint), because Windows has no usable unix-socket path
 * in a temp folder and Herdr itself is a named pipe there.
 */
export function herdrEndpoint(dir: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\bw-herdr-${createHash('sha1').update(dir).digest('hex').slice(0, 16)}`;
  return join(dir, 'herdr.sock');
}

/** The Host an adapter sees when the fake Herdr for `dir` is running: linux/posix, or win32 with the pipe given explicitly (the only way Windows Herdr is found). */
export function herdrHost(home: string, dir: string, env: Record<string, string | undefined> = {}): Host {
  if (process.platform === 'win32') return { platform: 'win32', home, env: { ...env, HERDR_SOCKET_PATH: herdrEndpoint(dir) } };
  return linuxHost(home, env);
}

/** A unix-socket (Windows: named pipe) JSON-RPC server (newline-delimited) answering `agent.list` / `ping`; records every method it gets. */
export async function fakeHerdr(dir: string, agents: () => unknown[]): Promise<{ path: string; methods: string[]; close: () => Promise<void> }> {
  mkdirSync(dir, { recursive: true });
  const path = herdrEndpoint(dir);
  const methods: string[] = [];
  const socks = new Set<Socket>();
  const server: NetServer = createNet((s) => {
    socks.add(s);
    s.setEncoding('utf8');
    let buf = '';
    s.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = JSON.parse(line) as { id: string; method: string };
        methods.push(m.method);
        const result = m.method === 'agent.list' ? { agents: agents() } : m.method === 'ping' ? { pong: true } : null;
        s.write(JSON.stringify({ id: m.id, result }) + '\n');
      }
    });
    s.on('close', () => socks.delete(s));
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { path, methods, close: () => new Promise<void>((r) => { for (const s of socks) s.destroy(); server.close(() => r()); }) };
}

export interface RunOptions {
  adapters: { adapter: Adapter; settings?: Partial<AdapterSettings> }[];
  host: Host;
  projects: { id: string; repoPaths: string[] }[];
  attribute?: (cwd: string | null | undefined, now: number) => Promise<string | null>;
}

/** Attributes by simple path prefix (the real ProjectAttributor is covered by its own tests). */
export function prefixAttribute(projects: { id: string; repoPaths: string[] }[]) {
  return async (cwd: string | null | undefined): Promise<string | null> => {
    if (!cwd) return null;
    for (const p of projects) for (const r of p.repoPaths) if (cwd === r || cwd.startsWith(r + '/')) return p.id;
    return null;
  };
}

export function makeHost(o: RunOptions): { host: AdapterHost; logs: string[] } {
  const logs: string[] = [];
  const host = new AdapterHost({
    adapters: o.adapters.map((a) => ({ adapter: a.adapter, settings: { enabled: true, ...a.settings } as AdapterSettings })),
    instance: 'inst', host: o.host, projects: o.projects, log: (m) => logs.push(m),
    attribute: o.attribute ?? prefixAttribute(o.projects),
  });
  return { host, logs };
}

export const sessions = (evs: CanonicalEventInput[]) => evs.filter((e) => e.type === 'session.observed') as Extract<CanonicalEventInput, { type: 'session.observed' }>[];
export const ended = (evs: CanonicalEventInput[]) => evs.filter((e) => e.type === 'session.ended') as Extract<CanonicalEventInput, { type: 'session.ended' }>[];

const strip = (e: CanonicalEventInput): unknown => { const { private: _p, ...rest } = e as unknown as Record<string, unknown>; void _p; return rest; };

/**
 * The shared canary assertion.
 *  - every event is a valid canonical event
 *  - CONTENT canary: nowhere (events incl. private, public projection, logs)
 *  - PATH canary: not in any event field except `private.cwd`, not in the public projection, not in logs
 */
export function assertNoLeak(events: CanonicalEventInput[], logs: string[], projectIds: string[]): void {
  const policy = { publicProjects: new Set(projectIds) as unknown as ReadonlySet<never>, demoMode: false, pseudonym: (_ns: string, k: string) => Buffer.from(k).toString('hex').slice(0, 8).padEnd(8, '0').replace(/[^0-9a-f]/g, '0') };
  const all = JSON.stringify(events);
  const logText = logs.join('\n');
  expect(all).not.toContain(CANARY_CONTENT);
  expect(logText).not.toContain(CANARY_CONTENT);
  expect(logText).not.toContain(CANARY_PATH);
  expect(JSON.stringify(events.map(strip))).not.toContain(CANARY_PATH);
  for (const e of events) {
    const parsed = CanonicalEvent.safeParse(e);
    expect(parsed.success).toBe(true);
    if (!parsed.success) continue;
    const priv = (e as { private?: Record<string, unknown> }).private ?? {};
    for (const [k, v] of Object.entries(priv)) if (k !== 'cwd') expect(String(v)).not.toContain(CANARY_PATH);
    const pub = projectPublic(parsed.data, policy);
    expect(JSON.stringify(pub)).not.toContain(CANARY_PATH);
    expect(JSON.stringify(pub)).not.toContain(CANARY_CONTENT);
  }
}
