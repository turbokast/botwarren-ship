import { describe, expect, it } from 'vitest';
import type { Adapter, AdapterId, Observation } from '../../src/adapters/api.ts';
import { safeKey } from '../../src/adapters/api.ts';
import { ended, linuxHost, makeHost, sessions } from './kit.ts';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const at = (s: number) => new Date(NOW.getTime() + s * 1000);
const UUID = '0b1c2d3e-aaaa-bbbb-cccc-0123456789ab';
const projects = [{ id: 'demo1', repoPaths: ['/work/game'] }];

/** An adapter whose observations are whatever the test says for the current round. */
function fake(id: AdapterId, rounds: Observation[][] | (() => Observation[]), opts: { throws?: boolean } = {}): Adapter {
  let i = 0;
  return {
    manifest: { id, apiVersion: 1, version: '1', platforms: ['linux'], reads: [], capabilities: { state: true, toolCategory: false, errors: false, subagents: false, tokens: false, hierarchy: false }, upstream: { name: id, tested: 't', verification: 'unverified' }, summary: id },
    detect: async () => ({ found: true, confidence: 'high' }),
    poll: async () => {
      if (opts.throws) throw Object.assign(new Error('boom /home/user/CANARY_PATH'), { code: 'EACCES' });
      return typeof rounds === 'function' ? rounds() : (rounds[Math.min(i++, rounds.length - 1)] ?? []);
    },
  };
}

const sess = (o: Partial<Extract<Observation, { kind: 'session' }>> & { key: string }): Observation => ({
  kind: 'session', tool: 'claude-code', harness: 'claude', status: 'working', projectId: 'demo1', certainty: 'inferred', correlate: [], ...o,
});

const run = (adapters: Adapter[]) => makeHost({ adapters: adapters.map((adapter) => ({ adapter })), host: linuxHost('/home/u'), projects });

describe('AdapterHost: validation and safety', () => {
  it('drops observations with unknown fields (no free-text smuggling) and unknown projects, counting them', async () => {
    const { host } = run([fake('claude-code', [[
      sess({ key: 'claude:aaaaaaaa-1' }),
      { ...sess({ key: 'claude:bad-1' }), title: 'free text' } as unknown as Observation,
      sess({ key: 'claude:bad-2', projectId: 'other-project' }),
    ]])]);
    const evs = await host.tick(NOW);
    expect(sessions(evs).map((e) => e.sessionKey)).toEqual(['claude:aaaaaaaa-1']);
    expect(host.statuses()[0]!.rejected).toBe(2);
  });

  it('normalises keys: anything that is not an id-looking token becomes a hash', async () => {
    expect(safeKey('claude:0b1c2d3e-aaaa')).toBe('claude:0b1c2d3e-aaaa');
    const h = safeKey('C:\\Users\\x\\CANARY secret path');
    expect(h).toMatch(/^h:[0-9a-f]{24}$/);
    const { host } = run([fake('claude-code', [[sess({ key: 'my secret CANARY title' })]])]);
    const evs = await host.tick(NOW);
    expect(sessions(evs)[0]!.sessionKey).toMatch(/^h:[0-9a-f]{24}$/);
    expect(JSON.stringify(evs)).not.toContain('CANARY');
  });

  it('isolates a throwing adapter and logs only an error code, never the message (which may hold a path)', async () => {
    const { host, logs } = run([fake('herdr', [], { throws: true }), fake('claude-code', [[sess({ key: 'claude:aaaaaaaa-2' })]])]);
    const evs = await host.tick(NOW);
    expect(sessions(evs)).toHaveLength(1);
    expect(logs.join('\n')).toContain('EACCES');
    expect(logs.join('\n')).not.toContain('CANARY');
    expect(host.statuses().find((s) => s.id === 'herdr')!.state).toBe('failed');
  });

  it('skips disabled adapters, and polls "auto" adapters only while detected', async () => {
    let found = false; let polls = 0;
    const a = fake('ninox', () => { polls++; return []; });
    const host = new (await import('../../src/adapters/host.ts')).AdapterHost({
      adapters: [{ adapter: a, settings: { enabled: 'auto' } }, { adapter: fake('opencode', () => { polls += 100; return []; }), settings: { enabled: false } }],
      detect: async () => ({ found }), instance: 'i', host: linuxHost('/h'), projects, log: () => {}, attribute: async () => null,
    });
    await host.tick(NOW);
    expect(polls).toBe(0);
    found = true;
    await host.tick(at(61)); // re-detection runs in the background and never blocks a tick
    await new Promise((r) => setTimeout(r, 20));
    await host.tick(at(62));
    expect(polls).toBe(1);
  });
});

describe('AdapterHost: merge and dedupe', () => {
  it('one crew member when Claude logs, Herdr and Ninox all see the same Claude session (claude_session_id join)', async () => {
    const claude = fake('claude-code', [[sess({ key: `claude:${UUID}`, status: 'idle', model: 'opus', correlate: [{ type: 'claude-session', id: UUID }], local: { cwd: '/work/game', log: 'x.jsonl' } })]]);
    const herdr = fake('herdr', [[sess({ key: `claude:${UUID}`, status: 'blocked', tool: 'claude-code', certainty: 'observed', correlate: [{ type: 'herdr-pane', id: 'default/p1' }, { type: 'claude-session', id: UUID }] })]]);
    const ninox = fake('ninox', [[sess({ key: 'ninox:s1', status: 'working', certainty: 'observed', correlate: [{ type: 'ninox-session', id: 's1' }, { type: 'claude-session', id: UUID }], local: { lifecycle: 'pr_open' } })]]);
    const { host } = run([claude, herdr, ninox]);
    const evs = await host.tick(NOW);
    const s = sessions(evs);
    expect(s).toHaveLength(1);
    expect(host.sessionCount).toBe(1);
    expect(s[0]).toMatchObject({ sessionKey: `claude:${UUID}`, status: 'blocked', model: 'opus', projectId: 'demo1', attribution: { certainty: 'observed' } });
    expect(s[0]!.private).toMatchObject({ adapters: 'claude-code+herdr+ninox', cwd: '/work/game', lifecycle: 'pr_open' });
  });

  it('the canonical key is the Claude session key regardless of which adapter reports first', async () => {
    const ninox = fake('ninox', [[sess({ key: 'ninox:s1', correlate: [{ type: 'ninox-session', id: 's1' }, { type: 'claude-session', id: UUID }] })]]);
    const { host } = run([ninox]);
    expect(sessions(await host.tick(NOW))[0]!.sessionKey).toBe(`claude:${UUID}`);
  });

  it('status authority: Ninox/Herdr beat a mtime guess from the log adapter; blocked from anyone wins', async () => {
    let claudeStatus: 'working' | 'idle' = 'working';
    let ninoxStatus: 'working' | 'idle' | 'blocked' = 'idle';
    const claude = fake('claude-code', () => [sess({ key: `claude:${UUID}`, status: claudeStatus, correlate: [{ type: 'claude-session', id: UUID }] })]);
    const ninox = fake('ninox', () => [sess({ key: 'ninox:s1', status: ninoxStatus, certainty: 'observed', correlate: [{ type: 'ninox-session', id: 's1' }, { type: 'claude-session', id: UUID }] })]);
    const { host } = run([claude, ninox]);
    expect(sessions(await host.tick(NOW))[0]!.status).toBe('idle');
    ninoxStatus = 'blocked'; claudeStatus = 'idle';
    expect(sessions(await host.tick(at(5)))[0]!.status).toBe('blocked');
  });

  it('hierarchy: a Ninox worker keeps its orchestrator as parent, resolved through the merged key', async () => {
    const U2 = '99999999-aaaa-bbbb-cccc-0123456789ab';
    const claude = fake('claude-code', [[sess({ key: `claude:${U2}`, correlate: [{ type: 'claude-session', id: U2 }] })]]);
    const ninox = fake('ninox', [[
      sess({ key: 'ninox:orch', correlate: [{ type: 'ninox-session', id: 'orch' }, { type: 'claude-session', id: UUID }] }),
      sess({ key: 'ninox:w1', role: 'subagent', parentKey: 'ninox:orch', correlate: [{ type: 'ninox-session', id: 'w1' }, { type: 'claude-session', id: U2 }] }),
    ]]);
    const { host } = run([claude, ninox]);
    const s = sessions(await host.tick(NOW));
    expect(s).toHaveLength(2);
    const worker = s.find((e) => e.sessionKey === `claude:${U2}`)!;
    expect(worker).toMatchObject({ role: 'subagent', parentKey: `claude:${UUID}` });
  });

  it('two records that turn out to be one session are folded and the loser is ended exactly once', async () => {
    let round = 0;
    const herdr = fake('herdr', () => (round === 0
      ? [sess({ key: 'pane:p1', tool: 'other', harness: 'unknown', certainty: 'observed', correlate: [{ type: 'herdr-pane', id: 'default/p1' }] })]
      : [sess({ key: 'pane:p1', tool: 'claude-code', certainty: 'observed', correlate: [{ type: 'herdr-pane', id: 'default/p1' }, { type: 'claude-session', id: UUID }] })]));
    const claude = fake('claude-code', () => [sess({ key: `claude:${UUID}`, correlate: [{ type: 'claude-session', id: UUID }] })]);
    const { host } = run([herdr, claude]);
    const r1 = await host.tick(NOW);
    expect(sessions(r1).map((e) => e.sessionKey).sort()).toEqual([`claude:${UUID}`, 'pane:p1']);
    round = 1;
    const r2 = await host.tick(at(5));
    expect(ended(r2).map((e) => e.sessionKey)).toEqual(['pane:p1']);
    expect(host.sessionCount).toBe(1);
    expect(ended(await host.tick(at(10)))).toHaveLength(0);
  });

  it('a merged session ends only when every adapter has dropped it', async () => {
    let claudeOn = true; let herdrOn = true;
    const claude = fake('claude-code', () => (claudeOn ? [sess({ key: `claude:${UUID}`, correlate: [{ type: 'claude-session', id: UUID }] })] : [{ kind: 'session.ended', key: `claude:${UUID}` }]));
    const herdr = fake('herdr', () => (herdrOn ? [sess({ key: `claude:${UUID}`, correlate: [{ type: 'claude-session', id: UUID }] })] : [{ kind: 'session.ended', key: `claude:${UUID}`, reason: 'pane_closed' }]));
    const { host } = run([claude, herdr]);
    await host.tick(NOW);
    claudeOn = false;
    expect(ended(await host.tick(at(5)))).toHaveLength(0);
    herdrOn = false;
    const last = ended(await host.tick(at(10)));
    expect(last).toHaveLength(1);
    expect(last[0]!.reason).toBe('pane_closed');
    expect(host.sessionCount).toBe(0);
  });

  it('does not re-emit an unchanged merged session more than every 120 s', async () => {
    const claude = fake('claude-code', () => [sess({ key: 'claude:aaaaaaaa-3' })]);
    const { host } = run([claude]);
    expect(sessions(await host.tick(NOW))).toHaveLength(1);
    expect(sessions(await host.tick(at(3)))).toHaveLength(0);
    expect(sessions(await host.tick(at(125)))).toHaveLength(1);
  });

  it('activity observations follow the merged key; activity for unknown sessions is dropped', async () => {
    const claude = fake('claude-code', [[
      sess({ key: `claude:${UUID}`, correlate: [{ type: 'claude-session', id: UUID }] }),
      { kind: 'activity', key: `claude:${UUID}`, act: 'tool_error', toolCategory: 'shell', at: NOW.toISOString() },
      { kind: 'activity', key: 'claude:nobody-1', act: 'step', toolCategory: 'other', step: 'editing', at: NOW.toISOString() },
    ]]);
    const evs = await run([claude]).host.tick(NOW);
    const act = evs.filter((e) => e.type === 'session.activity');
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({ sessionKey: `claude:${UUID}`, kind: 'tool_error', toolCategory: 'shell' });
  });
});
