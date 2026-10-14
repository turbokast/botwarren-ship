import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CanonicalEvent, type CanonicalEventInput } from '../src/vendor/core/contract.ts';
import { inferCategory, quoteForCmd, resolveSpawn, runWrapped } from '../src/runner.ts';
import { SECRET_TOKEN } from './helpers.ts';

function fakeSpawn(result: { code?: number | null; signal?: NodeJS.Signals | null; error?: boolean }) {
  const calls: { command: string; args: string[]; opts: SpawnOptions }[] = [];
  const impl = (command: string, args: string[], opts: SpawnOptions): ChildProcess => {
    calls.push({ command, args, opts });
    const ee = new EventEmitter();
    setImmediate(() => (result.error ? ee.emit('error', new Error('ENOENT')) : ee.emit('close', result.code ?? 0, result.signal ?? null)));
    return ee as unknown as ChildProcess;
  };
  return { impl, calls };
}

async function run(argv: string[], result: Parameters<typeof fakeSpawn>[0], o: { release?: boolean; reachable?: boolean; platform?: NodeJS.Platform } = {}) {
  const posted: CanonicalEventInput[][] = [];
  const warnings: string[] = [];
  const sp = fakeSpawn(result);
  let t = Date.parse('2026-10-13T12:00:00.000Z');
  const code = await runWrapped({
    argv, release: o.release ?? false, projectId: 'demo1', instance: 'inst',
    post: async (e) => { posted.push(e); return o.reachable ?? true; },
    now: () => new Date((t += 1000)), spawnImpl: sp.impl, warn: (m) => warnings.push(m), ...(o.platform ? { platform: o.platform } : {}),
    env: { PATH: '' },
  });
  return { code, posted, warnings, calls: sp.calls };
}
const flat = (p: CanonicalEventInput[][]) => p.flat();

describe('inferCategory', () => {
  it('classifies by command name; a release build is build, never deploy', () => {
    expect(inferCategory(['ninja'], false)).toBe('build');
    expect(inferCategory(['cmake', '--build', 'out'], false)).toBe('build');
    expect(inferCategory(['C:\\scripts\\build-release-win.bat'], true)).toBe('build');
    expect(inferCategory(['./release_mac.sh'], true)).toBe('build');
    expect(inferCategory(['ctest', '-j8'], false)).toBe('test');
    expect(inferCategory(['npm', 'run', 'test'], false)).toBe('test');
    expect(inferCategory(['run_tests.bat'], false)).toBe('test');
    expect(inferCategory(['eslint', '.'], false)).toBe('lint');
    expect(inferCategory(['do-something.cmd'], false)).toBe('other');
    for (const cmd of [['deploy.sh'], ['publish.bat'], ['release.sh']]) expect(inferCategory(cmd, true)).not.toBe('deploy');
  });
});

describe('botwarren run wrapper', () => {
  it('emits running then success for a passing build, with provider local and purpose integration', async () => {
    const r = await run(['ninja', '-C', 'out'], { code: 0 });
    expect(r.code).toBe(0);
    const evs = flat(r.posted);
    expect(evs).toHaveLength(4);
    for (const e of evs) expect(CanonicalEvent.safeParse(e).success).toBe(true);
    const pipes = evs.filter((e) => e.type === 'ci.pipeline') as Extract<CanonicalEventInput, { type: 'ci.pipeline' }>[];
    expect(pipes.map((p) => p.status)).toEqual(['running', 'success']);
    expect(pipes.every((p) => p.provider === 'local' && p.purpose === 'integration' && p.projectId === 'demo1')).toBe(true);
    expect(new Set(pipes.map((p) => p.pipelineKey)).size).toBe(1);
    expect(pipes[1]!.sourceUpdatedAt > pipes[0]!.sourceUpdatedAt).toBe(true);
    const jobs = evs.filter((e) => e.type === 'ci.job') as Extract<CanonicalEventInput, { type: 'ci.job' }>[];
    expect(jobs.map((j) => [j.category, j.status])).toEqual([['build', 'running'], ['build', 'success']]);
    expect(evs.some((e) => e.type === 'deploy.status')).toBe(false);
  });

  it('reports failed with the exit code propagated', async () => {
    const r = await run(['ctest'], { code: 3 });
    expect(r.code).toBe(3);
    const pipes = flat(r.posted).filter((e) => e.type === 'ci.pipeline') as { status: string }[];
    expect(pipes.map((p) => p.status)).toEqual(['running', 'failed']);
    expect((flat(r.posted).find((e) => e.type === 'ci.job') as { category: string }).category).toBe('test');
  });

  it('--release is a tag_release pipeline whose job is category build', async () => {
    const r = await run(['release-win.bat'], { code: 0 }, { release: true });
    const evs = flat(r.posted);
    expect((evs.find((e) => e.type === 'ci.pipeline') as { purpose: string }).purpose).toBe('tag_release');
    expect((evs.find((e) => e.type === 'ci.job') as { category: string }).category).toBe('build');
    expect(evs.some((e) => e.type === 'deploy.status')).toBe(false);
  });

  it('treats a signal / Ctrl-C as canceled and a missing command as failed(127)', async () => {
    const c = await run(['make'], { code: null, signal: 'SIGINT' });
    expect((flat(c.posted).filter((e) => e.type === 'ci.pipeline') as { status: string }[]).map((p) => p.status)).toEqual(['running', 'canceled']);
    const w = await run(['make'], { code: 3221225786 });
    expect((flat(w.posted).filter((e) => e.type === 'ci.pipeline').pop() as { status: string }).status).toBe('canceled');
    const m = await run(['nonexistent-tool'], { error: true });
    expect(m.code).toBe(127);
    expect((flat(m.posted).filter((e) => e.type === 'ci.pipeline').pop() as { status: string }).status).toBe('failed');
  });

  it('never sends arguments, command lines or secrets', async () => {
    const r = await run(['build.bat', `--token=${SECRET_TOKEN}`, 'C:\\Users\\DEMO1\\secret-project'], { code: 0 });
    const blob = JSON.stringify(r.posted);
    expect(blob).not.toContain(SECRET_TOKEN);
    expect(blob).not.toContain('secret-project');
    expect(blob).not.toContain('DEMO1\\\\');
  });

  it('still runs the command (and warns once) when the agent is unreachable', async () => {
    const r = await run(['ninja'], { code: 0 }, { reachable: false });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.warnings.filter((w) => w.includes('not reachable'))).toHaveLength(1);
  });
});

describe('resolveSpawn (Windows rules, simulated)', () => {
  it('uses a shell only for .bat/.cmd', () => {
    expect(resolveSpawn(['build.bat', 'a b'], { platform: 'win32' })).toEqual({ command: 'build.bat "a b"', args: [], shell: true });
    expect(resolveSpawn(['C:\\x\\run.CMD'], { platform: 'win32' }).shell).toBe(true);
    expect(resolveSpawn(['ninja.exe', '-C', 'out'], { platform: 'win32' })).toEqual({ command: 'ninja.exe', args: ['-C', 'out'], shell: false });
  });
  it('finds .cmd shims on PATH for bare names (npm)', () => {
    const exists = (p: string) => p === 'C:\\node\\npm.cmd';
    expect(resolveSpawn(['npm', 'test'], { platform: 'win32', env: { PATH: 'C:\\bin;C:\\node' }, exists }).shell).toBe(true);
    const exe = (p: string) => p === 'C:\\bin\\cmake.exe';
    expect(resolveSpawn(['cmake', '--build', '.'], { platform: 'win32', env: { PATH: 'C:\\bin' }, exists: exe })).toEqual({ command: 'cmake.exe', args: ['--build', '.'], shell: false });
  });
  it('never uses a shell on POSIX and quotes cmd metacharacters', () => {
    expect(resolveSpawn(['./build.sh', 'x y'], { platform: 'linux' })).toEqual({ command: './build.sh', args: ['x y'], shell: false });
    expect(quoteForCmd('plain')).toBe('plain');
    expect(quoteForCmd('a&b')).toBe('"a&b"');
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
  });
});
