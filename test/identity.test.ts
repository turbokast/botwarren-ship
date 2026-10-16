/**
 * Model maker/line + reasoning effort, end to end in the ship agent: readers -> scanners -> adapter host -> public projection.
 * Fixtures mimic real Claude Code transcripts (top-level `effort`, `requestedModel`, `message.model`) and Codex `turn_context` lines.
 * The raw model id must never leave: only the classified closed values do.
 */
import { appendFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CanonicalEvent, projectPublic, type CanonicalEventInput } from '../src/vendor/core/contract.ts';
import { ProjectAttributor } from '../src/attribution.ts';
import { SessionScanner } from '../src/sessionscan.ts';
import { identityOfLine, readTailIdentity } from '../src/readers/sessionlog.ts';
import { ClaudeCodeAdapter, CodexAdapter } from '../src/adapters/claude.ts';
import { assistantLine, line, SECRET_PROMPT, tmp, turnContext, writeCodex, writeSession, writeSub } from './helpers.ts';
import { linuxHost, makeHost } from './adapters/kit.ts';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const CWD = '/work/demo/game';
const MASTER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
type Obs = Extract<CanonicalEventInput, { type: 'session.observed' }>;
const obs = (evs: CanonicalEventInput[]) => evs.filter((e) => e.type === 'session.observed') as Obs[];
const attributor = () => new ProjectAttributor([{ id: 'demo1', repoPaths: [CWD] }], async () => null);

describe('Claude transcript line -> identity', () => {
  it('uses message.model first, then requestedModel; ignores <synthetic>; effort from the top level', () => {
    expect(identityOfLine({ effort: 'medium', requestedModel: 'claude-opus-5-5', message: { model: 'claude-opus-5-5-20261001' } })).toEqual({ maker: 'anthropic', model: 'opus', effort: 'medium' });
    expect(identityOfLine({ requestedModel: 'claude-sonnet-5-5', message: { model: '<synthetic>' } })).toEqual({ maker: 'anthropic', model: 'sonnet' });
    expect(identityOfLine({ perTurnEffort: 'high', message: { model: 'kimi-k2-thinking' } })).toEqual({ maker: 'moonshot', model: 'kimi', effort: 'high' });
    expect(identityOfLine({ effort: 'bogus-level' })).toEqual({});
    expect(identityOfLine({ message: { content: 'x' } })).toEqual({});
  });
  it('the newest assistant line wins; absent stays absent; message text never appears in the result', () => {
    const root = tmp();
    const body = line({ type: 'user', message: { role: 'user', content: SECRET_PROMPT } })
      + assistantLine({ model: 'claude-haiku-4-5', effort: 'low' }) + assistantLine({ model: 'claude-opus-5-5-20261001', requested: 'claude-opus-5-5', effort: 'high' })
      + line({ type: 'user', message: { role: 'user', content: 'later user line' } });
    const f = writeSession(root, 'p', MASTER, CWD, NOW, body);
    const id = readTailIdentity(f);
    expect(id).toEqual({ maker: 'anthropic', model: 'opus', effort: 'high' });
    expect(JSON.stringify(id)).not.toMatch(/20261001|SECRET/);
    const g = writeSession(root, 'p', 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', CWD, NOW, line({ type: 'user', message: { role: 'user', content: 'hi' } }));
    expect(readTailIdentity(g)).toEqual({});
    expect(readTailIdentity(join(root, 'missing.jsonl'))).toEqual({});
  });
});

describe('SessionScanner (Claude main sessions)', () => {
  it('emits maker/line/effort, and re-observes when the effort or model changes (not otherwise)', async () => {
    const root = tmp();
    const f = writeSession(root, 'p', MASTER, CWD, at(-2000), line({ cwd: CWD, type: 'user', message: { role: 'user', content: 'x' } }) + assistantLine({ cwd: CWD, model: 'claude-opus-5-5', effort: 'medium' }));
    const s = new SessionScanner({ dirs: [root], instance: 'inst', attributor: attributor() });
    const first = obs(await s.tick(NOW));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ harness: 'claude', maker: 'anthropic', model: 'opus', effort: 'medium' });
    expect(CanonicalEvent.safeParse(first[0]).success).toBe(true);
    // nothing changed (the log is written to, but the same model/effort): no new observation inside the reobserve window
    appendFileSync(f, assistantLine({ cwd: CWD, model: 'claude-opus-5-5', effort: 'medium' })); utimesSync(f, at(11_000), at(11_000));
    expect(obs(await s.tick(at(12_000)))).toHaveLength(0);
    // effort changes mid-session
    appendFileSync(f, assistantLine({ cwd: CWD, model: 'claude-opus-5-5', effort: 'xhigh' })); utimesSync(f, at(22_000), at(22_000));
    const changed = obs(await s.tick(at(23_000)));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ maker: 'anthropic', model: 'opus', effort: 'xhigh' });
    // model switches
    appendFileSync(f, assistantLine({ cwd: CWD, model: 'claude-sonnet-5-5', effort: 'xhigh' })); utimesSync(f, at(34_000), at(34_000));
    const switched = obs(await s.tick(at(35_000)));
    expect(switched).toHaveLength(1);
    expect(switched[0]).toMatchObject({ model: 'sonnet', effort: 'xhigh' });
  });
  it('a log with no assistant line yet carries no model and no effort', async () => {
    const root = tmp();
    writeSession(root, 'p', MASTER, CWD, at(-2000), line({ cwd: CWD, type: 'user', message: { role: 'user', content: 'x' } }));
    const s = new SessionScanner({ dirs: [root], instance: 'inst', attributor: attributor() });
    const o = obs(await s.tick(NOW));
    expect(o[0]!.maker).toBeUndefined(); expect(o[0]!.model).toBeUndefined(); expect(o[0]!.effort).toBeUndefined();
  });
  it('sub-agents: classified through core classifyModel with effort from their own log, and re-observed on change', async () => {
    const root = tmp();
    writeSession(root, 'p', MASTER, CWD, at(-1000));
    const sub = writeSub(root, 'p', MASTER, 'h1', CWD, at(-1000), 'claude-haiku-4-5');
    const s = new SessionScanner({ dirs: [root], instance: 'inst', attributor: attributor() });
    const first = obs(await s.tick(NOW)).find((e) => e.role === 'subagent')!;
    expect(first).toMatchObject({ maker: 'anthropic', model: 'haiku' });
    expect(first.effort).toBeUndefined();
    appendFileSync(sub, assistantLine({ cwd: CWD, model: 'claude-haiku-4-5', requested: 'claude-haiku-4-5', effort: 'low' })); utimesSync(sub, at(14_000), at(14_000));
    const second = obs(await s.tick(at(15_000))).find((e) => e.role === 'subagent')!;
    expect(second).toMatchObject({ maker: 'anthropic', model: 'haiku', effort: 'low' });
  });
});

describe('adapter host: identity merge, public projection, canary', () => {
  const policy = { publicProjects: new Set(['demo1']) as unknown as ReadonlySet<never>, demoMode: false, pseudonym: (_ns: string, k: string) => Buffer.from(k).toString('hex').slice(0, 8).padEnd(8, '0').replace(/[^0-9a-f]/g, '0') };

  it('publishes only closed values: raw model ids (Claude, Kimi through Claude, Codex) never appear anywhere in events or public drafts', async () => {
    const home = tmp();
    const claudeRoot = join(home, '.claude', 'projects'); const codexRoot = join(home, '.codex', 'sessions');
    writeSession(claudeRoot, 'p', MASTER, CWD, at(-1000), line({ cwd: CWD, type: 'user', message: { role: 'user', content: 'x' } })
      + assistantLine({ cwd: CWD, model: 'claude-opus-5-5-20261001', requested: 'claude-opus-5-5-20261001', effort: 'high' }));
    writeSession(claudeRoot, 'p', 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee', CWD, at(-1000), assistantLine({ cwd: CWD, model: 'kimi-k2-thinking', effort: 'max' }));
    writeCodex(codexRoot, NOW, 'x', { id: '019abcde-0001-0002', cwd: CWD, originator: 'codex_exec', source: 'exec' }, at(-1000), turnContext('gpt-6.1-sol-20261001', 'Ultra'));
    const claude = new ClaudeCodeAdapter([claudeRoot]);
    const { host, logs } = makeHost({ adapters: [{ adapter: claude }, { adapter: new CodexAdapter([codexRoot], () => claude.mains()) }], host: linuxHost(home), projects: [{ id: 'demo1', repoPaths: [CWD] }] });
    const evs = await host.tick(NOW);
    const o = obs(evs);
    expect(o).toHaveLength(3);
    const by = (p: (e: Obs) => boolean) => o.find(p)!;
    expect(by((e) => e.sessionKey === `claude:${MASTER}`)).toMatchObject({ maker: 'anthropic', model: 'opus', effort: 'high' });
    expect(by((e) => e.sessionKey === 'claude:cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee')).toMatchObject({ maker: 'moonshot', model: 'kimi', effort: 'max' });
    expect(by((e) => e.harness === 'codex')).toMatchObject({ maker: 'openai', model: 'sol', effort: 'max' });
    const blob = JSON.stringify(evs) + logs.join('\n');
    for (const raw of ['20261001', 'k2-thinking', 'claude-opus-5-5', '6.1', SECRET_PROMPT]) expect(blob).not.toContain(raw);
    for (const e of evs) {
      const parsed = CanonicalEvent.parse(e);
      const pub = projectPublic(parsed, policy);
      const text = JSON.stringify(pub);
      for (const raw of ['20261001', 'k2-thinking', 'claude-opus-5-5', '6.1']) expect(text).not.toContain(raw);
      if (pub.ok && parsed.type === 'session.observed') expect(pub.draft).toMatchObject({ kind: 'worker', ...(parsed.maker ? { maker: parsed.maker } : {}), ...(parsed.effort ? { effort: parsed.effort } : {}) });
    }
  });

  it('a change of effort reaches the host as a new merged observation, an unchanged poll does not', async () => {
    const home = tmp();
    const claudeRoot = join(home, '.claude', 'projects');
    const f = writeSession(claudeRoot, 'p', MASTER, CWD, at(-1000), assistantLine({ cwd: CWD, model: 'claude-opus-5-5', effort: 'medium' }));
    const { host } = makeHost({ adapters: [{ adapter: new ClaudeCodeAdapter([claudeRoot]) }], host: linuxHost(home), projects: [{ id: 'demo1', repoPaths: [CWD] }] });
    expect(obs(await host.tick(NOW))[0]).toMatchObject({ effort: 'medium' });
    expect(obs(await host.tick(at(5_000)))).toHaveLength(0);
    appendFileSync(f, assistantLine({ cwd: CWD, model: 'claude-opus-5-5', effort: 'high' })); utimesSync(f, at(14_000), at(14_000));
    const c = obs(await host.tick(at(15_000)));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ effort: 'high', maker: 'anthropic', model: 'opus' });
  });
});
