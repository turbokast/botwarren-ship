/**
 * Allowlisted access handed to adapters. Everything here is READ-ONLY and narrow by construction:
 *  - LoopbackHttp: GET only, 127.0.0.1 / ::1 only (never a hostname), exact path allowlist (query strings are refused),
 *    no redirects, response size capped. Anything else throws PolicyError BEFORE a socket is opened.
 *  - ScopedFs: list / stat / readHead inside declared roots only, symlinks refused, reads capped at 1 MiB.
 */
import { request } from 'node:http';
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { isInside } from '../pathmatch.ts';
import { PolicyError, type LoopbackHttp, type ScopedFs } from './api.ts';

const MAX_BODY = 2 * 1024 * 1024;
const MAX_SSE_LINE = 64 * 1024;

export interface LoopbackOptions {
  /** exact request paths this adapter may GET, e.g. ['/api/v1/sessions'] */
  allow: readonly string[];
  port: number;
  host?: '127.0.0.1' | '::1';
}

export function makeLoopbackHttp(o: LoopbackOptions): LoopbackHttp {
  const host = o.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new PolicyError('host must be loopback');
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new PolicyError('bad port');
  const denied = (path: string): PolicyError | null => (o.allow.includes(path) ? null : new PolicyError('path not allowed'));
  return {
    get(path, opts = {}) {
      const d = denied(path);
      if (d) return Promise.reject(d);
      const maxBytes = Math.min(opts.maxBytes ?? MAX_BODY, MAX_BODY);
      return new Promise((resolve, reject) => {
        const req = request({ host, port: o.port, path, method: 'GET', agent: false, timeout: opts.timeoutMs ?? 4000, headers: { accept: 'application/json' } }, (res) => {
          const chunks: Buffer[] = [];
          let n = 0;
          res.on('data', (c: Buffer) => {
            n += c.length;
            if (n > maxBytes) { req.destroy(new PolicyError('response too large')); return; }
            chunks.push(c);
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
      });
    },
    sse(path, onData, signal) {
      const d = denied(path);
      if (d) return Promise.reject(d);
      return new Promise((resolve, reject) => {
        const req = request({ host, port: o.port, path, method: 'GET', agent: false, headers: { accept: 'text/event-stream' } }, (res) => {
          if ((res.statusCode ?? 0) !== 200) { res.resume(); reject(new Error('sse status')); return; }
          res.setEncoding('utf8');
          let buf = '';
          res.on('data', (chunk: string) => {
            buf += chunk;
            let i: number;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i).replace(/\r$/, '');
              buf = buf.slice(i + 1);
              if (line.startsWith('data:') && line.length <= MAX_SSE_LINE) onData(line.slice(5).trimStart());
            }
            if (buf.length > MAX_SSE_LINE) buf = ''; // an over-long line is dropped, never buffered
          });
          res.on('end', () => resolve());
          res.on('error', reject);
        });
        const abort = (): void => { req.destroy(); resolve(); };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        req.on('error', (e) => { if (signal.aborted) resolve(); else reject(e); });
        req.end();
      });
    },
  };
}

/** Probe helper for detection: same policy, a single GET, null on any failure. */
export async function probeLoopback(allow: readonly string[], port: number, path: string, host: '127.0.0.1' | '::1' = '127.0.0.1'): Promise<{ status: number; body: string } | null> {
  try { return await makeLoopbackHttp({ allow, port, host }).get(path, { timeoutMs: 1500, maxBytes: 512 * 1024 }); } catch { return null; }
}

const HARD_READ_CAP = 1024 * 1024;

export function makeScopedFs(roots: readonly string[]): ScopedFs {
  const inRoots = (p: string): boolean => roots.some((r) => isInside(p, r));
  const guard = (p: string): void => { if (!inRoots(p) || p.includes('\0')) throw new PolicyError('path outside declared roots'); };
  return {
    list(dir) {
      guard(dir);
      try { return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() })); } catch { return []; }
    },
    stat(path) {
      guard(path);
      try {
        const s = lstatSync(path);
        if (s.isSymbolicLink()) return null; // symlinks are never followed
        return { mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile() };
      } catch { return null; }
    },
    readHead(path, maxBytes) {
      guard(path);
      try {
        if (lstatSync(path).isSymbolicLink()) return null;
        const fd = openSync(path, 'r');
        try {
          const len = Math.min(Math.max(0, Math.floor(maxBytes)), HARD_READ_CAP, fstatSync(fd).size);
          const buf = Buffer.alloc(len);
          readSync(fd, buf, 0, len, 0);
          return buf;
        } finally { closeSync(fd); }
      } catch { return null; }
    },
  };
}
