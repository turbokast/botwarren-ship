import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CanonicalEvent, type CanonicalEventInput } from '../src/vendor/core/contract.ts';
import { ProjectAttributor } from '../src/attribution.ts';
import { SessionScanner, readNewestCwd } from '../src/sessionscan.ts';
import { SECRET_CODE, SECRET_PROMPT, SECRET_TOKEN, appendSession, claudeLines, line, tmp, writeSession } from './helpers.ts';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const projects = [{ id: 'demo1', repoPaths: ['C:\\Users\\DEMO1\\Code\\Game'] }];
const WIN_CWD = 'C:\\Users\\DEMO1\\Code\\Game';

const scanner = (root: string, extra: Partial<ConstructorParameters<typeof SessionScanner>[0]> = {}) =>
  new SessionScanner({ dirs: [root], instance: 'inst', attributor: new ProjectAttributor(projects, async () => null), ...extra });
const observed = (evs: CanonicalEventInput[]) => evs.filter((e) => e.type === 'session.observed') as Extract<CanonicalEventInput, { type: 'session.observed' }>[];

describe('SessionScanner', () => {
  it('infers working / idle / ended from write times, attributing a Windows cwd case-insensitively', async () => {
    const root = tmp();
    const s = scanner(root);
    const f = writeSession(root, 'c--Users-DEMO1-Code-Game', 'aaaa-1', WIN_CWD.toUpperCase(), ago(5_000));
    let o = observed(await s.tick(NOW));
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ harness: 'claude', status: 'working', projectId: 'demo1', attribution: { method: 'cwd_registry', certainty: 'inferred' } });

    // quiet 21 s .. 29 min -> idle
    const t1 = new Date(NOW.getTime() + 60_000);
    utimesSync(f, new Date(t1.getTime() - 21_000), new Date(t1.getTime() - 21_000));
    o = observed(await s.tick(t1));
    expect(o).toHaveLength(1);
    expect(o[0]!.status).toBe('idle');

    const t2 = new Date(NOW.getTime() + 29 * 60_000);
    utimesSync(f, NOW, NOW);
    o = observed(await s.tick(t2));
    expect(o.every((e) => e.status === 'idle')).toBe(true);

    // > 30 min of silence -> ended, then forgotten
    const t3 = new Date(NOW.getTime() + 31 * 60_000);
    const evs = await s.tick(t3);
    const ended = evs.filter((e) => e.type === 'session.ended');
    expect(ended).toHaveLength(1);
    expect(s.trackedCount).toBe(0);
    expect(await s.tick(new Date(t3.getTime() + 3000))).toEqual([]);

    // written again -> a fresh observation
    const t4 = new Date(t3.getTime() + 60_000);
    utimesSync(f, t4, t4);
    const back = observed(await s.tick(new Date(t4.getTime() + 16_000)));
    expect(back).toHaveLength(1);
  });

  it('re-observes an unchanged session every 120 s only', async () => {
    const root = tmp();
    const s = scanner(root);
    const f = writeSession(root, 'p', 'bbbb-1', WIN_CWD, ago(10 * 60_000));
    expect(observed(await s.tick(NOW))).toHaveLength(1);
    expect(observed(await s.tick(new Date(NOW.getTime() + 3_000)))).toHaveLength(0);
    expect(observed(await s.tick(new Date(NOW.getTime() + 119_000)))).toHaveLength(0);
    expect(observed(await s.tick(new Date(NOW.getTime() + 121_000)))).toHaveLength(1);
    void f;
  });

  it('keeps an unattributed cwd unattributed (never a project id)', async () => {
    const root = tmp();
    const s = scanner(root);
    writeSession(root, 'p', 'cccc-1', 'C:\\Users\\DEMO1\\Documents\\private-notes', ago(2_000));
    const o = observed(await s.tick(NOW));
    expect(o[0]).toMatchObject({ projectId: null, attribution: { method: 'none' } });
  });

  it('handles a swarm of 25 concurrent sessions cheaply, with bounded reads', async () => {
    const root = tmp();
    const s = scanner(root);
    for (let i = 0; i < 25; i++) writeSession(root, i % 2 ? 'proj-a' : 'proj-b', `swarm-${i}`, i < 20 ? `${WIN_CWD}\\ui\\comp${i}` : 'C:\\elsewhere', ago(1_000 + i * 500));
    const t0 = performance.now();
    const evs = await s.tick(NOW);
    const o = observed(evs);
    expect(o).toHaveLength(25);
    expect(o.filter((e) => e.projectId === 'demo1')).toHaveLength(20);
    expect(o.filter((e) => e.projectId === null)).toHaveLength(5);
    expect(new Set(o.map((e) => e.sessionKey)).size).toBe(25);
    // steady-state polls only stat files
    const t1 = performance.now();
    for (let i = 1; i <= 10; i++) await s.tick(new Date(NOW.getTime() + i * 3000));
    expect(performance.now() - t1).toBeLessThan(2000);
    expect(performance.now() - t0).toBeLessThan(5000);
    // every event is schema-valid
    for (const e of evs) expect(CanonicalEvent.safeParse(e).success).toBe(true);
  });

  it('caps tracked sessions', async () => {
    const root = tmp();
    const s = scanner(root, { maxSessions: 5 });
    for (let i = 0; i < 12; i++) writeSession(root, 'p', `cap-${i}`, WIN_CWD, ago(1000));
    await s.tick(NOW);
    expect(s.trackedCount).toBe(5);
  });

  it('ignores logs older than 30 min, non-jsonl files and symlinks; finds subagent logs', async () => {
    const root = tmp();
    const s = scanner(root);
    writeSession(root, 'p', 'old-1', WIN_CWD, ago(31 * 60_000));
    writeFileSync(join(root, 'p', 'notes.txt'), 'x');
    const real = writeSession(root, 'p', 'real-1', WIN_CWD, ago(1000));
    symlinkSync(real, join(root, 'p', 'link-1.jsonl'));
    mkdirSync(join(root, 'p', 'real-1', 'subagents'), { recursive: true });
    const sub = join(root, 'p', 'real-1', 'subagents', 'agent-xyz.jsonl');
    writeFileSync(sub, claudeLines(WIN_CWD));
    utimesSync(sub, ago(1000), ago(1000));
    const o = observed(await s.tick(NOW));
    expect(o.map((e) => e.sessionKey).sort()).toEqual(['claude:real-1', 'claude:real-1/agent-xyz']);
  });

  it('reads the newest cwd from the tail only', () => {
    const root = tmp();
    const f = writeSession(root, 'p', 'tail-1', 'C:\\old', ago(1000), line({ cwd: 'C:\\old' }) + 'x'.repeat(200_000) + '\n' + line({ cwd: 'C:\\new\\place', type: 'user' }) + '{"cwd":"C:\\\\trunc');
    expect(readNewestCwd(f)).toBe('C:\\new\\place');
    expect(readNewestCwd(join(root, 'missing.jsonl'))).toBeNull();
  });

  it('emits tool_error and step activity from the log tail without any content', async () => {
    const root = tmp();
    const s = scanner(root);
    const f = writeSession(root, 'p', 'act-1', WIN_CWD, ago(1000));
    await s.tick(NOW); // tail starts at EOF
    const t = new Date(NOW.getTime() + 3000);
    appendSession(f,
      line({ cwd: WIN_CWD, timestamp: t.toISOString(), message: { content: [{ type: 'thinking', thinking: SECRET_PROMPT }] } }) +
      line({ cwd: WIN_CWD, timestamp: t.toISOString(), message: { content: [{ type: 'tool_use', id: 'tuX', name: 'Bash', input: { command: SECRET_TOKEN } }] } }) +
      line({ cwd: WIN_CWD, timestamp: t.toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'tuX', is_error: true, content: `boom ${SECRET_CODE}` }] } }), t);
    const evs = await s.tick(t);
    const act = evs.filter((e) => e.type === 'session.activity');
    expect(act.some((e) => (e as { kind: string }).kind === 'tool_error')).toBe(true);
    expect(act.some((e) => (e as { kind: string }).kind === 'step')).toBe(true);
    for (const e of evs) { expect(e.source).toBe('collector'); expect(CanonicalEvent.safeParse(e).success).toBe(true); }
  });

  it('never puts prompt, code or token text into ANY emitted event', async () => {
    const root = tmp();
    const s = scanner(root);
    const f = writeSession(root, 'p', 'leak-1', WIN_CWD, ago(1000));
    const all = [...(await s.tick(NOW))];
    const t = new Date(NOW.getTime() + 3000);
    appendSession(f, claudeLines(WIN_CWD, 5) + line({ cwd: WIN_CWD, timestamp: t.toISOString(), message: { content: [{ type: 'tool_use', id: 'z', name: 'Edit', input: { new_string: SECRET_CODE } }, { type: 'tool_result', tool_use_id: 'z', is_error: true, content: SECRET_PROMPT }] } }), t);
    all.push(...(await s.tick(t)));
    expect(all.length).toBeGreaterThan(1);
    const blob = JSON.stringify(all);
    for (const secret of [SECRET_PROMPT, SECRET_TOKEN, SECRET_CODE, 'hunter2', 'somewhere']) expect(blob).not.toContain(secret);
  });
});
