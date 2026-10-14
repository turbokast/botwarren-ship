import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPENCODE_ALLOW, OpenCodeAdapter, verifyOpencodeShape } from '../../src/adapters/opencode.ts';
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

describe('OpenCodeAdapter (documented shapes, UNVERIFIED live)', () => {
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
    expect(new Set(srv.requests.map((r) => r.url))).toEqual(new Set(['/session/status', '/session']));
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
    for (const p of ['/session/ses_a/message', '/session/ses_a/diff', '/session/ses_a', '/event', '/file']) await expect(http.get(p)).rejects.toBeInstanceOf(PolicyError);
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
