import { utimesSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CanonicalEvent, type CanonicalEventInput } from '../src/vendor/core/contract.ts';
import { modelFamily, readLogMeta } from '../src/readers/subagents.ts';
import { ProjectAttributor } from '../src/attribution.ts';
import { SessionScanner } from '../src/sessionscan.ts';
import { SECRET_CODE, SECRET_PROMPT, SECRET_TOKEN, tmp, writeSession, writeSub } from './helpers.ts';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const at = (ms: number) => new Date(NOW.getTime() + ms);
const WIN_CWD = 'C:\\Users\\DEMO1\\Code\\Game';
const MASTER = '11111111-2222-3333-4444-555555555555';
type Obs = Extract<CanonicalEventInput, { type: 'session.observed' }>;
const obs = (evs: CanonicalEventInput[]) => evs.filter((e) => e.type === 'session.observed') as Obs[];
const scanner = (root: string) => new SessionScanner({ dirs: [root], instance: 'inst', attributor: new ProjectAttributor([{ id: 'demo1', repoPaths: [WIN_CWD] }], async () => null) });

describe('modelFamily / readLogMeta', () => {
  it('maps requestedModel strings to a family', () => {
    expect(modelFamily('haiku')).toBe('haiku');
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelFamily('claude-SONNET-4-5')).toBe('sonnet');
    expect(modelFamily('opus[1m]')).toBe('opus');
    expect(modelFamily('gemini-pro')).toBe('other');
    expect(modelFamily('')).toBeUndefined();
    expect(modelFamily(undefined)).toBeUndefined();
  });
  it('reads only the requested top-level key, from the head when the tail lacks it', () => {
    const root = tmp();
    const f = writeSub(root, 'p', MASTER, 'a1', WIN_CWD, ago(1000), 'claude-haiku-4-5');
    expect(readLogMeta(f, ['requestedModel'])).toEqual({ requestedModel: 'claude-haiku-4-5' });
    expect(readLogMeta(f, ['nope'])).toEqual({});
  });
});

describe('sub-agents (Task tool) in the ship scanner', () => {
  it('turns <master>/subagents/agent-*.jsonl into role=subagent sessions linked to the master, with model family', async () => {
    const root = tmp();
    const s = scanner(root);
    writeSession(root, 'proj', MASTER, WIN_CWD, ago(60_000)); // master: idle
    writeSub(root, 'proj', MASTER, 'h1', WIN_CWD, ago(2000), 'haiku');
    writeSub(root, 'proj', MASTER, 's1', WIN_CWD, ago(3000), 'claude-sonnet-4-5');
    writeSub(root, 'proj', MASTER, 'o1', WIN_CWD, ago(4000), 'opus');
    writeSub(root, 'proj', MASTER, 'x1', WIN_CWD, ago(5000)); // no requestedModel
    const evs = await s.tick(NOW);
    for (const e of evs) expect(CanonicalEvent.safeParse(e).success).toBe(true);
    const o = obs(evs);
    const master = o.find((e) => e.sessionKey === `claude:${MASTER}`)!;
    expect(master).toMatchObject({ role: 'main', status: 'idle', projectId: 'demo1' });
    expect(master.parentKey).toBeUndefined();
    const subs = o.filter((e) => e.role === 'subagent');
    expect(subs).toHaveLength(4);
    for (const e of subs) expect(e).toMatchObject({ harness: 'claude', status: 'working', projectId: 'demo1', parentKey: `claude:${MASTER}`, attribution: { method: 'cwd_registry', certainty: 'inferred' } });
    expect(Object.fromEntries(subs.map((e) => [e.sessionKey.split('/')[1], e.model ?? null]))).toEqual({ 'agent-h1': 'haiku', 'agent-s1': 'sonnet', 'agent-o1': 'opus', 'agent-x1': null });
    expect(subs.map((e) => e.sessionKey)).toContain(`claude:${MASTER}/agent-h1`);
  });

  it('ends a sub-agent after 2 minutes of silence (not 30), while its master stays', async () => {
    const root = tmp();
    const s = scanner(root);
    writeSession(root, 'proj', MASTER, WIN_CWD, ago(1000));
    const f = writeSub(root, 'proj', MASTER, 'h1', WIN_CWD, ago(2000), 'haiku');
    await s.tick(NOW);
    expect(s.subagentCount).toBe(1);
    utimesSync(f, NOW, NOW); // last write at NOW
    let evs = await s.tick(at(21_000));
    expect(obs(evs).find((e) => e.role === 'subagent')).toMatchObject({ status: 'idle' });
    evs = await s.tick(at(119_000));
    expect(evs.some((e) => e.type === 'session.ended')).toBe(false);
    evs = await s.tick(at(123_000));
    const ended = evs.filter((e) => e.type === 'session.ended') as { sessionKey: string }[];
    expect(ended.map((e) => e.sessionKey)).toEqual([`claude:${MASTER}/agent-h1`]);
    expect(s.subagentCount).toBe(0);
    expect(obs(evs).some((e) => e.sessionKey === `claude:${MASTER}`)).toBe(false); // master unaffected (not re-emitted yet)
  });

  it('ignores sub-agent logs older than 2 min, non agent-* files and symlinks; ends sub-agents when the master ends', async () => {
    const root = tmp();
    const s = scanner(root);
    const master = writeSession(root, 'proj', MASTER, WIN_CWD, ago(1000));
    writeSub(root, 'proj', MASTER, 'old', WIN_CWD, ago(130_000), 'haiku');
    writeSub(root, 'proj', MASTER, 'new', WIN_CWD, ago(1000), 'haiku');
    const evs = await s.tick(NOW);
    expect(obs(evs).filter((e) => e.role === 'subagent').map((e) => e.sessionKey)).toEqual([`claude:${MASTER}/agent-new`]);
    // master silent for 31 min: both end
    utimesSync(master, ago(1000), ago(1000));
    const later = await s.tick(at(31 * 60_000));
    expect((later.filter((e) => e.type === 'session.ended') as { sessionKey: string }[]).map((e) => e.sessionKey).sort()).toEqual([`claude:${MASTER}`, `claude:${MASTER}/agent-new`]);
  });

  it('inherits "unattributed" from an unattributed master, and never leaks content', async () => {
    const root = tmp();
    const s = scanner(root);
    writeSession(root, 'proj', MASTER, 'C:\\Users\\DEMO1\\Documents\\private-notes', ago(1000));
    writeSub(root, 'proj', MASTER, 'h1', 'C:\\Users\\DEMO1\\Documents\\private-notes', ago(1000), 'haiku');
    const evs = await s.tick(at(0));
    expect(obs(evs).every((e) => e.projectId === null)).toBe(true);
    // `private` is the local-only ops detail (cwd is allowed there by design); everything else must be free of paths
    const shape = JSON.stringify(evs.map((e) => ({ ...e, private: undefined })));
    for (const x of [SECRET_PROMPT, SECRET_TOKEN, SECRET_CODE, 'hunter2']) expect(JSON.stringify(evs)).not.toContain(x);
    for (const x of ['private-notes', 'Users', 'DEMO1']) expect(shape).not.toContain(x);
  });
});
