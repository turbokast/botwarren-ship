import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PrivateService } from '../src/local/service.ts';
import { PublicStoreReader } from '../src/local/stores.ts';
import { ProjectAttributor } from '../src/attribution.ts';
import { SessionScanner } from '../src/sessionscan.ts';
import { CodexScanner } from '../src/codex.ts';
import { startAgent } from '../src/agent.ts';
import { resolveConfig } from '../src/config.ts';
import { dataPaths } from '../src/paths.ts';
import { makePoster, runWrapped } from '../src/runner.ts';
import { SECRET_CODE, SECRET_INSTRUCTIONS, SECRET_PROMPT, SECRET_TOKEN, tmp, turnContext, writeCodex, writeSession, writeSub, freePort } from './helpers.ts';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

const WIN_CWD = 'C:\\Users\\DEMO1\\Code\\Game';
const T0 = new Date('2026-10-13T12:00:00.000Z');

describe('ship agent end to end (private -> delayed public)', () => {
  it('publishes only attributed sessions, after the delay, enum-only and without private data', async () => {
    const root = tmp(); const data = tmp();
    let clock = T0.getTime();
    const svc = new PrivateService({ privateDbPath: join(data, 'p.db'), publicDbPath: join(data, 'pub.db'), ingestToken: 'i', opsToken: 'o', delaySeconds: 90, demoMode: false, publicProjects: ['alpha'], shipManifest: { name: 'Test Ship', projects: [{ id: 'alpha', name: 'Alpha' }] }, now: () => new Date(clock) });
    const scanner = new SessionScanner({ dirs: [root], instance: 'inst', attributor: new ProjectAttributor([{ id: 'alpha', repoPaths: [WIN_CWD] }], async () => null) });
    writeSession(root, 'p', 'attributed-1', WIN_CWD, new Date(clock - 3000));
    writeSession(root, 'p', 'stranger-1', 'C:\\Users\\DEMO1\\Documents\\private-notes', new Date(clock - 3000));

    const r = svc.ingest(await scanner.tick(new Date(clock)));
    expect(r).toMatchObject({ accepted: 2, quarantined: 0 });
    expect(svc.world.sessions['claude:stranger-1']!.projectId).toBeNull();

    clock += 30_000; expect(svc.publishDue()).toBe(0); // not before the delay
    clock += 61_000; svc.publishDue();

    const events = new PublicStoreReader(join(data, 'pub.db')).after(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'worker', project: 'alpha', harness: 'claude', certainty: 'inferred' });
    const blob = JSON.stringify(events);
    for (const s of [SECRET_PROMPT, SECRET_TOKEN, SECRET_CODE, 'Users', 'DEMO1', 'private-notes', 'attributed-1', 'stranger']) expect(blob).not.toContain(s);
    svc.stop();
  });

  it('wrapper pipeline events pass core validation and publish as local/integration', async () => {
    const data = tmp();
    let clock = T0.getTime();
    const svc = new PrivateService({ privateDbPath: join(data, 'p.db'), publicDbPath: join(data, 'pub.db'), ingestToken: 'i', opsToken: 'o', delaySeconds: 30, demoMode: false, publicProjects: ['alpha'], shipManifest: { name: 'Test Ship', projects: [{ id: 'alpha', name: 'Alpha' }] }, now: () => new Date(clock) });
    const spawnImpl = () => { const ee = new EventEmitter(); setImmediate(() => ee.emit('close', 1, null)); return ee as unknown as ChildProcess; };
    const code = await runWrapped({ argv: ['ninja'], release: true, projectId: 'alpha', instance: 'inst', post: async (e) => { expect(svc.ingest(e).quarantined).toBe(0); return true; }, spawnImpl, now: () => new Date((clock += 1000)), env: { PATH: '' } });
    expect(code).toBe(1);
    clock += 31_000; svc.publishDue();
    const ev = new PublicStoreReader(join(data, 'pub.db')).after(0);
    expect(ev.some((e) => e.kind === 'pipeline' && e.provider === 'local' && e.purpose === 'deploy' && e.status === 'failed')).toBe(true);
    expect(ev.some((e) => e.kind === 'job' && e.category === 'build')).toBe(true);
    expect(ev.some((e) => e.kind === 'deploy')).toBe(false);
    svc.stop();
  });
});

describe('crew: master + sub-agents + Codex pair', () => {
  it('publishes role / parent / model as enums with pseudonymous parent links, no content', async () => {
    const root = tmp(); const codexRoot = tmp(); const data = tmp();
    let clock = T0.getTime();
    const svc = new PrivateService({ privateDbPath: join(data, 'p.db'), publicDbPath: join(data, 'pub.db'), ingestToken: 'i', opsToken: 'o', delaySeconds: 30, demoMode: false, publicProjects: ['alpha'], shipManifest: { name: 'Test Ship', projects: [{ id: 'alpha', name: 'Alpha' }] }, now: () => new Date(clock) });
    const attributor = new ProjectAttributor([{ id: 'alpha', repoPaths: [WIN_CWD] }], async () => null);
    const scanner = new SessionScanner({ dirs: [root], instance: 'inst', attributor });
    const codex = new CodexScanner({ dirs: [codexRoot], instance: 'inst', attributor });
    const MASTER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeSession(root, 'p', MASTER, WIN_CWD, new Date(clock - 1000));
    writeSub(root, 'p', MASTER, 'h1', WIN_CWD, new Date(clock - 1000), 'claude-haiku-4-5');
    writeSub(root, 'p', MASTER, 'h2', WIN_CWD, new Date(clock - 2000), 'haiku');
    writeCodex(codexRoot, new Date(clock), 'x', { id: '019abcde-0001-0002', cwd: WIN_CWD, originator: 'codex_exec', source: 'exec' }, new Date(clock - 1000), turnContext('gpt-6.1-sol', 'medium'));
    const now = new Date(clock);
    const evs = [...(await scanner.tick(now)), ...(await codex.tick(now, scanner.mains()))];
    expect(svc.ingest(evs)).toMatchObject({ accepted: 4, quarantined: 0 });
    clock += 31_000; svc.publishDue();
    const pub = new PublicStoreReader(join(data, 'pub.db')).after(0).filter((e) => e.kind === 'worker') as Extract<ReturnType<PublicStoreReader['after']>[number], { kind: 'worker' }>[];
    expect(pub).toHaveLength(4);
    const master = pub.find((e) => e.harness === 'claude' && !e.role)!;
    const subs = pub.filter((e) => e.role === 'subagent');
    const pair = pub.find((e) => e.harness === 'codex')!;
    expect(subs).toHaveLength(2);
    for (const e of subs) expect(e).toMatchObject({ maker: 'anthropic', model: 'haiku', parent: master.worker, certainty: 'inferred' });
    expect(pair).toMatchObject({ role: 'pair', maker: 'openai', model: 'sol', effort: 'medium', parent: master.worker, certainty: 'inferred' });
    const blob = JSON.stringify(pub);
    for (const x of [SECRET_PROMPT, SECRET_TOKEN, SECRET_CODE, SECRET_INSTRUCTIONS, 'Users', 'agent-h1', MASTER, '019abcde']) expect(blob).not.toContain(x);
    svc.stop();
  });
});

describe('startAgent', () => {
  it('serves the loopback ingest + ops room, refuses a second instance, and the CLI poster works', async () => {
    const data = tmp(); const logs = tmp();
    const secretFile = join(data, 'ship.secret');
    writeFileSync(secretFile, 'x'.repeat(40));
    const port = await freePort();
    const cfg = resolveConfig({ shipId: 'demo1', replicaUrl: 'https://demo1.botwarren.com', secretFile, opsPort: port, dataDir: data, harnessLogDirs: [logs], projects: [{ id: 'demo1', repoPaths: [WIN_CWD] }] });
    writeSession(logs, 'p', 'live-1', WIN_CWD, new Date());
    const lines: string[] = [];
    const agent = await startAgent(cfg, { log: (m) => lines.push(m), replicate: false });
    try {
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).ok).toBe(true);
      await expect(startAgent(cfg, { log: () => {}, replicate: false })).rejects.toThrow(/already running|in use/);
      const token = readFileSync(dataPaths(data).ingestToken, 'utf8').trim();
      const ok = await makePoster({ port, token })([]);
      expect(ok).toBe(true);
      expect(await makePoster({ port, token: 'wrong' })([])).toBe(false);
      await new Promise((r) => setTimeout(r, 300));
      const ops = (await (await fetch(`http://127.0.0.1:${port}/ops/api/state`, { headers: { authorization: `Bearer ${readFileSync(dataPaths(data).opsToken, 'utf8').trim()}` } })).json()) as { sessions: { sessionKey: string; projectId: string }[] };
      expect(ops.sessions.some((s) => s.sessionKey === 'claude:live-1' && s.projectId === 'demo1')).toBe(true);
      // the log file never holds the secret
      expect(lines.join('\n')).not.toContain('xxxxxxxx');
    } finally { await agent.stop(); }
  });
});
