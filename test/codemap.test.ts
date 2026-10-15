/**
 * Code map (opt-in): local derivation, truthful visits, and the privacy canaries. A planted FOLDER canary and FILE canary must never appear in
 * any event, public projection, outbox draft, log line or state file, with Code map on or off; with it off nothing reads a path at all.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PublicEvent, type CanonicalEventInput } from '../src/vendor/core/contract.ts';
import { CodeMapService, runGit, type GitRun } from '../src/readers/codemap.ts';
import { ClaudeLogTail } from '../src/readers/sessionlog.ts';
import { SessionScanner } from '../src/sessionscan.ts';
import { ProjectAttributor } from '../src/attribution.ts';
import { PrivateService } from '../src/local/service.ts';
import { PublicStoreReader } from '../src/local/stores.ts';
import { startAgent } from '../src/agent.ts';
import { resolveConfig } from '../src/config.ts';
import { dataPaths } from '../src/paths.ts';
import { freePort, line, tmp, writeSession } from './helpers.ts';

const FOLDER = 'CANARY_FOLDER_7c41e9aa';
const FILE = 'CANARY_FILE_3d2b6f10.ts';
const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const DAY = 86_400_000;

/** a real git repository whose areas were last changed at known times (committer and author dates are set per commit) */
function makeRepo(): string {
  const repo = tmp();
  const git = (args: string[], at?: number) => execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...(at ? { GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() } : {}) } });
  git(['init', '-q', '-b', 'main']);
  const put = (rel: string, n: number) => { mkdirSync(join(repo, rel), { recursive: true }); for (let i = 0; i < n; i++) writeFileSync(join(repo, rel, i === 0 ? FILE : `f${i}.ts`), `export const x${i} = 1;\n`); };
  put('server', 6); put('web', 6); put(FOLDER, 4); put('docs', 3); put('tests', 3);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'old'], NOW - 400 * DAY);       // everything is over a year old ...
  writeFileSync(join(repo, 'server', 'f1.ts'), 'export const x1 = 2;\n');
  git(['add', '-A']); git(['commit', '-q', '-m', 'recent'], NOW - 2 * DAY); // ... except the server
  return repo;
}

const svcFor = (repo: string, opts: { on?: () => boolean; git?: GitRun; stateFile?: string; now?: () => number } = {}) => {
  const logs: string[] = [];
  const stateFile = opts.stateFile ?? join(tmp(), 'private', 'codemap.json');
  const svc = new CodeMapService({ stateFile, projects: () => [{ id: 'alpha', repoPaths: [repo] }], enabled: opts.on ?? (() => true), instance: 'inst', now: opts.now ?? (() => NOW), ...(opts.git ? { git: opts.git } : {}), log: (m) => logs.push(m) });
  return { svc, logs, stateFile };
};

describe('Code map service (local derivation)', () => {
  it('derives opaque areas with kinds and staleness from real git history, and sends no name, path or count', async () => {
    const repo = makeRepo();
    const { svc, logs, stateFile } = svcFor(repo);
    const events = await svc.refresh();
    expect(events).toHaveLength(1);
    const ev = events[0] as Extract<CanonicalEventInput, { type: 'project.areas' }>;
    expect(ev.areas.length).toBe(5);
    const byKind = Object.fromEntries(ev.areas.map((a) => [a.kind, a]));
    expect(byKind.server!.stale).toBe('week'); // 2 days ago
    expect(byKind.docs!.stale).toBe('long');
    expect(byKind.tests!.stale).toBe('long');
    expect([...new Set(ev.areas.map((a) => a.i))].length).toBe(5);
    // the whole event: indices, closed enums, nothing else
    expect(Object.keys(ev.areas[0]!).sort()).toEqual(['i', 'kind', 'stale']);
    const blob = JSON.stringify(events) + logs.join('\n') + readFileSync(stateFile, 'utf8');
    for (const secret of [FOLDER, FILE, repo, 'f1.ts', 'CANARY']) expect(blob).not.toContain(secret);
    // names are available only to the owner's local listing
    expect(JSON.stringify(svc.local())).toContain(FOLDER);
  });

  it('keeps its indices across a restart and unseen areas get the lowest free index in a salted (name-blind) order', async () => {
    const repo = makeRepo();
    const a = svcFor(repo);
    const first = (await a.svc.refresh())[0] as Extract<CanonicalEventInput, { type: 'project.areas' }>;
    a.svc.clear(); // the owner turns it off (state kept) ...
    const again = svcFor(repo, { stateFile: a.stateFile });
    const second = (await again.svc.refresh())[0] as Extract<CanonicalEventInput, { type: 'project.areas' }>;
    expect(second.areas).toEqual(first.areas); // ... and on again: same ids
    // another install (another salt) hands the numbers out in another order, so the order says nothing about names
    const orders = new Set<string>();
    for (let k = 0; k < 6; k++) {
      const other = svcFor(repo);
      const ev = (await other.svc.refresh())[0] as Extract<CanonicalEventInput, { type: 'project.areas' }>;
      orders.add(ev.areas.map((x) => x.kind).join(','));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('OFF means off: no git, no path is resolved, nothing is kept, no event', async () => {
    const repo = makeRepo();
    let calls = 0;
    let on = true;
    const { svc } = svcFor(repo, { on: () => on, git: async (c, a, t) => { calls++; return runGit(c, a, t); } });
    await svc.refresh();
    expect(svc.areaOf('alpha', repo, join(repo, 'server', FILE), false)).not.toBeNull();
    on = false;
    const before = calls;
    expect(await svc.refresh()).toEqual([]);
    expect(calls).toBe(before);
    expect(svc.areaOf('alpha', repo, join(repo, 'server', FILE), true)).toBeNull();
    expect(svc.local()).toEqual([]);
    expect(svc.status()).toEqual({ on: false, projects: 0, areas: 0 });
  });

  it('resolves absolute, relative and worktree paths; paths outside the repository map to nothing; an edit makes its area fresh', async () => {
    const repo = makeRepo();
    let t = NOW;
    const { svc } = svcFor(repo, { now: () => t });
    const first = (await svc.refresh())[0] as Extract<CanonicalEventInput, { type: 'project.areas' }>;
    const docs = svc.areaOf('alpha', repo, join(repo, 'docs', FILE), false)!;
    expect(docs).toBe(first.areas.find((a) => a.kind === 'docs')!.i);
    expect(svc.areaOf('alpha', join(repo, 'docs'), FILE, false)).toBe(docs); // relative to a cwd inside the repo
    expect(svc.areaOf('alpha', repo, '/etc/passwd', false)).toBeNull();
    expect(svc.areaOf('alpha', repo, '../outside.ts', false)).toBeNull();
    expect(svc.areaOf('alpha', null, 'x\0y', false)).toBeNull();
    expect(svc.areaOf('other-project', repo, join(repo, 'docs', FILE), false)).toBeNull();
    // reading does not change anything; an edit makes the area 'today'
    t += 60_000;
    expect(await svc.refresh()).toEqual([]);
    svc.areaOf('alpha', repo, join(repo, 'docs', FILE), true);
    const next = (await svc.refresh())[0] as Extract<CanonicalEventInput, { type: 'project.areas' }>;
    expect(next.areas.find((a) => a.i === docs)!.stale).toBe('today');
  });
});

const toolUse = (name: string, input: Record<string, unknown>, ts: number, id = `tu${ts}`) => line({ type: 'assistant', timestamp: new Date(ts).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'working' }, { type: 'tool_use', id, name, input }] } });

describe('Code map in the session log reader (visits only from real tool calls)', () => {
  it('emits area events for file tools after the first sight, never replays history, and never carries the path', () => {
    const root = tmp();
    const f = writeSession(root, 'p', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '/work/x', new Date(NOW), toolUse('Read', { file_path: `/work/x/old/${FILE}` }, NOW - 5000));
    const tail = new ClaudeLogTail(root);
    const seen: { raw: string; edit: boolean }[] = [];
    const probe = (raw: string, edit: boolean) => { seen.push({ raw, edit }); return raw.includes('/web') ? 2 : 1; };
    const now = new Date(NOW);
    expect(tail.pollPath('claude:a', f, 'inst', now, probe)).toEqual([]); // first sight starts at the end: history is never replayed
    expect(seen).toEqual([]);
    appendFileSync(f, toolUse('Read', { file_path: `/work/x/server/${FILE}` }, NOW + 1000) + toolUse('Edit', { file_path: `/work/x/server/${FILE}`, old_string: 'secret body', new_string: 'x' }, NOW + 2000)
      + toolUse('Grep', { pattern: 'needle', path: '/work/x/web' }, NOW + 3000) + toolUse('Bash', { command: `cat /work/x/server/${FILE}` }, NOW + 4000) + toolUse('Read', { file_path: `/work/x/server/${FILE}` }, NOW + 5000));
    const evs = tail.pollPath('claude:a', f, 'inst', new Date(NOW + 6000), probe).filter((e) => e.type === 'session.activity' && e.kind === 'area') as Extract<CanonicalEventInput, { type: 'session.activity' }>[];
    // Read server (1), Edit server (same area within 30 s: no repeat event), Grep web (2), Bash is never probed, Read server (1)
    expect(evs.map((e) => e.area)).toEqual([1, 2, 1]);
    expect(evs.map((e) => e.areaAct)).toEqual(['read', 'read', 'read']);
    expect(seen.map((s) => s.edit)).toEqual([false, true, false, false]);
    expect(JSON.stringify(evs)).not.toMatch(/work|server|secret body|needle|CANARY/);
  });

  it('without a probe (Code map off) no path is looked at and no area event exists', () => {
    const root = tmp();
    const f = writeSession(root, 'p', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '/work/x', new Date(NOW), toolUse('Read', { file_path: '/a/b.ts' }, NOW - 5000));
    const tail = new ClaudeLogTail(root);
    tail.pollPath('claude:a', f, 'inst', new Date(NOW));
    appendFileSync(f, toolUse('Edit', { file_path: `/work/x/server/${FILE}` }, NOW + 1000));
    const evs = tail.pollPath('claude:a', f, 'inst', new Date(NOW + 2000));
    expect(evs.filter((e) => e.type === 'session.activity' && e.kind === 'area')).toEqual([]);
  });
});

describe('Code map end to end: scanner -> private service -> public outbox', () => {
  async function run(codeMap: boolean) {
    const repo = makeRepo(); const logsRoot = tmp(); const data = tmp();
    let clock = NOW;
    const svc = new PrivateService({ privateDbPath: join(data, 'p.db'), publicDbPath: join(data, 'pub.db'), ingestToken: 'i', opsToken: 'o', delaySeconds: 30, demoMode: false, publicProjects: ['alpha'], shipManifest: { name: 'Test Ship', projects: [{ id: 'alpha', name: 'Alpha' }] }, now: () => new Date(clock) });
    svc.setCodeMap(codeMap);
    const projects = [{ id: 'alpha', repoPaths: [repo] }];
    const map = svcFor(repo, { on: () => codeMap, now: () => clock });
    const scanner = new SessionScanner({ dirs: [logsRoot], instance: 'inst', attributor: new ProjectAttributor(projects, async () => null), codemap: { on: () => codeMap, areaOf: (p, c, r, e) => map.svc.areaOf(p, c, r, e) } });
    const f = writeSession(logsRoot, 'p', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', repo, new Date(clock), line({ type: 'user', cwd: repo, timestamp: new Date(clock - 9000).toISOString(), message: { role: 'user', content: 'hi' } }));
    svc.ingest(await map.svc.refresh());
    svc.ingest(await scanner.tick(new Date(clock)));
    clock += 3000;
    appendFileSync(f, line({ cwd: repo, type: 'assistant', timestamp: new Date(clock - 500).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: join(repo, 'docs', FILE), old_string: 'a', new_string: 'b' } }] } }));
    utimesSync(f, new Date(clock), new Date(clock));
    svc.ingest(await scanner.tick(new Date(clock)));
    clock += 31_000; svc.publishDue();
    const events = new PublicStoreReader(join(data, 'pub.db')).after(0);
    const outbox = JSON.stringify((svc.opsState() as { outbox: unknown[] }).outbox);
    return { events, svc, repo, outbox, logs: map.logs, state: map.stateFile, data };
  }

  it('ON: the crew member visits an area and the room shows its areas; the public events validate and hold no path or name', async () => {
    const r = await run(true);
    const kinds = r.events.map((e) => e.kind);
    expect(kinds).toContain('areas');
    expect(kinds).toContain('area');
    const visit = r.events.find((e) => e.kind === 'area') as Extract<(typeof r.events)[number], { kind: 'area' }>;
    expect(visit).toMatchObject({ project: 'alpha', act: 'edit', certainty: 'observed' });
    for (const e of r.events) expect(PublicEvent.safeParse(e).success).toBe(true);
    const blob = JSON.stringify(r.events) + r.outbox + r.logs.join('\n') + readFileSync(r.state, 'utf8');
    for (const secret of [FOLDER, FILE, r.repo, 'old_string', 'CANARY']) expect(blob).not.toContain(secret);
    r.svc.stop();
  });

  it('OFF: no area event of any kind exists, and still no canary anywhere', async () => {
    const r = await run(false);
    expect(r.events.map((e) => e.kind).filter((k) => k === 'area' || k === 'areas')).toEqual([]);
    const blob = JSON.stringify(r.events) + r.outbox + r.logs.join('\n');
    for (const secret of [FOLDER, FILE, r.repo]) expect(blob).not.toContain(secret);
    r.svc.stop();
  });

  it('turning it off drops the area events still waiting to be published', async () => {
    const r = await run(true);
    r.svc.setCodeMap(false);
    expect((r.svc.opsState() as { outbox: { kind: string }[] }).outbox.filter((o) => o.kind === 'area' || o.kind === 'areas')).toEqual([]);
    r.svc.stop();
  });
});

describe('startAgent with Code map', () => {
  async function agentRun(codeMap: 'on' | 'off' | 'website') {
    const repo = makeRepo(); const data = tmp(); const logs = tmp();
    const secretFile = join(data, 'ship.secret'); writeFileSync(secretFile, 'x'.repeat(40));
    const port = await freePort();
    const cfg = resolveConfig({ shipId: 'demo1', replicaUrl: 'https://demo1.botwarren.com', secretFile, opsPort: port, dataDir: data, harnessLogDirs: [logs], codeMap, projects: [{ id: 'demo1', repoPaths: [repo] }] });
    const f = writeSession(logs, 'p', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', repo, new Date(), line({ type: 'user', cwd: repo, message: { role: 'user', content: 'hi' } }));
    const lines: string[] = [];
    const agent = await startAgent(cfg, { log: (m) => lines.push(m), replicate: false });
    const token = readFileSync(dataPaths(data).opsToken, 'utf8').trim();
    const get = async (route: string) => (await (await fetch(`http://127.0.0.1:${port}/ops/api/${route}`, { headers: { authorization: `Bearer ${token}` } })).json()) as Record<string, unknown>;
    try {
      await new Promise((r) => setTimeout(r, codeMap === 'on' ? 2500 : 800)); // first scan + first map
      appendFileSync(f, line({ cwd: repo, type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Edit', input: { file_path: join(repo, 'web', FILE), old_string: 'a', new_string: 'b' } }] } }));
      utimesSync(f, new Date(), new Date());
      await new Promise((r) => setTimeout(r, 4500)); // next 3 s scan
      const state = await get('state'); const map = await get('codemap');
      return { state, map, lines, repo, data };
    } finally { await agent.stop(); }
  }

  it('on: the owner sees the local listing; outbox drafts are enums; log and state hold no names', async () => {
    const r = await agentRun('on');
    expect((r.map as { on: boolean }).on).toBe(true);
    expect(JSON.stringify(r.map)).toContain(FOLDER); // local, token-protected ops room only
    const drafts = (r.state as { outbox: { kind: string; draft: unknown }[] }).outbox;
    expect(drafts.some((d) => d.kind === 'areas')).toBe(true);
    expect(drafts.some((d) => d.kind === 'area')).toBe(true);
    const blob = JSON.stringify(drafts) + r.lines.join('\n') + readFileSync(join(r.data, 'private', 'codemap.json'), 'utf8');
    for (const secret of [FOLDER, FILE, r.repo]) expect(blob).not.toContain(secret);
  }, 30_000);

  it('default (website switch not on) and off: nothing is mapped, nothing is read, and the ops listing says so', async () => {
    for (const mode of ['website', 'off'] as const) {
      const r = await agentRun(mode);
      expect((r.map as { on: boolean; projects: unknown[] }).on).toBe(false);
      expect((r.map as { projects: unknown[] }).projects).toEqual([]);
      const drafts = (r.state as { outbox: { kind: string }[] }).outbox;
      expect(drafts.filter((d) => d.kind === 'area' || d.kind === 'areas')).toEqual([]);
      const blob = JSON.stringify(r.state) .replace(/"cwd":"[^"]*"/g, '"cwd":"-"') + r.lines.join('\n');
      for (const secret of [FOLDER, FILE]) expect(blob).not.toContain(secret);
    }
  }, 40_000);
});
