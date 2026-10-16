import { appendFileSync, utimesSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CanonicalEvent, type CanonicalEventInput } from '../src/vendor/core/contract.ts';
import { ProjectAttributor } from '../src/attribution.ts';
import { CodexScanner, candidateDays, readCodexIdentity, readCodexMeta } from '../src/codex.ts';
import type { MainInfo } from '../src/sessionscan.ts';
import { SECRET_CODE, SECRET_INSTRUCTIONS, SECRET_PROMPT, tmp, turnContext, writeCodex } from './helpers.ts';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const at = (ms: number) => new Date(NOW.getTime() + ms);
const WIN_CWD = 'C:\\Users\\DEMO1\\Code\\Game';
type Obs = Extract<CanonicalEventInput, { type: 'session.observed' }>;
const obs = (evs: CanonicalEventInput[]) => evs.filter((e) => e.type === 'session.observed') as Obs[];
const scanner = (root: string) => new CodexScanner({ dirs: [root], instance: 'inst', attributor: new ProjectAttributor([{ id: 'demo1', repoPaths: [WIN_CWD] }], async () => null) });
const master = (key: string, ageMs: number, projectId: string | null = 'demo1'): MainInfo => ({ key, projectId, mtimeMs: NOW.getTime() - ageMs });
const exec = (id: string, cwd = WIN_CWD) => ({ id, cwd, originator: 'codex_exec', source: 'exec' });
const cli = (id: string, cwd = WIN_CWD) => ({ id, cwd, originator: 'codex_cli_rs', source: 'cli' });

describe('Codex meta', () => {
  it('reads only id/cwd/originator/source from the first line, never base_instructions or messages', () => {
    const root = tmp();
    const f = writeCodex(root, NOW, 'a', exec('019aaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), ago(1000));
    const m = readCodexMeta(f);
    expect(m).toEqual({ id: '019aaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: WIN_CWD, originator: 'codex_exec', source: 'exec' });
    expect(JSON.stringify(m)).not.toContain(SECRET_INSTRUCTIONS);
    expect(readCodexMeta(f.replace('rollout-a', 'rollout-missing'))).toBeNull();
  });
  it('ignores non-string source and a first line that is not session_meta', () => {
    const root = tmp();
    const f = writeCodex(root, NOW, 'b', { id: 'abcdefgh-1', cwd: WIN_CWD, source: { subagent: 'x' } }, ago(1000));
    expect(readCodexMeta(f)).toEqual({ id: 'abcdefgh-1', cwd: WIN_CWD });
  });
  it('lists day folders around now (local and UTC)', () => {
    expect(candidateDays(NOW)).toContain('2026/10/13');
    expect(candidateDays(NOW)).toContain('2026/10/12');
  });
});

describe('CodexScanner', () => {
  it('emits harness=codex, the observed model maker/line + effort, inferred, attributed from the meta cwd (Windows path, case-insensitive)', async () => {
    const root = tmp();
    const s = scanner(root);
    writeCodex(root, NOW, 'a', exec('019aaaaa-0001', WIN_CWD.toUpperCase() + '\\sub'), ago(3000), turnContext('gpt-6.1-sol', 'high'));
    const evs = await s.tick(NOW, []);
    for (const e of evs) expect(CanonicalEvent.safeParse(e).success).toBe(true);
    const o = obs(evs);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ sessionKey: 'codex:019aaaaa-0001', harness: 'codex', maker: 'openai', model: 'sol', effort: 'high', status: 'working', projectId: 'demo1', role: 'main', attribution: { method: 'cwd_registry', certainty: 'inferred' } });
    expect(o[0]!.parentKey).toBeUndefined();
  });

  it('keeps an unknown cwd unattributed', async () => {
    const root = tmp();
    const s = scanner(root);
    writeCodex(root, NOW, 'a', exec('019aaaaa-0002', 'C:\\Users\\DEMO1\\Documents\\notes'), ago(3000));
    const o = obs(await s.tick(NOW, [master('claude:m1', 1000)]));
    expect(o[0]).toMatchObject({ projectId: null, role: 'main' });
  });

  it('pairs with the most recently written active master of the same project (written within 2 min)', async () => {
    const root = tmp();
    const s = scanner(root);
    writeCodex(root, NOW, 'a', exec('019aaaaa-0003'), ago(3000));
    const mains = [master('claude:old', 90_000), master('claude:fresh', 10_000), master('claude:other-project', 1000, 'other'), master('claude:stale', 150_000)];
    const o = obs(await s.tick(NOW, mains));
    expect(o[0]).toMatchObject({ role: 'pair', parentKey: 'claude:fresh', harness: 'codex' });
  });

  it('is a plain main when no master of its project was written in the last 2 minutes', async () => {
    const root = tmp();
    const s = scanner(root);
    writeCodex(root, NOW, 'a', exec('019aaaaa-0004'), ago(3000));
    const o = obs(await s.tick(NOW, [master('claude:stale', 121_000), master('claude:elsewhere', 1000, 'other')]));
    expect(o[0]).toMatchObject({ role: 'main' });
  });

  it('keeps the pairing sticky even when another master becomes more recent or the first goes quiet', async () => {
    const root = tmp();
    const s = scanner(root);
    const f = writeCodex(root, NOW, 'a', cli('019aaaaa-0005'), ago(3000));
    let o = obs(await s.tick(NOW, [master('claude:A', 5000)]));
    expect(o[0]).toMatchObject({ role: 'pair', parentKey: 'claude:A' });
    const later = at(130_000);
    utimesSync(f, at(120_000), at(120_000));
    o = obs(await s.tick(later, [{ key: 'claude:A', projectId: 'demo1', mtimeMs: later.getTime() - 100_000 }, { key: 'claude:B', projectId: 'demo1', mtimeMs: later.getTime() - 1000 }]));
    expect(o).toHaveLength(1); // re-observation after 120 s
    expect(o[0]).toMatchObject({ role: 'pair', parentKey: 'claude:A' });
  });

  it('upgrades a lone main to pair when a master becomes active, then stays paired', async () => {
    const root = tmp();
    const s = scanner(root);
    writeCodex(root, NOW, 'a', cli('019aaaaa-0006'), ago(3000));
    expect(obs(await s.tick(NOW, []))[0]).toMatchObject({ role: 'main' });
    const t = at(3000);
    const o = obs(await s.tick(t, [{ key: 'claude:A', projectId: 'demo1', mtimeMs: t.getTime() - 1000 }]));
    expect(o[0]).toMatchObject({ role: 'pair', parentKey: 'claude:A' });
  });

  it('ends a `codex exec` run 2 minutes after its last write, but an interactive session only after 30 min', async () => {
    const root = tmp();
    const s = scanner(root);
    writeCodex(root, NOW, 'x', exec('019aaaaa-00e1'), ago(1000));
    writeCodex(root, NOW, 'i', cli('019aaaaa-00c1'), ago(1000));
    expect(obs(await s.tick(NOW, [])).map((e) => e.sessionKey).sort()).toEqual(['codex:019aaaaa-00c1', 'codex:019aaaaa-00e1']);
    const ended = (await s.tick(at(125_000), [])).filter((e) => e.type === 'session.ended') as { sessionKey: string }[];
    expect(ended.map((e) => e.sessionKey)).toEqual(['codex:019aaaaa-00e1']);
    const ended2 = (await s.tick(at(31 * 60_000), [])).filter((e) => e.type === 'session.ended') as { sessionKey: string }[];
    expect(ended2.map((e) => e.sessionKey)).toEqual(['codex:019aaaaa-00c1']);
  });

  it('never observes an old finished exec run or files older than 30 min', async () => {
    const root = tmp();
    const s = scanner(root);
    writeCodex(root, NOW, 'x', exec('019aaaaa-0f01'), ago(5 * 60_000));
    writeCodex(root, NOW, 'i', cli('019aaaaa-0f02'), ago(31 * 60_000));
    expect(await s.tick(NOW, [])).toEqual([]);
    expect(await s.tick(at(11_000), [])).toEqual([]);
  });

  it('never emits base_instructions, prompts or code in any event', async () => {
    const root = tmp();
    const s = scanner(root);
    writeCodex(root, NOW, 'a', exec('019aaaaa-0007'), ago(2000));
    const all = [...(await s.tick(NOW, [master('claude:A', 1000)])), ...(await s.tick(at(3000), [])), ...(await s.tick(at(130_000), []))];
    expect(all.length).toBeGreaterThan(1);
    const blob = JSON.stringify(all);
    for (const x of [SECRET_INSTRUCTIONS, SECRET_PROMPT, SECRET_CODE, 'BASE_INSTRUCTIONS']) expect(blob).not.toContain(x);
  });
});

describe('Codex model + effort (newest turn_context only)', () => {
  it('reads maker/line and effort of the NEWEST turn_context, from payload or collaboration_mode, never the instructions', () => {
    const root = tmp();
    const f = writeCodex(root, NOW, 'a', exec('019aaaaa-1111'), ago(1000), turnContext('gpt-6-astra', 'low') + turnContext('gpt-6.1-sol-20261001', 'Ultra'));
    const id = readCodexIdentity(f);
    expect(id).toEqual({ maker: 'openai', model: 'sol', effort: 'max' });
    expect(JSON.stringify(id)).not.toContain('20261001');
    expect(JSON.stringify(id)).not.toContain(SECRET_INSTRUCTIONS);
    expect(JSON.stringify(id)).not.toContain(SECRET_PROMPT);
  });
  it('nothing observed stays absent; session_meta reasoning_effort is a fallback for effort only', () => {
    const root = tmp();
    const f = writeCodex(root, NOW, 'b', exec('019aaaaa-2222'), ago(1000));
    expect(readCodexIdentity(f)).toEqual({});
    const g = writeCodex(root, NOW, 'c', { ...exec('019aaaaa-3333'), reasoning_effort: 'minimal' }, ago(1000));
    expect(readCodexMeta(g)?.effort).toBe('low');
  });
  it('no turn_context yet -> no model; re-observes once a turn is written and again when effort changes, never otherwise', async () => {
    const root = tmp();
    const s = scanner(root);
    const f = writeCodex(root, NOW, 'a', cli('019aaaaa-4444'), ago(3000));
    const first = obs(await s.tick(NOW, []));
    expect(first).toHaveLength(1);
    expect(first[0]!.model).toBeUndefined(); expect(first[0]!.maker).toBeUndefined(); expect(first[0]!.effort).toBeUndefined();
    appendFileSync(f, turnContext('gpt-6.1-sol', 'medium')); utimesSync(f, at(1000), at(1000));
    const second = obs(await s.tick(at(12_000), []));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ maker: 'openai', model: 'sol', effort: 'medium' });
    utimesSync(f, at(23_000), at(23_000)); // written again, same model and effort
    expect(obs(await s.tick(at(24_000), []))).toHaveLength(0);
    appendFileSync(f, turnContext('gpt-6.1-sol', 'high')); utimesSync(f, at(35_000), at(35_000));
    const third = obs(await s.tick(at(36_000), []));
    expect(third).toHaveLength(1);
    expect(third[0]).toMatchObject({ effort: 'high' });
    for (const e of third) expect(CanonicalEvent.safeParse(e).success).toBe(true);
  });
});
