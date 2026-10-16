import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NINOX_ALLOW, NinoxAdapter, ninoxConfigPath, parsePortFromToml, resolveNinoxPort, verifyNinoxShape } from '../../src/adapters/ninox.ts';
import { PolicyError } from '../../src/adapters/api.ts';
import { makeDetectEnv } from '../../src/adapters/config.ts';
import { makeLoopbackHttp } from '../../src/adapters/policy.ts';
import { CANARY_CONTENT, CANARY_PATH, ended, fakeHttp, linuxHost, makeHost, mkTmp, rmTmp, sessions } from './kit.ts';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const at = (s: number) => new Date(NOW.getTime() + s * 1000);
const UUID = '0b1c2d3e-aaaa-bbbb-cccc-0123456789ab';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });
const projects = [{ id: 'demo1', repoPaths: ['/work/game'] }];

/** field names verbatim from Ninox types.rs (v0.34.0 source); values are synthetic */
const row = (o: Record<string, unknown>) => ({
  id: 's1', name: `fix ${CANARY_CONTENT}`, repo: `acme/${CANARY_CONTENT}`, status: 'working', agent_type: 'claude', cost_usd: 1.23, started_at: 1_760_000_000,
  workspace_path: '/work/game', summary: CANARY_CONTENT, activity_note: CANARY_CONTENT, activity: 'working', model: 'claude-opus-4-5', context_used_pct: 70,
  claude_session_id: UUID, pr_number: 42, gate_status: { ci: 'Failing', review: 'Pending', mergeable: 'Unknown' }, pid: 4242, machine_id: 'm1', catalogue_path: `/x/${CANARY_PATH}`, ...o,
});

async function ninoxHost(sessionsBody: unknown, extra: Record<string, unknown> = {}, sse?: { path: string; lines: string[] }) {
  const srv = await fakeHttp({ '/api/v1/sessions': sessionsBody, ...extra }, sse ? { sse } : {});
  cleanup.push(srv.close);
  const host = linuxHost('/home/u');
  const adapter = new NinoxAdapter(host);
  const h = makeHost({ adapters: [{ adapter, settings: { port: srv.port } }], host, projects });
  cleanup.push(() => adapter.stop());
  return { srv, adapter, ...h };
}

describe('Ninox shape verification', () => {
  it('accepts the documented session list, tolerates {sessions:[...]}, rejects other services on the port', () => {
    expect(verifyNinoxShape(JSON.stringify([row({})]))).toHaveLength(1);
    expect(verifyNinoxShape(JSON.stringify({ sessions: [row({})] }))).toHaveLength(1);
    expect(verifyNinoxShape('[]')).toBe('empty');
    expect(verifyNinoxShape('<html>agentsview</html>')).toBeNull();
    expect(verifyNinoxShape(JSON.stringify([{ id: 'x', title: 'something else' }]))).toBeNull();
    expect(verifyNinoxShape(JSON.stringify({ ok: true }))).toBeNull();
    expect(verifyNinoxShape(JSON.stringify([row({}), 7]))).toBeNull();
  });
  it('reads only the top-level port from config.toml', () => {
    expect(parsePortFromToml('port = 9191\n')).toBe(9191);
    expect(parsePortFromToml('# c\nport=9191 # x\n[server]\nport = 1234')).toBe(9191);
    expect(parsePortFromToml('[server]\nport = 1234')).toBeNull();
    expect(parsePortFromToml('port = 80')).toBeNull();
  });
  it('port precedence: settings, then Ninox config.toml, then 8080; config path per OS and NINOX_CONFIG', () => {
    const home = mkTmp(); cleanup.push(() => rmTmp(home));
    const host = linuxHost(home);
    expect(resolveNinoxPort(host, { enabled: 'auto' }, () => null)).toBe(8080);
    expect(resolveNinoxPort(host, { enabled: 'auto' }, () => Buffer.from('port = 9000'))).toBe(9000);
    expect(resolveNinoxPort(host, { enabled: 'auto', port: 9100 }, () => Buffer.from('port = 9000'))).toBe(9100);
    expect(ninoxConfigPath(linuxHost('/h'))).toBe('/h/.config/ninox/config.toml');
    expect(ninoxConfigPath({ platform: 'darwin', home: '/Users/u', env: {} })).toBe('/Users/u/Library/Application Support/ninox/config.toml');
    expect(ninoxConfigPath(linuxHost('/h', { NINOX_CONFIG: '/etc/n.toml' }))).toBe('/etc/n.toml');
  });
});

describe('Ninox hard allowlist', () => {
  it('the adapter manifest declares exactly the two GETs; terminal, diff, delete, orchestrators and brain are unreachable', async () => {
    const adapter = new NinoxAdapter(linuxHost('/h'));
    const declared = adapter.manifest.reads.filter((r) => r.kind === 'loopback-http').map((r) => r.target).sort();
    expect(declared).toEqual(['GET /api/v1/events', 'GET /api/v1/sessions']);
    expect([...NINOX_ALLOW].sort()).toEqual(['/api/v1/events', '/api/v1/sessions']);
    const srv = await fakeHttp({ '/api/v1/sessions': [] });
    cleanup.push(srv.close);
    const http = makeLoopbackHttp({ allow: NINOX_ALLOW, port: srv.port });
    for (const p of ['/api/v1/sessions/s1/terminal', '/api/v1/sessions/s1/diff', '/api/v1/sessions/s1', '/api/v1/orchestrators', '/api/brain/notes', '/api/v1/sessions?x=1']) {
      await expect(http.get(p)).rejects.toBeInstanceOf(PolicyError);
      await expect(http.sse(p, () => {}, new AbortController().signal)).rejects.toBeInstanceOf(PolicyError);
    }
    expect(srv.requests).toHaveLength(0);
  });

  it('a full run only ever issues GET /api/v1/sessions and GET /api/v1/events', async () => {
    const { srv, host } = await ninoxHost([row({})], {}, { path: '/api/v1/events', lines: ['{"type":"session_updated","payload":{}}'] });
    await host.tick(NOW);
    await new Promise((r) => setTimeout(r, 100));
    await host.tick(at(4));
    const seen = new Set(srv.requests.map((r) => `${r.method} ${r.url}`));
    expect([...seen].every((s) => s === 'GET /api/v1/sessions' || s === 'GET /api/v1/events')).toBe(true);
    expect(seen.has('GET /api/v1/sessions')).toBe(true);
  });
});

describe('NinoxAdapter projection', () => {
  it('classifies the reported model to maker + line (never the raw id), reads an effort only if the row has one, and invents no model for a codex row without one', async () => {
    const { host } = await ninoxHost([
      row({ id: 'k1', claude_session_id: undefined, model: 'kimi-k2-thinking-20261001', effort: 'High' }),
      row({ id: 'c1', claude_session_id: undefined, agent_type: 'codex', model: undefined }),
    ]);
    const evs = await host.tick(NOW);
    const s = sessions(evs);
    const k = s.find((e) => e.sessionKey === 'ninox:k1')!;
    expect(k).toMatchObject({ maker: 'moonshot', model: 'kimi', effort: 'high' });
    const c = s.find((e) => e.sessionKey === 'ninox:c1')!;
    expect(c.maker).toBeUndefined(); expect(c.model).toBeUndefined(); expect(c.effort).toBeUndefined();
    expect(JSON.stringify(evs)).not.toContain('20261001');
  });
  it('maps status/activity/hierarchy/context, joins on claude_session_id, and drops every content field', async () => {
    const { host, logs } = await ninoxHost([
      row({ id: 'orch', activity: 'idle', status: 'working', claude_session_id: undefined }),
      row({ id: 'w1', orchestrator_id: 'orch', activity: 'blocked' }),
      row({ id: 'gone', status: 'done' }),
    ]);
    const evs = await host.tick(NOW);
    const s = sessions(evs);
    expect(s).toHaveLength(2);
    const worker = s.find((e) => e.sessionKey === `claude:${UUID}`)!;
    expect(worker).toMatchObject({ status: 'blocked', role: 'subagent', parentKey: 'ninox:orch', harness: 'claude', maker: 'anthropic', model: 'opus', projectId: 'demo1', attribution: { certainty: 'observed' } });
    expect(worker.private).toMatchObject({ lifecycle: 'working', cwd: '/work/game', tool: 'claude-code' });
    const ctxEv = evs.filter((e) => e.type === 'session.activity');
    expect(ctxEv[0]).toMatchObject({ kind: 'context', context: 'high' }); // 70% -> high
    const text = JSON.stringify(evs) + logs.join('');
    for (const needle of [CANARY_CONTENT, CANARY_PATH, 'acme/', 'cost_usd', '1.23', '"pr_number"', 'm1']) expect(text).not.toContain(needle);
  });

  it('a worker whose orchestrator is not in the list stays a main session (no dangling parent)', async () => {
    const { host } = await ninoxHost([row({ id: 'w9', orchestrator_id: 'missing' })]);
    const s = sessions(await host.tick(NOW));
    expect(s[0]!.role).toBe('main');
    expect(s[0]!.parentKey).toBeUndefined();
  });

  it('a terminal status ends the session; the other service on the port yields nothing and reports unexpected_shape', async () => {
    let body: unknown = [row({})];
    const { host, srv } = await ninoxHost(() => body);
    void srv;
    expect(sessions(await host.tick(NOW))).toHaveLength(1);
    body = [row({ status: 'terminated' })];
    expect(ended(await host.tick(at(4)))).toHaveLength(1);
    body = { not: 'ninox' };
    const r = await host.tick(at(8));
    expect(sessions(r)).toHaveLength(0);
    expect(host.statuses()[0]).toMatchObject({ state: 'unsupported_version', code: 'unexpected_shape' });
  });

  it('never ends sessions while Ninox is unreachable', async () => {
    const { host, srv } = await ninoxHost([row({})]);
    await host.tick(NOW);
    await srv.close();
    expect(ended(await host.tick(at(4)))).toHaveLength(0);
    expect(host.statuses()[0]!.state).toBe('degraded');
  });

  it('SSE is only a wake-up hint: a known event type requests an early poll; payloads are not parsed', async () => {
    const { host } = await ninoxHost([row({})], {}, { path: '/api/v1/events', lines: ['{"type":"notification","payload":{"body":"CANARY"}}', '{"type":"worker_done","payload":{}}', 'not json'] });
    let woke = 0;
    host.onWake = () => { woke++; };
    await host.tick(NOW);
    await new Promise((r) => setTimeout(r, 150));
    expect(woke).toBe(1);
    expect(host.takePollRequests()).toEqual(['ninox']);
  });

  it('detect: verified shape -> high; wrong service on the port -> not found; empty list -> medium; nothing there but binary config -> installed', async () => {
    const good = await fakeHttp({ '/api/v1/sessions': [row({})] }); cleanup.push(good.close);
    const other = await fakeHttp({ '/api/v1/sessions': { hello: 'agentsview' } }); cleanup.push(other.close);
    const empty = await fakeHttp({ '/api/v1/sessions': [] }); cleanup.push(empty.close);
    const home = mkTmp(); cleanup.push(() => rmTmp(home));
    const host = linuxHost(home);
    const a = new NinoxAdapter(host);
    const det = (port: number) => a.detect(makeDetectEnv(host, { enabled: 'auto', port }, []));
    expect(await det(good.port)).toMatchObject({ found: true, confidence: 'high' });
    expect(await det(other.port)).toMatchObject({ found: false });
    expect(await det(empty.port)).toMatchObject({ found: true, confidence: 'medium' });
    expect((await det(1)).found).toBe(false);
    mkdirSync(join(home, '.config', 'ninox'), { recursive: true });
    writeFileSync(join(home, '.config', 'ninox', 'config.toml'), 'port = 8123\n');
    expect(await det(1025)).toMatchObject({ found: true, confidence: 'medium' });
    const win = { platform: 'win32' as const, home: 'C:\\u', env: {} };
    expect(await new NinoxAdapter(win).detect(makeDetectEnv(win, { enabled: 'auto' }, []))).toMatchObject({ found: false, note: expect.stringContaining('Windows') });
  });
});
