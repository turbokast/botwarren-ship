import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HERDR_ALLOWED_METHODS, HerdrAdapter, HerdrRpc, herdrTargets } from '../../src/adapters/herdr.ts';
import { PolicyError } from '../../src/adapters/api.ts';
import { makeDetectEnv } from '../../src/adapters/config.ts';
import { CANARY_CONTENT, ended, fakeHerdr, herdrHost, linuxHost, makeHost, mkTmp, rmTmp, sessions } from './kit.ts';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const at = (s: number) => new Date(NOW.getTime() + s * 1000);
const UUID = '0b1c2d3e-aaaa-bbbb-cccc-0123456789ab';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

describe('herdr socket resolution', () => {
  const h = (env: Record<string, string>) => linuxHost('/home/u', env);
  it('uses the documented env names first, the legacy name as fallback, then the default', () => {
    expect(herdrTargets(h({})).map((t) => t.path)).toEqual(['/home/u/.config/herdr/herdr.sock']);
    expect(herdrTargets(h({ HERDR_SOCKET_PATH: '/run/x.sock' })).map((t) => t.path)).toEqual(['/run/x.sock', '/home/u/.config/herdr/herdr.sock']);
    expect(herdrTargets(h({ HERDR_SESSION: 'work' })).map((t) => t.path)[0]).toBe('/home/u/.config/herdr/sessions/work/herdr.sock');
    expect(herdrTargets(h({ HERDR_SOCKET: '/legacy.sock' })).map((t) => t.path)).toEqual(['/legacy.sock', '/home/u/.config/herdr/herdr.sock']);
    // precedence: SOCKET_PATH, SESSION, legacy
    const all = herdrTargets(h({ HERDR_SOCKET_PATH: '/a.sock', HERDR_SESSION: 's', HERDR_SOCKET: '/b.sock' })).map((t) => t.path);
    expect(all.slice(0, 3)).toEqual(['/a.sock', '/home/u/.config/herdr/sessions/s/herdr.sock', '/b.sock']);
  });
  it('adds named sessions, respects XDG_CONFIG_HOME, rejects odd names and caps the list', () => {
    expect(herdrTargets(h({ XDG_CONFIG_HOME: '/xdg' }), ['alpha', '../evil', 'a b']).map((t) => t.path)).toEqual(['/xdg/herdr/herdr.sock', '/xdg/herdr/sessions/alpha/herdr.sock']);
    expect(herdrTargets(h({}), Array.from({ length: 30 }, (_, i) => `s${i}`))).toHaveLength(8);
    expect(herdrTargets(h({ HERDR_SESSION: '../../etc' })).map((t) => t.path)).toEqual(['/home/u/.config/herdr/herdr.sock']);
  });
  it('Windows (UNVERIFIED): only an explicit named pipe in HERDR_SOCKET_PATH, never a guessed pipe name', () => {
    const w = (env: Record<string, string>) => ({ platform: 'win32' as const, home: 'C:\\Users\\u', env });
    expect(herdrTargets(w({}))).toEqual([]);
    expect(herdrTargets(w({ HERDR_SOCKET_PATH: '\\\\.\\pipe\\herdr-abc' }))).toEqual([{ name: 'default', path: '\\\\.\\pipe\\herdr-abc' }]);
    expect(herdrTargets(w({ HERDR_SOCKET_PATH: 'C:\\evil\\file' }))).toEqual([]);
  });
});

describe('herdr read-only allowlist', () => {
  it('only agent.list and ping exist; everything else throws before a connection is attempted', async () => {
    expect([...HERDR_ALLOWED_METHODS].sort()).toEqual(['agent.list', 'ping']);
    const rpc = new HerdrRpc('/nonexistent/never.sock');
    for (const m of ['agent.read', 'pane.read', 'agent.prompt', 'pane.send_text', 'session.snapshot', 'events.subscribe', 'agent.start']) {
      await expect(rpc.call(m)).rejects.toBeInstanceOf(PolicyError);
    }
  });
});

describe('HerdrAdapter against a fake socket', () => {
  const projects = [{ id: 'demo1', repoPaths: ['/work/game'] }];
  const agentsFor = (cwd: string, extra: Record<string, unknown> = {}) => () => [
    { agent: 'claude', agent_status: 'working', agent_session: { agent: 'claude', kind: 'id', source: 'hook', value: UUID }, cwd, pane_id: 'p1', terminal_id: 't1', terminal_title_stripped: `fix the bug ${CANARY_CONTENT}`, screen: CANARY_CONTENT, ...extra },
    { agent: null, agent_status: 'unknown', pane_id: 'p2' },
    { agent: 'codex', agent_status: 'blocked', cwd: '/elsewhere', pane_id: 'p3' },
  ];

  it('observes agents with the documented session id as the key, drops content, and never sends a write method', async () => {
    const home = mkTmp(); cleanup.push(() => rmTmp(home));
    const dir = join(home, '.config', 'herdr');
    const srv = await fakeHerdr(dir, agentsFor('/work/game'));
    cleanup.push(srv.close);
    const adapter = new HerdrAdapter(herdrHost(home, dir));
    const { host, logs } = makeHost({ adapters: [{ adapter }], host: herdrHost(home, dir), projects });
    const evs = await host.tick(NOW);
    const s = sessions(evs);
    expect(s.map((e) => e.sessionKey).sort()).toEqual([`claude:${UUID}`, 'pane:p3']);
    const claude = s.find((e) => e.sessionKey === `claude:${UUID}`)!;
    expect(claude).toMatchObject({ harness: 'claude', status: 'working', projectId: 'demo1', workCategory: 'bugfix', attribution: { certainty: 'observed' } });
    expect(s.find((e) => e.sessionKey === 'pane:p3')).toMatchObject({ status: 'blocked', projectId: null, harness: 'codex' });
    expect(JSON.stringify(evs)).not.toContain(CANARY_CONTENT);
    expect(logs.join('')).not.toContain(CANARY_CONTENT);
    expect(new Set(srv.methods)).toEqual(new Set(['agent.list']));
    await adapter.stop();
  });

  // Named sessions are folders of unix sockets under the Herdr config dir: a POSIX layout. On Windows Herdr is one explicitly named pipe.
  it.skipIf(process.platform === 'win32')('follows named sessions and HERDR_SESSION; a vanished pane ends only while Herdr answers', async () => {
    const home = mkTmp(); cleanup.push(() => rmTmp(home));
    let list: unknown[] = [{ agent: 'opencode', agent_status: 'idle', cwd: '/work/game', pane_id: 'p9' }];
    const srv = await fakeHerdr(join(home, '.config', 'herdr', 'sessions', 'work'), () => list);
    cleanup.push(srv.close);
    const adapter = new HerdrAdapter(linuxHost(home));
    const { host } = makeHost({ adapters: [{ adapter }], host: linuxHost(home), projects });
    const r1 = sessions(await host.tick(NOW));
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ sessionKey: 'pane:work:p9', harness: 'unknown', projectId: 'demo1' });
    expect((r1[0]!.private as Record<string, string>).tool).toBe('opencode');
    list = [];
    expect(ended(await host.tick(at(4))).map((e) => e.sessionKey)).toEqual(['pane:work:p9']);
    await adapter.stop();
  });

  it('keeps sessions while Herdr is unreachable (no false endings) and reconnects with backoff', async () => {
    const home = mkTmp(); cleanup.push(() => rmTmp(home));
    const dir = join(home, '.config', 'herdr');
    let srv = await fakeHerdr(dir, agentsFor('/work/game'));
    const adapter = new HerdrAdapter(herdrHost(home, dir));
    const { host } = makeHost({ adapters: [{ adapter }], host: herdrHost(home, dir), projects });
    expect(sessions(await host.tick(NOW)).length).toBeGreaterThan(0);
    await srv.close();
    const down = await host.tick(at(3));
    expect(ended(down)).toHaveLength(0);
    expect(host.statuses()[0]!.sessions).toBeGreaterThan(0);
    srv = await fakeHerdr(dir, agentsFor('/work/game'));
    cleanup.push(srv.close);
    const later = await host.tick(at(60)); // past the backoff window
    expect(ended(later)).toHaveLength(0);
    expect(host.statuses()[0]!.state).toBe('ok');
    await adapter.stop();
  });

  it.skipIf(process.platform === 'win32')('detects: socket present -> high; not running and not installed -> not found', async () => {
    const home = mkTmp(); cleanup.push(() => rmTmp(home));
    const host = linuxHost(home);
    const a = new HerdrAdapter(host);
    expect((await a.detect(makeDetectEnv(host, { enabled: 'auto' }, []))).found).toBe(false);
    const srv = await fakeHerdr(join(home, '.config', 'herdr'), () => []);
    cleanup.push(srv.close);
    expect(await a.detect(makeDetectEnv(host, { enabled: 'auto' }, []))).toMatchObject({ found: true, confidence: 'high' });
  });

  it('detects on Windows only an explicitly named pipe (never a guessed pipe name), with an UNVERIFIED note otherwise', async () => {
    const w = { platform: 'win32' as const, home: 'C:\\Users\\u', env: {} };
    const d = await new HerdrAdapter(w).detect(makeDetectEnv(w, { enabled: 'auto' }, []));
    expect(d.found).toBe(false);
    expect(d.note).toContain('UNVERIFIED');
    const p = { platform: 'win32' as const, home: 'C:\\Users\\u', env: { HERDR_SOCKET_PATH: '\\\\.\\pipe\\herdr-abc' } };
    expect(await new HerdrAdapter(p).detect(makeDetectEnv(p, { enabled: 'auto' }, []))).toMatchObject({ found: true, confidence: 'low' });
  });
});
