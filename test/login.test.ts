import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runLogin, shipOrigin, validateLoginUrl, type LoginDeps } from '../src/login.ts';
import { VERSION } from '../src/version.ts';

const SECRET = 'SUPER-SECRET-SHIP-VALUE-0123456789';
const cfg = { replicaUrl: 'https://demo1.botwarren.com/internal/publish', secretFile: '/nowhere/ship.secret' };
const LINK = 'https://botwarren.com/login#code=AbC123_-xyz';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function harness(res: Response | Error, extra: Partial<LoginDeps> = {}) {
  const outs: string[] = []; const errs: string[] = [];
  const fetchImpl = vi.fn(async () => { if (res instanceof Error) throw res; return res; });
  const opener = vi.fn(async (_url: string) => true);
  const deps: LoginDeps = { fetchImpl: fetchImpl as unknown as typeof fetch, opener, readSecret: () => SECRET, out: (s) => outs.push(s), err: (s) => errs.push(s), ...extra };
  return { deps, outs, errs, fetchImpl, opener, all: () => outs.join('') + errs.join('') };
}

describe('botwarren login', () => {
  it('requests the link from the ship origin with the bearer secret, then opens the browser', async () => {
    const h = harness(json(200, { url: LINK, expiresInSeconds: 600 }));
    expect(await runLogin(cfg, [], h.deps)).toBe(0);
    const [url, init] = h.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://demo1.botwarren.com/internal/login-link');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' });
    expect(h.opener).toHaveBeenCalledWith(LINK);
    expect(h.outs.join('')).toContain(LINK);
    expect(h.outs.join('')).toMatch(/works once and expires in 10 minutes/);
  });

  it('--no-open only prints the link', async () => {
    const h = harness(json(200, { url: LINK, expiresInSeconds: 600 }));
    expect(await runLogin(cfg, ['--no-open'], h.deps)).toBe(0);
    expect(h.opener).not.toHaveBeenCalled();
    expect(h.outs.join('')).toContain(LINK);
  });

  it('prints the link with a hint when no browser can be opened (still exit 0)', async () => {
    const h = harness(json(200, { url: LINK }), { opener: async () => false });
    expect(await runLogin(cfg, [], h.deps)).toBe(0);
    expect(h.outs.join('')).toMatch(/Could not open a browser/);
    expect(h.outs.join('')).toContain(LINK);
  });

  it('rejects unknown options without calling the server', async () => {
    const h = harness(json(200, { url: LINK }));
    expect(await runLogin(cfg, ['--bogus'], h.deps)).toBe(1);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses unsafe links from the server and never opens them', async () => {
    for (const bad of ['http://botwarren.com/login#code=x', 'https://evil.example/login#code=x', 'https://botwarren.com.evil.example/login', 'javascript:alert(1)', 'https://botwarren.com/login#code=x&calc', 'https://user:pw@botwarren.com/login', 'https://botwarren.com/login#code="x"']) {
      const h = harness(json(200, { url: bad }));
      expect(await runLogin(cfg, [], h.deps)).toBe(1);
      expect(h.opener).not.toHaveBeenCalled();
      expect(h.errs.join('')).toMatch(/does not look safe/);
    }
  });

  it('reports 401, 429, other HTTP errors, network errors and timeouts in plain language', async () => {
    const a = harness(json(401, { error: 'nope' })); expect(await runLogin(cfg, [], a.deps)).toBe(1);
    expect(a.errs.join('')).toMatch(/secret was not accepted/);
    const b = harness(json(429, {})); expect(await runLogin(cfg, [], b.deps)).toBe(1);
    expect(b.errs.join('')).toMatch(/Too many sign-in links/);
    const c = harness(json(500, {})); expect(await runLogin(cfg, [], c.deps)).toBe(1);
    expect(c.errs.join('')).toMatch(/HTTP 500/);
    const d = harness(new TypeError('fetch failed')); expect(await runLogin(cfg, [], d.deps)).toBe(1);
    expect(d.errs.join('')).toMatch(/Could not reach https:\/\/demo1\.botwarren\.com/);
    const t = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const e = harness(t); expect(await runLogin(cfg, [], e.deps)).toBe(1);
    expect(e.errs.join('')).toMatch(/Timed out/);
    for (const h of [a, b, c, d, e]) expect(h.opener).not.toHaveBeenCalled();
  });

  it('handles a missing secret file and a malformed response', async () => {
    const a = harness(json(200, { url: LINK }), { readSecret: () => { throw new Error('ship secret file not found: /x'); } });
    expect(await runLogin(cfg, [], a.deps)).toBe(1);
    expect(a.fetchImpl).not.toHaveBeenCalled();
    const b = harness(json(200, { nope: true })); expect(await runLogin(cfg, [], b.deps)).toBe(1);
  });

  it('never writes the ship secret to stdout or stderr, on any path', async () => {
    const cases: (Response | Error)[] = [json(200, { url: LINK }), json(401, {}), json(429, {}), json(500, { echo: SECRET }), json(200, { url: 'http://evil.example/' }), new Error(`boom ${'x'}`)];
    for (const r of cases) for (const flags of [[], ['--no-open']]) {
      const h = harness(r);
      await runLogin(cfg, flags, h.deps);
      expect(h.all()).not.toContain(SECRET);
    }
  });
});

describe('validateLoginUrl', () => {
  const origin = 'https://demo1.botwarren.com';
  it('accepts https on botwarren.com and subdomains', () => {
    expect(validateLoginUrl('https://botwarren.com/login#code=abc', origin)).toBe('https://botwarren.com/login#code=abc');
    expect(validateLoginUrl('https://demo1.botwarren.com/login#code=abc', origin)).not.toBeNull();
  });
  it('rejects non-https, foreign hosts and look-alikes', () => {
    expect(validateLoginUrl('http://botwarren.com/login', origin)).toBeNull();
    expect(validateLoginUrl('https://example.com/login', origin)).toBeNull();
    expect(validateLoginUrl('https://notbotwarren.com/login', origin)).toBeNull();
    expect(validateLoginUrl('https://botwarren.com.evil.io/login', origin)).toBeNull();
    expect(validateLoginUrl('file:///etc/passwd', origin)).toBeNull();
    expect(validateLoginUrl('not a url', origin)).toBeNull();
  });
  it('allows exactly the configured local server origin (local testing only)', () => {
    expect(validateLoginUrl('http://127.0.0.1:4400/login#code=abc', 'http://127.0.0.1:4400')).not.toBeNull();
    expect(validateLoginUrl('http://127.0.0.1:4401/login#code=abc', 'http://127.0.0.1:4400')).toBeNull();
    expect(validateLoginUrl('http://127.0.0.1:4400/login', origin)).toBeNull();
    expect(validateLoginUrl('http://example.com/login', 'http://example.com')).toBeNull();
  });
  it('derives the ship origin from the replica URL', () => {
    expect(shipOrigin('https://demo1.botwarren.com/internal/publish')).toBe('https://demo1.botwarren.com');
  });
});

describe('version', () => {
  it('is 0.7.0 in package.json and version.ts', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(pkg.version).toBe('0.7.0');
    expect(VERSION).toBe(pkg.version);
  });
});
