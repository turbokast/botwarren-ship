import { VERSION } from '../src/version.ts';
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { parsePairFlags, runPair, shipUrlOk, siteOrigin, type PairDeps } from '../src/pair.ts';
import { applyOnboardingDelay, ONBOARDING_DELAY_SECONDS } from '../src/onboarding.ts';
import { loadConfig } from '../src/config.ts';
import { tmp } from './helpers.ts';

const SECRET = 'PAIRED-SHIP-SECRET-0123456789abcdefghijklmno';
const DEVICE = 'device-code-0123456789abcdefghijklmnopqrstuvwxyz';
const START = { device_code: DEVICE, user_code: 'BW-7KQ-4MD', verification_uri: 'https://botwarren.com/pair', verification_uri_complete: 'https://botwarren.com/pair?code=7KQ4MD', interval: 5, expires_in: 600 };
const PAIRED = { ship_id: 'demo1', ship_name: 'My Ship', secret: SECRET, base_url: 'https://demo1.botwarren.com' };
const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Script { start?: () => Response | Promise<Response>; polls: (Response | Error)[] }
function harness(script: Script, over: Partial<PairDeps> = {}) {
  const root = tmp();
  const repo = join(root, 'code', 'my-game'); mkdirSync(join(repo, '.git'), { recursive: true });
  const host = { platform: 'linux' as const, home: root, env: { XDG_CONFIG_HOME: join(root, 'cfg'), XDG_DATA_HOME: join(root, 'data') } };
  let clock = Date.parse('2026-10-14T10:00:00Z');
  const outs: string[] = []; const errs: string[] = [];
  const calls: { url: string; body: unknown }[] = [];
  let poll = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (u.endsWith('/api/pair/start')) return script.start ? script.start() : j(200, START);
    const r = script.polls[Math.min(poll++, script.polls.length - 1)]!;
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  const opener = vi.fn(async (_u: string) => true);
  const startAgent = vi.fn(async (_c: string) => 'restarted' as const);
  const deps: PairDeps = { fetchImpl, opener, out: (s) => outs.push(s), err: (s) => errs.push(s), host, env: {}, cwd: repo, now: () => clock, sleep: async (ms) => { clock += ms; }, startAgent, agentUp: async () => true, restrictFile: async () => undefined, interactive: false, ...over };
  const text = () => outs.join('') + errs.join('');
  return { deps, outs, errs, text, calls, opener, startAgent, root, repo, host, cfgFile: join(root, 'cfg', 'botwarren-ship', 'config.json'), secretFile: join(root, 'cfg', 'botwarren-ship', 'ship.secret'), now: () => clock };
}

describe('botwarren pair', () => {
  it('shows the code, opens the browser, waits through pending and slow_down, then saves the secret and config and starts the agent', async () => {
    const h = harness({ polls: [j(400, { error: 'authorization_pending' }), j(400, { error: 'slow_down', interval: 10 }), j(400, { error: 'authorization_pending' }), j(200, PAIRED)] });
    expect(await runPair([], h.deps)).toBe(0);
    expect(h.text()).toContain('BW-7KQ-4MD');
    expect(h.text()).toContain('https://botwarren.com/pair');
    expect(h.opener).toHaveBeenCalledWith('https://botwarren.com/pair?code=7KQ4MD');
    // start: OS and agent version only (no computer name, no paths)
    expect(h.calls[0]).toEqual({ url: 'https://botwarren.com/api/pair/start', body: { os: 'linux', agent: VERSION } });
    expect(h.calls.slice(1).every((c) => c.url === 'https://botwarren.com/api/pair/poll' && JSON.stringify(c.body) === JSON.stringify({ device_code: DEVICE }))).toBe(true);
    // the secret is in the user-only file and NOWHERE in the output
    expect(readFileSync(h.secretFile, 'utf8')).toBe(SECRET);
    if (process.platform !== 'win32') expect(statSync(h.secretFile).mode & 0o777).toBe(0o600); // Windows has no POSIX modes (the installer sets a user-only ACL)
    expect(h.text()).not.toContain(SECRET);
    // the config is valid for the agent, starts the short onboarding window and watches the folder it was run in
    const cfg = loadConfig(h.cfgFile, h.host);
    expect(cfg).toMatchObject({ shipId: 'demo1', replicaUrl: 'https://demo1.botwarren.com', delaySeconds: 90 });
    // the harness fakes a Linux host on every runner, so the agent writes a POSIX-joined path; compare the file it names, not the spelling
    expect(normalize(cfg.secretFile)).toBe(normalize(h.secretFile));
    expect(cfg.projects).toEqual([{ id: 'demo1', publicName: 'DEMO1 Project', realName: null, repoPaths: [h.repo] }]);
    expect(cfg.onboardingUntil).toBe(h.now() + 15 * 60_000);
    expect(h.startAgent).toHaveBeenCalledWith(h.cfgFile);
    expect(h.text()).toMatch(/Connected: this computer is now linked to My Ship/);
    expect(h.text()).toMatch(/30 seconds/);
  });

  it('honours the interval (waits 5 s, then the longer slow_down interval)', async () => {
    const waits: number[] = [];
    const h = harness({ polls: [j(400, { error: 'slow_down', interval: 10 }), j(400, { error: 'authorization_pending' }), j(200, PAIRED)] }, { sleep: async (ms) => { waits.push(ms); } });
    expect(await runPair([], h.deps)).toBe(0);
    expect(waits).toEqual([5000, 10_000, 10_000]);
  });

  it('--no-open only prints; --no-start saves but does not start; --repo and --name set the project', async () => {
    const h = harness({ polls: [j(200, PAIRED)] });
    mkdirSync(join(h.root, 'other'), { recursive: true });
    expect(await runPair(['--no-open', '--no-start', '--repo', join(h.root, 'other'), '--name', 'Dragon Game'], h.deps)).toBe(0);
    expect(h.opener).not.toHaveBeenCalled();
    expect(h.startAgent).not.toHaveBeenCalled();
    const cfg = loadConfig(h.cfgFile, h.host);
    expect(cfg.projects[0]).toMatchObject({ publicName: 'Dragon Game', repoPaths: [join(h.root, 'other')] });
  });

  it('a first run outside any git checkout asks for a folder, or explains --repo when it cannot ask', async () => {
    const h = harness({ polls: [j(200, PAIRED)] }, { findRepo: () => null });
    expect(await runPair([], h.deps)).toBe(2);
    expect(h.text()).toMatch(/--repo <folder>/);
    expect(h.calls).toHaveLength(0); // nothing was started on the server
    let answer = '';
    const h2 = harness({ polls: [j(200, PAIRED)] }, { findRepo: () => null, interactive: true, prompt: async () => answer });
    answer = h2.repo;
    expect(await runPair([], h2.deps)).toBe(0);
    expect(loadConfig(h2.cfgFile, h2.host).projects[0]!.repoPaths).toEqual([h2.repo]);
  });

  it('re-pairing keeps the owner\'s projects, delay and ports, replaces ship and secret, and says the old secret stops working', async () => {
    const h = harness({ polls: [j(200, { ...PAIRED, ship_id: 'demo2', ship_name: 'Other', base_url: 'https://demo2.botwarren.com' })] });
    mkdirSync(join(h.root, 'cfg', 'botwarren-ship'), { recursive: true });
    writeFileSync(h.secretFile, 'OLD-SECRET-0123456789');
    writeFileSync(h.cfgFile, JSON.stringify({ shipId: 'demo3', replicaUrl: 'https://demo3.botwarren.com', secretFile: h.secretFile, delaySeconds: 120, opsPort: 4500, projects: [{ id: 'demo3', publicName: 'Kept', repoPaths: [h.repo] }] }));
    expect(await runPair([], h.deps)).toBe(0);
    expect(h.calls[0]!.url).toBe('https://botwarren.com/api/pair/start'); // the apex, derived from demo3.botwarren.com
    expect(h.text()).toMatch(/NEW secret: the old one stops working/);
    expect(readFileSync(h.secretFile, 'utf8')).toBe(SECRET);
    const cfg = loadConfig(h.cfgFile, h.host);
    expect(cfg).toMatchObject({ shipId: 'demo2', replicaUrl: 'https://demo2.botwarren.com', delaySeconds: 120, opsPort: 4500 });
    expect(cfg.projects[0]).toMatchObject({ id: 'demo3', publicName: 'Kept' });
  });

  it('stops cleanly when declined, expired, or never approved, and saves nothing', async () => {
    for (const [polls, msg] of [[[j(403, { error: 'access_denied' })], /declined/], [[j(400, { error: 'expired_token' })], /expired/]] as const) {
      const h = harness({ polls: [...polls] });
      expect(await runPair([], h.deps)).toBe(1);
      expect(h.errs.join('')).toMatch(msg);
      expect(existsSync(h.secretFile)).toBe(false); expect(existsSync(h.cfgFile)).toBe(false);
      expect(h.startAgent).not.toHaveBeenCalled();
    }
    const h = harness({ polls: [j(400, { error: 'authorization_pending' })] });
    expect(await runPair([], h.deps)).toBe(1);
    expect(h.errs.join('')).toMatch(/Nobody approved the code in time/);
    expect(h.now()).toBeGreaterThanOrEqual(Date.parse('2026-10-14T10:10:00Z'));
  });

  it('survives dropped connections and server errors while polling', async () => {
    const h = harness({ polls: [new Error('ECONNRESET'), j(503, { error: 'busy' }), j(502, {}), j(200, PAIRED)] });
    expect(await runPair([], h.deps)).toBe(0);
    expect(readFileSync(h.secretFile, 'utf8')).toBe(SECRET);
  });

  it('start failures give plain messages', async () => {
    for (const [mk, msg] of [[() => j(429, { error: 'rate_limited' }), /Too many pairing attempts/], [() => j(503, { error: 'busy' }), /HTTP 503/], [() => j(200, { nope: true }), /format this version does not understand/]] as const) {
      const h = harness({ start: mk, polls: [] });
      expect(await runPair([], h.deps)).toBe(1);
      expect(h.errs.join('')).toMatch(msg);
    }
    const h = harness({ start: () => { throw new Error('ENOTFOUND'); }, polls: [] });
    expect(await runPair([], h.deps)).toBe(1);
    expect(h.errs.join('')).toMatch(/Could not reach https:\/\/botwarren.com/);
  });

  it('never opens or trusts an address that is not the site\'s own', async () => {
    for (const bad of ['https://evil.example/pair', 'http://botwarren.com/pair', 'https://botwarren.com.evil.example/pair', 'javascript:alert(1)']) {
      const h = harness({ start: () => j(200, { ...START, verification_uri: bad, verification_uri_complete: bad }), polls: [] });
      expect(await runPair([], h.deps)).toBe(1);
      expect(h.opener).not.toHaveBeenCalled();
    }
    // a hijacked answer pointing the agent at another host is refused and nothing is written
    for (const base of ['https://evil.example', 'https://demo1.botwarren.com.evil.example', 'http://demo1.botwarren.com', 'https://demo4.botwarren.com', 'https://demo1.botwarren.com/x?y=1']) {
      const h = harness({ polls: [j(200, { ...PAIRED, base_url: base })] });
      expect(await runPair([], h.deps)).toBe(1);
      expect(h.errs.join('')).toMatch(/does not trust/);
      expect(existsSync(h.secretFile)).toBe(false); expect(existsSync(h.cfgFile)).toBe(false);
    }
    expect(shipUrlOk('https://demo1.botwarren.com', 'demo1', 'https://botwarren.com')).toBe(true);
    expect(shipUrlOk('https://demo1.botwarren.com', 'demo1', 'https://www.botwarren.com')).toBe(true);
    expect(shipUrlOk('http://127.0.0.1:4500', 'demo1', 'http://127.0.0.1:4500')).toBe(true);
  });

  it('flags and the site address are validated', () => {
    expect(parsePairFlags(['--repo', '/a', '--repo', '/b', '--no-open'])).toEqual({ noOpen: true, noStart: false, site: null, repos: ['/a', '/b'], name: null });
    expect(parsePairFlags(['--bogus'])).toMatch(/unknown option/);
    expect(parsePairFlags(['--repo'])).toMatch(/needs a value/);
    expect(siteOrigin(null, {}, null)).toBe('https://botwarren.com');
    expect(siteOrigin('http://127.0.0.1:4500', {}, null)).toBe('http://127.0.0.1:4500');
    expect(siteOrigin('http://botwarren.com', {}, null)).toBeNull();
    expect(siteOrigin('https://user:pw@botwarren.com', {}, null)).toBeNull();
    expect(siteOrigin(null, {}, 'https://demo1.botwarren.com')).toBe('https://botwarren.com');
  });

  it('the old `login` command still works (ship secret file, login-link endpoint)', async () => {
    const { runLogin } = await import('../src/login.ts');
    const outs: string[] = [];
    const code = await runLogin({ replicaUrl: 'https://demo1.botwarren.com', secretFile: '/x' }, ['--no-open'], { readSecret: () => SECRET, fetchImpl: (async () => j(200, { url: 'https://botwarren.com/login#code=abc' })) as unknown as typeof fetch, out: (s) => outs.push(s), err: () => undefined });
    expect(code).toBe(0);
    expect(outs.join('')).toContain('https://botwarren.com/login#code=abc');
  });
});

describe('onboarding delay', () => {
  function target(initial: number) {
    const settings = new Map<string, string>(); let delay = initial; const audit: number[] = [];
    return { settings, get delay() { return delay; }, audit, t: { store: { getSetting: (k: string) => settings.get(k), setSetting: (k: string, v: string) => { settings.set(k, v); } }, setDelay: (s: number) => { delay = s; audit.push(s); } } };
  }
  it('uses the 30 s minimum inside the window and restores the configured delay when it ends, once', () => {
    const x = target(90); const until = 1_000_000;
    expect(applyOnboardingDelay(x.t, { onboardingUntil: until, delaySeconds: 90 }, until - 600_000)).toBe(600_000);
    expect(x.delay).toBe(ONBOARDING_DELAY_SECONDS);
    expect(applyOnboardingDelay(x.t, { onboardingUntil: until, delaySeconds: 90 }, until - 300_000)).toBe(300_000); // restart mid-window: no second change
    expect(x.audit).toEqual([30]);
    expect(applyOnboardingDelay(x.t, { onboardingUntil: until, delaySeconds: 90 }, until + 1)).toBeNull();
    expect(x.delay).toBe(90);
    // the owner picks 120 later: a restart must not touch it
    x.t.setDelay(120);
    expect(applyOnboardingDelay(x.t, { onboardingUntil: until, delaySeconds: 90 }, until + 60_000)).toBeNull();
    expect(x.delay).toBe(120);
  });
  it('does nothing without a window (every existing ship)', () => {
    const x = target(90);
    expect(applyOnboardingDelay(x.t, { onboardingUntil: null, delaySeconds: 90 }, 5)).toBeNull();
    expect(x.audit).toEqual([]);
  });
  it('a restart long after the window restores the configured delay if the short one was left behind', () => {
    const x = target(30); x.settings.set('onboarding_delay', 'on');
    expect(applyOnboardingDelay(x.t, { onboardingUntil: 1000, delaySeconds: 90 }, 999_999)).toBeNull();
    expect(x.delay).toBe(90);
  });
});
