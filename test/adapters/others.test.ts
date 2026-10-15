import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPENCODE_ALLOW, OPENCODE_ALLOW_V2, OpenCodeAdapter, isOpencodeAuthRequired, verifyOpencodePending, verifyOpencodeShape, verifyOpencodeV2Shape } from '../../src/adapters/opencode.ts';
import { V2_LIVE_ACTIVE_EMPTY, V2_LIVE_LIST_EMPTY, V2_LIVE_PENDING_EMPTY, V2_LIVE_SPA_HTML, V2_LIVE_UNAUTHORIZED, fakeOpencodeV2, v2Bodies } from './opencode-fixtures.ts';
import { GeminiCliAdapter, hashCandidates, projectHash } from '../../src/adapters/gemini.ts';
import { makeDetectEnv } from '../../src/adapters/config.ts';
import { PolicyError } from '../../src/adapters/api.ts';
import { makeLoopbackHttp } from '../../src/adapters/policy.ts';
import { CANARY_CONTENT, ended, fakeHttp, linuxHost, makeHost, mkTmp, rmTmp, sessions } from './kit.ts';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const at = (s: number) => new Date(NOW.getTime() + s * 1000);
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });
const projects = [{ id: 'demo1', repoPaths: ['/work/game'] }];

describe('OpenCodeAdapter 1.x (documented shapes, UNVERIFIED live)', () => {
  const list = (o: Record<string, unknown>[] = []) => [
    { id: 'ses_a', directory: '/work/game', title: `T ${CANARY_CONTENT}`, time: { created: NOW.getTime() - 60_000, updated: NOW.getTime() - 1000 } },
    { id: 'ses_b', parentID: 'ses_a', directory: '/work/game', title: CANARY_CONTENT, time: { created: 1, updated: NOW.getTime() - 2000 } },
    { id: 'ses_old', directory: '/work/game', time: { created: 1, updated: NOW.getTime() - 3 * 3600_000 } },
    ...o,
  ];
  const run = async (statusBody: unknown, listBody: unknown) => {
    const srv = await fakeHttp({ '/session/status': statusBody, '/session': listBody });
    cleanup.push(srv.close);
    const adapter = new OpenCodeAdapter();
    return { srv, ...makeHost({ adapters: [{ adapter, settings: { port: srv.port } }], host: linuxHost('/h'), projects }) };
  };

  it('maps busy/idle, parent links and recent sessions; drops titles; old idle sessions are ignored', async () => {
    const { host, logs, srv } = await run({ ses_a: { type: 'busy' } }, list());
    const evs = await host.tick(NOW);
    const s = sessions(evs);
    expect(s.map((e) => e.sessionKey).sort()).toEqual(['opencode:ses_a', 'opencode:ses_b']);
    expect(s.find((e) => e.sessionKey === 'opencode:ses_a')).toMatchObject({ status: 'working', harness: 'unknown', projectId: 'demo1' });
    expect(s.find((e) => e.sessionKey === 'opencode:ses_b')).toMatchObject({ status: 'idle', role: 'subagent', parentKey: 'opencode:ses_a' });
    expect(JSON.stringify(evs) + logs.join('')).not.toContain(CANARY_CONTENT);
    // the first poll tries the 2.x routes (404 here), then settles on 1.x; nothing outside the two allowlists is ever requested
    expect(new Set(srv.requests.map((r) => r.url))).toEqual(new Set(['/api/session/active', '/session/status', '/session']));
    const n = srv.requests.length;
    await host.tick(at(4));
    expect(srv.requests.slice(n).map((r) => r.url)).toEqual(['/session/status', '/session']);
  });

  it('ends sessions that disappear; reports unexpected_shape for another service', async () => {
    let l: unknown = list();
    const srv = await fakeHttp({ '/session/status': {}, '/session': () => l });
    cleanup.push(srv.close);
    const { host } = makeHost({ adapters: [{ adapter: new OpenCodeAdapter(), settings: { port: srv.port } }], host: linuxHost('/h'), projects });
    await host.tick(NOW);
    l = [];
    expect(ended(await host.tick(at(4)))).toHaveLength(2);
    l = { hello: 'world' };
    await host.tick(at(8));
    expect(host.statuses()[0]).toMatchObject({ state: 'unsupported_version', code: 'unexpected_shape' });
  });

  it('allowlist: message, diff and other session sub-routes are unreachable', async () => {
    const srv = await fakeHttp({});
    cleanup.push(srv.close);
    const http = makeLoopbackHttp({ allow: OPENCODE_ALLOW, port: srv.port });
    for (const p of ['/session/ses_a/message', '/session/ses_a/diff', '/session/ses_a', '/event', '/file', '/api/session/ses_a/message', '/api/session/ses_a/prompt', '/api/shell', '/api/fs/read', '/api/credential', '/api/session/active?x=1', '/api/event']) await expect(http.get(p)).rejects.toBeInstanceOf(PolicyError);
    expect(srv.requests).toHaveLength(0);
  });

  it('shape check and detection', async () => {
    expect(verifyOpencodeShape('{"a":{"type":"idle"}}', '[{"id":"x"}]')).not.toBeNull();
    expect(verifyOpencodeShape('[]', '[{"id":"x"}]')).toBeNull();
    expect(verifyOpencodeShape('{"a":{"type":"idle"}}', '[{"nope":1}]')).toBeNull();
    const good = await fakeHttp({ '/session/status': {}, '/session': [] }); cleanup.push(good.close);
    const other = await fakeHttp({ '/session/status': 'nope', '/session': 'nope' }); cleanup.push(other.close);
    const host = linuxHost('/h');
    const a = new OpenCodeAdapter();
    expect(await a.detect(makeDetectEnv(host, { enabled: 'auto', port: good.port }, []))).toMatchObject({ found: true, confidence: 'high' });
    expect((await a.detect(makeDetectEnv(host, { enabled: 'auto', port: other.port }, []))).found).toBe(false);
  });
});

describe('OpenCodeAdapter 2.x (OpenAPI document + live empty-server responses of v2.0.21)', () => {
  const FOLDER = '/work/game';
  const bodies = () => v2Bodies({ content: CANARY_CONTENT, folder: FOLDER, now: NOW.getTime() });
  const routes = (b = bodies()) => ({ '/api/session/active': b.active, '/api/session': b.list, '/api/permission/request': b.permissions, '/api/form': b.forms });
  const hostFor = (port: number, env: Record<string, string | undefined> = {}) =>
    makeHost({ adapters: [{ adapter: new OpenCodeAdapter(), settings: { port } }], host: linuxHost('/h', env), projects });

  it('LIVE shapes: an empty server verifies and yields no sessions', async () => {
    expect(verifyOpencodeV2Shape(V2_LIVE_ACTIVE_EMPTY, V2_LIVE_LIST_EMPTY)).toEqual({ running: new Set(), list: [] });
    expect(verifyOpencodePending(V2_LIVE_PENDING_EMPTY)).toEqual(new Set());
    expect(isOpencodeAuthRequired(V2_LIVE_UNAUTHORIZED)).toBe(true);
    const srv = await fakeOpencodeV2({ '/api/session/active': V2_LIVE_ACTIVE_EMPTY, '/api/session': V2_LIVE_LIST_EMPTY, '/api/permission/request': V2_LIVE_PENDING_EMPTY, '/api/form': V2_LIVE_PENDING_EMPTY });
    cleanup.push(srv.close);
    const { host } = hostFor(srv.port);
    expect(sessions(await host.tick(NOW))).toHaveLength(0);
    expect(host.statuses()[0]).toMatchObject({ state: 'ok', code: 'none' });
  });

  it('maps running -> working, waiting for permission/question -> blocked, parent links, folder; drops everything else', async () => {
    const srv = await fakeOpencodeV2(routes());
    cleanup.push(srv.close);
    const { host, logs } = hostFor(srv.port);
    const evs = await host.tick(NOW);
    const s = sessions(evs);
    expect(s.map((e) => e.sessionKey).sort()).toEqual(['opencode:ses_a', 'opencode:ses_ask', 'opencode:ses_b', 'opencode:ses_paged', 'opencode:ses_wait']);
    const by = (k: string) => s.find((e) => e.sessionKey === `opencode:${k}`);
    expect(by('ses_a')).toMatchObject({ status: 'working', harness: 'unknown', projectId: 'demo1' });
    expect(by('ses_b')).toMatchObject({ status: 'idle', role: 'subagent', parentKey: 'opencode:ses_a' });
    expect(by('ses_wait')).toMatchObject({ status: 'blocked' });
    expect(by('ses_ask')).toMatchObject({ status: 'blocked' });
    expect(by('ses_paged')).toMatchObject({ status: 'working', projectId: null }); // running but not in the list: state known, folder not
    expect(JSON.stringify(evs) + logs.join('')).not.toContain(CANARY_CONTENT);
    expect(JSON.stringify(evs)).not.toContain('rm -rf');
    // only the four allowlisted 2.x GETs, never a write
    expect(new Set(srv.requests.map((r) => r.url))).toEqual(new Set(OPENCODE_ALLOW_V2));
    expect(srv.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('a permission/form list that fails or has an unexpected shape does not fail the poll', async () => {
    const b = bodies();
    const srv = await fakeOpencodeV2({ '/api/session/active': b.active, '/api/session': b.list, '/api/permission/request': 'nope', '/api/form': { data: 'x' } });
    cleanup.push(srv.close);
    const { host } = hostFor(srv.port);
    const s = sessions(await host.tick(NOW));
    expect(s.find((e) => e.sessionKey === 'opencode:ses_a')).toMatchObject({ status: 'working' });
    expect(host.statuses()[0]).toMatchObject({ state: 'ok' });
  });

  it('an unexpected shape after a good poll is reported, not trusted', async () => {
    let active: unknown = bodies().active;
    const srv = await fakeOpencodeV2({ ...routes(), '/api/session/active': () => active as object });
    cleanup.push(srv.close);
    const { host } = hostFor(srv.port);
    await host.tick(NOW);
    active = { hello: 'world' };
    await host.tick(at(4));
    expect(host.statuses()[0]).toMatchObject({ state: 'unsupported_version', code: 'unexpected_shape' });
  });

  it('password: no credential is sent until the server proves itself with its 401; without a password the adapter says so and reads nothing', async () => {
    const srv = await fakeOpencodeV2(routes(), { password: 'pw-test' });
    cleanup.push(srv.close);
    const none = hostFor(srv.port);
    expect(sessions(await none.host.tick(NOW))).toHaveLength(0);
    expect(none.host.statuses()[0]).toMatchObject({ state: 'degraded', code: 'policy_denied' });
    expect(srv.requests.every((r) => r.authorization === undefined)).toBe(true);
    expect(none.logs.join('\n')).not.toContain('pw-test');

    const n = srv.requests.length;
    const withPw = hostFor(srv.port, { OPENCODE_SERVER_PASSWORD: 'pw-test' });
    const evs = await withPw.host.tick(NOW);
    expect(sessions(evs).length).toBeGreaterThan(0);
    expect(withPw.host.statuses()[0]).toMatchObject({ state: 'ok' });
    const sent = srv.requests.slice(n);
    expect(sent[0]!.authorization).toBeUndefined(); // the first request is anonymous; the 401 identifies the server
    expect(sent.slice(1).every((r) => r.authorization === `Basic ${Buffer.from('opencode:pw-test').toString('base64')}`)).toBe(true);
    expect(JSON.stringify(evs) + withPw.logs.join('')).not.toContain('pw-test');
    // a wrong password stays denied
    const wrong = hostFor(srv.port, { OPENCODE_SERVER_PASSWORD: 'nope' });
    await wrong.host.tick(NOW);
    expect(wrong.host.statuses()[0]).toMatchObject({ state: 'degraded', code: 'policy_denied' });
  });

  it('a password is never sent to something that does not identify itself as OpenCode 2.x', async () => {
    const srv = await fakeHttp({ '/api/session/active': () => 'whatever' });
    cleanup.push(srv.close);
    const { host } = makeHost({ adapters: [{ adapter: new OpenCodeAdapter(), settings: { port: srv.port } }], host: linuxHost('/h', { OPENCODE_SERVER_PASSWORD: 'pw-test' }), projects });
    await host.tick(NOW);
    expect(srv.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(srv.requests)).not.toContain('pw-test');
  });

  it('httpAuth: only the documented variables; username default and validation; declared in the manifest', () => {
    const a = new OpenCodeAdapter();
    expect(a.httpAuth({})).toBeNull();
    expect(a.httpAuth({ OPENCODE_SERVER_PASSWORD: '' })).toBeNull();
    expect(a.httpAuth({ OPENCODE_SERVER_PASSWORD: 'x' })).toEqual({ user: 'opencode', password: 'x' });
    expect(a.httpAuth({ OPENCODE_SERVER_PASSWORD: 'x', OPENCODE_SERVER_USERNAME: 'me' })).toEqual({ user: 'me', password: 'x' });
    expect(a.httpAuth({ OPENCODE_SERVER_PASSWORD: 'x', OPENCODE_SERVER_USERNAME: 'a:b' })?.user).toBe('opencode');
    expect(a.manifest.reads.some((r) => r.kind === 'env' && r.target.includes('OPENCODE_SERVER_PASSWORD'))).toBe(true);
  });

  it('detect: verified 2.x server, password-protected 2.x server, 1.x server (not confused with the 2.x web app), something else', async () => {
    const b = bodies();
    const good = await fakeOpencodeV2(routes(b)); cleanup.push(good.close);
    const locked = await fakeOpencodeV2(routes(b), { password: 'pw' }); cleanup.push(locked.close);
    const v1 = await fakeHttp({ '/session/status': {}, '/session': [] }); cleanup.push(v1.close);
    const other = await fakeHttp({ '/api/session/active': 'nope', '/api/session': 'nope', '/session/status': 'nope', '/session': 'nope' }); cleanup.push(other.close);
    const partial = await fakeOpencodeV2({ '/api/session/active': '{"data":{}}', '/api/session': 'not json' }); cleanup.push(partial.close);
    const host = linuxHost('/h');
    const det = (port: number) => new OpenCodeAdapter().detect(makeDetectEnv(host, { enabled: 'auto', port }, []));
    expect(await det(good.port)).toMatchObject({ found: true, confidence: 'high', note: expect.stringContaining('2.x verified') });
    const l = await det(locked.port);
    expect(l).toMatchObject({ found: true, confidence: 'high' });
    expect(l.note).toContain('OPENCODE_SERVER_PASSWORD');
    expect(await det(v1.port)).toMatchObject({ found: true, confidence: 'high', note: expect.stringContaining('1.x verified') });
    expect((await det(other.port)).found).toBe(false);
    expect((await det(partial.port)).found).toBe(false); // the 2.x route answers but nothing verifies; the web app HTML on the 1.x paths is rejected
    expect(V2_LIVE_SPA_HTML).toContain('html');
  });

  it('shape checks reject near misses', () => {
    expect(verifyOpencodeV2Shape('{"data":{"ses_a":{"type":"running"}}}', '{"data":[{"id":"ses_a"}]}')?.running.has('ses_a')).toBe(true);
    expect(verifyOpencodeV2Shape('{"ses_a":{"type":"running"}}', '{"data":[]}')).toBeNull(); // 1.x style, no wrapper
    expect(verifyOpencodeV2Shape('{"data":{"ses_a":{"type":"running"}}}', '[{"id":"x"}]')).toBeNull();
    expect(verifyOpencodeV2Shape('{"data":{"ses_a":1}}', '{"data":[]}')).toBeNull();
    expect(verifyOpencodeV2Shape('{"data":{}}', '{"data":[{"nope":1}]}')).toBeNull();
    expect(verifyOpencodePending('{"data":[{"id":"per_1"}]}')).toBeNull();
    expect(isOpencodeAuthRequired('{"error":"unauthorized"}')).toBe(false);
    expect(isOpencodeAuthRequired('<html>')).toBe(false);
  });
});

describe('GeminiCliAdapter (documented layout, UNVERIFIED live)', () => {
  const setup = () => {
    const home = mkTmp(); cleanup.push(() => rmTmp(home));
    const dir = join(home, '.gemini', 'tmp', projectHash('/work/game'), 'chats');
    mkdirSync(dir, { recursive: true });
    const chat = (name: string, ageMs: number, content = `{"messages":[{"text":"${CANARY_CONTENT}"}]}`) => {
      const p = join(dir, name); writeFileSync(p, content); const t = new Date(NOW.getTime() - ageMs); utimesSync(p, t, t); return p;
    };
    return { home, dir, chat };
  };

  it('attributes by the hash of the configured path, infers state from write times, and never opens a chat file', async () => {
    const { home, dir, chat } = setup();
    chat('session-2026-10-14T11-59-abc123.json', 5000);
    chat('session-2026-10-14T11-00-old999.jsonl', 5 * 60_000);
    chat('session-too-old.json', 2 * 3600_000);
    chat('notes.txt', 1000);
    mkdirSync(join(home, '.gemini', 'tmp', projectHash('/somewhere/else'), 'chats'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'tmp', projectHash('/somewhere/else'), 'chats', 'session-x.json'), 'x');
    const adapter = new GeminiCliAdapter(linuxHost(home));
    const { host, logs } = makeHost({ adapters: [{ adapter }], host: linuxHost(home), projects });
    const evs = await host.tick(NOW);
    const s = sessions(evs);
    expect(s.map((e) => `${e.sessionKey}:${e.status}`).sort()).toEqual(['gemini:session-2026-10-14T11-00-old999:idle', 'gemini:session-2026-10-14T11-59-abc123:working']);
    expect(s[0]).toMatchObject({ harness: 'unknown', projectId: 'demo1', attribution: { certainty: 'inferred' } });
    expect(JSON.stringify(evs) + logs.join('')).not.toContain(CANARY_CONTENT);
    expect(dir).toContain(projectHash('/work/game'));
    // chat goes quiet beyond 30 min -> ended
    expect(ended(await host.tick(at(31 * 60))).length).toBe(2);
  });

  it('hash spellings for Windows paths and trailing separators', () => {
    expect(hashCandidates('/work/game/')).toEqual([projectHash('/work/game')]);
    const w = hashCandidates('C:\\Users\\u\\game\\');
    expect(w).toContain(projectHash('C:\\Users\\u\\game'));
    expect(w).toContain(projectHash('C:/Users/u/game'));
  });

  it('detect: data folder present -> found', async () => {
    const { home } = setup();
    const host = linuxHost(home);
    expect((await new GeminiCliAdapter(host).detect(makeDetectEnv(host, { enabled: 'auto' }, projects))).found).toBe(true);
    const empty = mkTmp(); cleanup.push(() => rmTmp(empty));
    expect((await new GeminiCliAdapter(linuxHost(empty)).detect(makeDetectEnv(linuxHost(empty), { enabled: 'auto' }, projects))).found).toBe(false);
  });
});
