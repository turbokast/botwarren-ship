/** Zero-touch onboarding, agent side: connect with a claim token, project discovery privacy, remote settings validation, disconnect. */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentReport } from '../src/vendor/core/contract.ts';
import { startAgent } from '../src/agent.ts';
import { resolveConfig } from '../src/config.ts';
import { runConnect, wipeConnection, CLAIM_SHAPE } from '../src/connect.ts';
import { ProjectDiscovery, safeDisplayName, nameFromRemote } from '../src/discovery.ts';
import { agentReportUrl, applyAdapterOverrides, shouldWipe } from '../src/cloudlink.ts';
import { loadConfig } from '../src/config.ts';
import { buildAdapters } from '../src/adapters/registry.ts';
import { runUninstall } from '../src/uninstall.ts';
import { DISCONNECTED_NOTE, type PairDeps } from '../src/pair.ts';
import { VERSION } from '../src/version.ts';
import { freePort, tmp, writeSession } from './helpers.ts';

const TOKEN = 'bwc_' + 'Ab3-_'.repeat(9); // 4 + 45 chars
const SECRET = 'PAIRED-SHIP-SECRET-0123456789abcdefghijklmno';
const PAIRED = { ship_id: 'demo1', ship_name: 'Demo One', secret: SECRET, base_url: 'https://demo1.botwarren.com' };
const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function connectHarness(answer: () => Response | Error, over: Partial<PairDeps> = {}, env: Record<string, string | undefined> = { BOTWARREN_CLAIM: TOKEN }) {
  const root = tmp();
  const host = { platform: 'linux' as const, home: root, env: { XDG_CONFIG_HOME: join(root, 'cfg'), XDG_DATA_HOME: join(root, 'data') } };
  const outs: string[] = []; const errs: string[] = [];
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); const r = answer(); if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch;
  const startAgentFn = vi.fn(async (_c: string) => 'started' as const);
  const deps: PairDeps = { fetchImpl, out: (s) => outs.push(s), err: (s) => errs.push(s), host, env: { ...env }, cwd: root, now: () => Date.parse('2026-10-14T10:00:00Z'), startAgent: startAgentFn, agentUp: async () => true, restrictFile: async () => undefined, ...over };
  return { deps, outs, errs, calls, startAgentFn, root, host, text: () => outs.join('') + errs.join(''), cfgFile: posix.join(root, 'cfg', 'botwarren-ship', 'config.json'), secretFile: posix.join(root, 'cfg', 'botwarren-ship', 'ship.secret') };
}

describe('botwarren connect with a claim token', () => {
  it('exchanges it once, saves the secret user-only, writes a zero-project config, starts the agent and never prints the secret or the token', async () => {
    const h = connectHarness(() => j(200, PAIRED));
    expect(await runConnect([], h.deps)).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe('https://botwarren.com/api/claim/exchange');
    // body: the token, the kind of OS and CPU, the agent version. Nothing about this computer.
    expect(JSON.parse(String(h.calls[0]!.init!.body))).toEqual({ token: TOKEN, os: 'linux', arch: expect.stringMatching(/^(x64|arm64|other)$/), agent: VERSION });
    expect(readFileSync(h.secretFile, 'utf8')).toBe(SECRET);
    if (process.platform !== 'win32') expect(statSync(h.secretFile).mode & 0o777).toBe(0o600);
    const cfg = loadConfig(h.cfgFile, h.host);
    expect(cfg).toMatchObject({ shipId: 'demo1', replicaUrl: 'https://demo1.botwarren.com', projects: [] });
    expect(h.startAgentFn).toHaveBeenCalledTimes(1);
    for (const secretish of [SECRET, TOKEN]) { expect(h.text()).not.toContain(secretish); expect(readFileSync(h.cfgFile, 'utf8')).not.toContain(secretish); }
    expect(h.text()).toMatch(/Connected: this computer is now linked to Demo One/);
  });

  it('refuses a cut-off or altered token before any network call', async () => {
    for (const bad of ['bwc_short', 'xyz_' + 'a'.repeat(40), TOKEN + ' extra', 'bwc_' + 'a'.repeat(100)]) {
      const h = connectHarness(() => j(200, PAIRED), {}, { BOTWARREN_CLAIM: bad });
      expect(await runConnect([], h.deps)).toBe(2);
      expect(h.calls).toHaveLength(0);
      expect(h.errs.join('')).toMatch(/cut off or changed/);
      expect(h.text()).not.toContain(bad);
    }
    expect(CLAIM_SHAPE.test(TOKEN)).toBe(true);
  });

  it('says plainly when the command expired or was already used, and saves nothing', async () => {
    const h = connectHarness(() => j(400, { error: 'invalid_or_expired' }));
    expect(await runConnect([], h.deps)).toBe(1);
    expect(h.errs.join('')).toMatch(/expired or was already used/);
    expect(existsSync(h.secretFile)).toBe(false); expect(existsSync(h.cfgFile)).toBe(false);
    expect(h.startAgentFn).not.toHaveBeenCalled();
  });

  it('a network failure does not use the command up and says to run it again', async () => {
    const h = connectHarness(() => new Error('ECONNREFUSED'));
    expect(await runConnect([], h.deps)).toBe(1);
    expect(h.errs.join('')).toMatch(/has not been used up/);
  });

  it('does not trust an answer that points the ship somewhere else', async () => {
    const h = connectHarness(() => j(200, { ...PAIRED, base_url: 'https://evil.example' }));
    expect(await runConnect([], h.deps)).toBe(1);
    expect(existsSync(h.secretFile)).toBe(false);
  });

  it('accepts --claim as well (and still validates it); with no token and an existing connection it exits 3 and changes nothing', async () => {
    const h = connectHarness(() => j(200, PAIRED), {}, {});
    expect(await runConnect(['--claim', TOKEN], h.deps)).toBe(0);
    const again = connectHarness(() => j(200, PAIRED), {}, {});
    mkdirSync(join(again.root, 'cfg', 'botwarren-ship'), { recursive: true });
    writeFileSync(again.secretFile, 'EXISTING-SECRET-0123456789');
    writeFileSync(again.cfgFile, JSON.stringify({ shipId: 'demo3', replicaUrl: 'https://demo3.botwarren.com', secretFile: again.secretFile, projects: [] }));
    expect(await runConnect([], again.deps)).toBe(3);
    expect(again.calls).toHaveLength(0);
    expect(readFileSync(again.secretFile, 'utf8')).toBe('EXISTING-SECRET-0123456789');
  });

  it('a new claim over an existing install keeps the owner\'s own settings and replaces ship and secret', async () => {
    const h = connectHarness(() => j(200, PAIRED));
    mkdirSync(join(h.root, 'cfg', 'botwarren-ship'), { recursive: true });
    writeFileSync(h.secretFile, 'OLD');
    writeFileSync(h.cfgFile, JSON.stringify({ shipId: 'demo3', replicaUrl: 'https://demo3.botwarren.com', secretFile: h.secretFile, delaySeconds: 120, opsPort: 4500, projects: [{ id: 'demo3', repoPaths: [h.root] }] }));
    expect(await runConnect([], h.deps)).toBe(0);
    expect(readFileSync(h.secretFile, 'utf8')).toBe(SECRET);
    expect(loadConfig(h.cfgFile, h.host)).toMatchObject({ shipId: 'demo1', delaySeconds: 120, opsPort: 4500 });
  });
});

describe('disconnect', () => {
  it('wipeConnection removes the secret, parks the config and leaves a note that connecting again clears', async () => {
    const h = connectHarness(() => j(200, PAIRED));
    expect(await runConnect([], h.deps)).toBe(0);
    wipeConnection(h.cfgFile, h.secretFile, 'revoked by the website', new Date('2026-10-14T11:00:00Z'));
    expect(existsSync(h.secretFile)).toBe(false);
    expect(existsSync(h.cfgFile)).toBe(false);
    expect(existsSync(join(h.root, 'cfg', 'botwarren-ship', 'config.disconnected.json'))).toBe(true);
    expect(readFileSync(join(h.root, 'cfg', 'botwarren-ship', DISCONNECTED_NOTE), 'utf8')).toMatch(/revoked by the website/);
    const again = connectHarness(() => j(200, PAIRED));
    void again;
    expect(await runConnect([], { ...h.deps, fetchImpl: (async () => j(200, PAIRED)) as unknown as typeof fetch })).toBe(0); // connecting again works
    expect(existsSync(join(h.root, 'cfg', 'botwarren-ship', DISCONNECTED_NOTE))).toBe(false);
  });

  it('only SUSTAINED refusals count as a revoke', () => {
    expect(shouldWipe({ count: 0, since: null }, 1e9)).toBe(false);
    expect(shouldWipe({ count: 2, since: 0 }, 10 * 60_000)).toBe(false); // too few
    expect(shouldWipe({ count: 5, since: 0 }, 60_000)).toBe(false); // too recent
    expect(shouldWipe({ count: 3, since: 0 }, 5 * 60_000)).toBe(true);
  });

  it('uninstall tells the website (bye), then runs the installed script with the right flags per OS', async () => {
    const root = tmp();
    const host = { platform: 'linux' as const, home: root, env: {} };
    const cfgDir = join(root, 'cfg', 'botwarren-ship'); mkdirSync(cfgDir, { recursive: true });
    const secretFile = join(cfgDir, 'ship.secret'); writeFileSync(secretFile, 'SHIP-SECRET-0123456789abcdef');
    const cfgFile = join(cfgDir, 'config.json'); writeFileSync(cfgFile, JSON.stringify({ shipId: 'demo1', replicaUrl: 'https://demo1.botwarren.com', secretFile, projects: [] }));
    const home = join(root, 'install'); mkdirSync(home); writeFileSync(join(home, 'uninstall.sh'), '#!/bin/sh\n');
    const posted: { url: string; body: unknown; auth: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => { posted.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) }); return j(200, { ok: true }); }) as unknown as typeof fetch;
    const runScript = vi.fn(async () => 0);
    const out: string[] = [];
    expect(await runUninstall(['--yes', '--keep-config'], { host, env: { BOTWARREN_HOME: home, BOTWARREN_SHIP_CONFIG: cfgFile }, fetchImpl, runScript, out: (s) => out.push(s) })).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe('https://demo1.botwarren.com/internal/agent');
    expect(AgentReport.safeParse(posted[0]!.body).success).toBe(true);
    expect((posted[0]!.body as { bye: boolean }).bye).toBe(true);
    expect(runScript).toHaveBeenCalledWith(join(home, 'uninstall.sh'), ['--yes', '--keep-config'], host);
    // Windows spells the flags its own way
    writeFileSync(join(home, 'uninstall.ps1'), '');
    const winRun = vi.fn(async (_f: string, _a: string[], _h: unknown) => 0);
    await runUninstall(['--yes', '--keep-config', '--no-cloud'], { host: { ...host, platform: 'win32' }, env: { BOTWARREN_HOME: home }, runScript: winRun, out: () => undefined });
    expect(winRun.mock.calls[0]![1]).toEqual(['-Yes', '-KeepConfig']);
    expect(await runUninstall(['--bogus'], { host, env: { BOTWARREN_HOME: home }, runScript, err: () => undefined })).toBe(2);
  });
});

describe('project discovery privacy', () => {
  const CANARY_USER = 'canary-user-9f3a';
  const CANARY_DIR = 'SecretClientCorp-portal';
  const setup = (over: Partial<ConstructorParameters<typeof ProjectDiscovery>[0]> = {}) => {
    const home = tmp();
    const repo = join(home, 'work', CANARY_USER, CANARY_DIR);
    mkdirSync(join(repo, '.git'), { recursive: true }); mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    const file = join(tmp(), 'private', 'discovery.json');
    const d = new ProjectDiscovery({ file, home, gitRemote: async () => null, ...over });
    return { home, repo, file, d };
  };

  it('reports only an opaque key and a display name; a local path is in the report nowhere', async () => {
    const { repo, d, home } = setup();
    const p = await d.note(join(repo, 'src', 'deep'));
    expect(p).not.toBeNull();
    const report = d.report();
    expect(report).toHaveLength(1);
    expect(report[0]!.id).toMatch(/^p-[a-f0-9]{8}$/);
    expect(report[0]!.name).toBe('SecretClientCorp portal'); // the folder's own name, tidied (already mixed case, so kept) is the allowed display name
    const blob = JSON.stringify(AgentReport.parse({ v: 1, os: 'linux', arch: 'x64', adapters: [], projects: report }));
    for (const leak of [home, CANARY_USER, 'work', '/', '\\', 'src', 'deep']) expect(blob).not.toContain(leak);
  });

  it('the repository name from the git remote wins over the folder, and the remote itself (host, owner) is not reported', async () => {
    const { repo, d } = setup({ gitRemote: async () => 'github.com/acme-corp-private/dragon-game' });
    await d.note(repo);
    const blob = JSON.stringify(d.report());
    expect(d.report()[0]!.name).toBe('Dragon Game');
    for (const leak of ['acme-corp-private', 'github.com', CANARY_DIR]) expect(blob).not.toContain(leak);
  });

  it('with names switched off only "Project N" is reported', async () => {
    const { repo, d } = setup({ sendNames: false });
    await d.note(repo);
    expect(d.report()[0]!.name).toBe('Project 1');
  });

  it('the same repository in a second folder (worktree) is one project; the key is stable across restarts and differs per install', async () => {
    const a = setup({ gitRemote: async () => 'github.com/o/r' });
    const second = join(a.home, 'elsewhere', 'r-copy'); mkdirSync(join(second, '.git'), { recursive: true });
    const p1 = await a.d.note(a.repo); const p2 = await a.d.note(second);
    expect(p2!.id).toBe(p1!.id);
    expect(a.d.list()).toHaveLength(1);
    a.d.flush();
    const again = new ProjectDiscovery({ file: a.file, home: a.home, gitRemote: async () => 'github.com/o/r' });
    expect(again.list()[0]!.id).toBe(p1!.id);
    const other = setup({ gitRemote: async () => 'github.com/o/r' });
    expect((await other.d.note(other.repo))!.id).not.toBe(p1!.id); // per-install salt: keys cannot be compared across computers
  });

  it('only a git checkout is a project: not the home folder, not a plain folder, not a dotfiles repo in $HOME', async () => {
    const home = tmp(); mkdirSync(join(home, '.git'));
    const plain = join(home, 'Documents', 'notes'); mkdirSync(plain, { recursive: true });
    const d = new ProjectDiscovery({ file: join(tmp(), 'd.json'), home, gitRemote: async () => null });
    expect(await d.note(home)).toBeNull();
    expect(await d.note(plain)).toBeNull();
    expect(await d.note(null)).toBeNull();
    expect(await d.note('relative/path')).toBeNull();
    expect(d.list()).toHaveLength(0);
  });

  it('keeps the local path only in a user-only file, and the cloud can only choose among keys it discovered', async () => {
    const { repo, d, file } = setup();
    const p = (await d.note(repo))!;
    d.flush();
    expect(readFileSync(file, 'utf8')).toContain(CANARY_USER); // local only: it is how sessions are attributed
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(d.applyChoices([{ id: 'p-deadbeef', show: true }])).toBe(false); // not discovered here: ignored
    expect(d.shown()).toHaveLength(0);
    expect(d.applyChoices([{ id: p.id, show: true, name: 'Dragon Game' }])).toBe(true);
    expect(d.shown()[0]).toMatchObject({ id: p.id, publicName: 'Dragon Game' });
    expect(d.applyChoices([{ id: p.id, show: true, name: 'Dragon Game' }])).toBe(false); // idempotent
  });

  it('turns awkward names into safe public display text', () => {
    expect(safeDisplayName('my_repo!!<b>x</b>')).toBe('my repo b x b');
    expect(safeDisplayName('日本語')).toBe('Project');
    expect(safeDisplayName('x'.repeat(100))).toHaveLength(40);
    expect(nameFromRemote('gitlab.com/group/sub/my-cool_game')).toBe('My Cool Game');
  });
});

describe('the agent end to end (zero config)', () => {
  async function boot(over: { revoke?: boolean } = {}) {
    const root = tmp(); const data = tmp(); const logs = tmp();
    const repo = join(root, 'work', 'canary-user-9f3a', 'DragonGame'); mkdirSync(join(repo, '.git'), { recursive: true });
    const secretFile = join(data, 'ship.secret'); writeFileSync(secretFile, 'x'.repeat(40));
    const port = await freePort();
    const cfg = resolveConfig({ shipId: 'demo1', replicaUrl: 'https://demo1.botwarren.com', secretFile, opsPort: port, dataDir: data, harnessLogDirs: [logs], codexLogDirs: [], adapters: { herdr: { enabled: false }, ninox: { enabled: false }, opencode: { enabled: false }, 'gemini-cli': { enabled: false } } }); // hermetic: nothing from this machine's real tools
    writeSession(logs, 'p', 'live-1', repo, new Date());
    let settings: Record<string, unknown> = { showRealNames: false };
    const posts: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      posts.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (over.revoke) return j(401, { error: 'unauthorized' });
      if (u.endsWith('/internal/agent')) return j(200, { ok: true });
      return j(200, { maxSeq: 0, settings });
    }) as unknown as typeof fetch;
    const lines: string[] = []; const revoked = vi.fn();
    const agent = await startAgent(cfg, { log: (m) => lines.push(m), fetchImpl, replicate: false, onRevoked: revoked, housekeepingMs: 200, revokeAfterCount: 1, revokeAfterMs: 0 });
    return { agent, cfg, repo, root, posts, lines, revoked, set: (s: Record<string, unknown>) => { settings = s; }, tick: () => agent.replicator.tick() };
  }
  const manifestProjects = (a: Awaited<ReturnType<typeof boot>>) => a.agent.svc.manifest().projects;

  it('notices a project, reports it to the owner only (no path), shows it only when chosen, then hides it again', async () => {
    const t = await boot();
    try {
      await t.tick();
      await vi.waitFor(() => expect(t.agent.discovery.list()).toHaveLength(1), { timeout: 8000 });
      const key = t.agent.discovery.list()[0]!.id;
      // nothing is public yet: one placeholder building, nothing allowlisted
      expect(manifestProjects(t)).toEqual([{ id: 'demo1', name: 'DEMO1 Project', building: 'Workshop' }]);
      expect(t.agent.svc.cfg.publicProjects).toEqual([]);

      // the owner-only report: key + display name; the path and the user folder appear nowhere in anything the agent sent
      await vi.waitFor(() => expect(t.posts.some((p) => p.url.endsWith('/internal/agent'))).toBe(true), { timeout: 8000 });
      const rep = t.posts.find((p) => p.url.endsWith('/internal/agent') && (p.body as { projects: unknown[] }).projects.length > 0)!;
      expect(AgentReport.safeParse(rep.body).success).toBe(true);
      expect((rep.body as { projects: { id: string; name: string }[] }).projects).toEqual([{ id: key, name: 'DragonGame' }]);
      expect(rep.url).toBe('https://demo1.botwarren.com/internal/agent');
      for (const sent of t.posts) {
        const blob = JSON.stringify(sent.body);
        for (const leak of [t.root, 'canary-user-9f3a', 'live-1']) expect(blob, sent.url).not.toContain(leak);
      }

      // the owner shows it (real names off): public name is generic, the project is now allowlisted
      t.set({ showRealNames: false, projects: [{ id: key, show: true, name: 'Dragon Game' }] });
      await t.tick();
      expect(manifestProjects(t)).toEqual([{ id: 'demo1'.replace('demo1', key), name: 'DEMO1 Project', building: 'Workshop' }]);
      expect(t.agent.svc.cfg.publicProjects).toEqual([key]);
      // the session in that folder now belongs to the project
      await vi.waitFor(() => expect(Object.values(t.agent.svc.world.sessions).some((s) => s.projectId === key)).toBe(true), { timeout: 8000 });
      // real names on: the owner's chosen name
      t.set({ showRealNames: true, projects: [{ id: key, show: true, name: 'Dragon Game' }] });
      await t.tick();
      expect(manifestProjects(t)[0]!.name).toBe('Dragon Game');
      // hidden again
      t.set({ showRealNames: true, projects: [{ id: key, show: false }] });
      await t.tick();
      expect(t.agent.svc.cfg.publicProjects).toEqual([]);
      expect(manifestProjects(t)).toEqual([{ id: 'demo1', name: 'DEMO1 Project', building: 'Workshop' }]);
    } finally { await t.agent.stop(); }
  });

  it('validates and clamps what the website sends: unknown keys, junk, delay, tools', async () => {
    const t = await boot();
    try {
      await t.tick();
      await vi.waitFor(() => expect(t.agent.discovery.list()).toHaveLength(1), { timeout: 8000 });
      for (const junk of [{ id: 'p-deadbeef', show: true, name: 'Intruder' }, { id: '/etc/passwd', show: true }, { id: 'p-0a0a0a0a', show: 'yes' }, 'nonsense', null, 42]) {
        t.set({ showRealNames: true, projects: Array.isArray(junk) ? junk : [junk] });
        await t.tick();
        expect(t.agent.svc.cfg.publicProjects).toEqual([]);
      }
      t.set({ showRealNames: false, projects: 'not-a-list' }); await t.tick();
      expect(t.agent.svc.cfg.publicProjects).toEqual([]);
      // delay is clamped to 30..120, applied once per change
      t.set({ showRealNames: false, delaySeconds: 5 }); await t.tick();
      expect(t.agent.svc.delaySeconds).toBe(30);
      t.set({ showRealNames: false, delaySeconds: 99999 }); await t.tick();
      expect(t.agent.svc.delaySeconds).toBe(120);
      t.set({ showRealNames: false, delaySeconds: 'fast' }); await t.tick();
      expect(t.agent.svc.delaySeconds).toBe(120);
      // tools: only known ids, only off-switches
      t.set({ showRealNames: false, adapters: { 'claude-code': false, evil: false, codex: true } }); await t.tick();
      expect(t.lines.join('\n')).toMatch(/tools switched off from the website: claude-code/);
    } finally { await t.agent.stop(); }
  });

  it('notices a revoked secret (sustained 401s) and tells the caller, without publishing anything', async () => {
    const t = await boot({ revoke: true });
    try {
      await t.tick();
      expect(t.agent.replicator.unauthorized.count).toBeGreaterThan(0);
      await vi.waitFor(() => expect(t.revoked).toHaveBeenCalledTimes(1), { timeout: 5000 });
      expect(t.lines.join('\n')).toMatch(/no longer accepts this computer/);
      expect(t.posts.every((p) => !p.url.endsWith('/internal/agent'))).toBe(true); // no owner report goes out before the website has accepted a publish
    } finally { await t.agent.stop(); }
  });
});

describe('cloud tool overrides', () => {
  it('can switch tools off and back to the configured setting, but never on', () => {
    const entries = buildAdapters({ harnessLogDirs: [], codexLogDirs: [] }, { platform: 'linux', home: tmp(), env: {} });
    const before = entries.map((e) => e.settings.enabled);
    const saved = new Map();
    expect(applyAdapterOverrides(entries, ['codex', 'herdr'], saved)).toBe(true);
    expect(entries.filter((e) => e.settings.enabled === false).map((e) => e.adapter.manifest.id).sort()).toEqual(['codex', 'herdr']);
    expect(applyAdapterOverrides(entries, ['codex', 'herdr'], saved)).toBe(false);
    expect(applyAdapterOverrides(entries, [], saved)).toBe(true);
    expect(entries.map((e) => e.settings.enabled)).toEqual(before);
    // a tool the local config disabled stays disabled when the website says "on"
    entries[0]!.settings.enabled = false;
    expect(applyAdapterOverrides(entries, [], saved)).toBe(false);
    expect(entries[0]!.settings.enabled).toBe(false);
  });

  it('builds the report address from the publish URL', () => {
    expect(agentReportUrl('https://demo1.botwarren.com')).toBe('https://demo1.botwarren.com/internal/agent');
    expect(agentReportUrl('https://demo1.botwarren.com/internal/publish?x=1')).toBe('https://demo1.botwarren.com/internal/agent');
  });
});
