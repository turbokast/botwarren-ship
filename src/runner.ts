/**
 * `botwarren run [--release] [--project <id>] -- <command...>`
 *
 * Wraps a manual build/test/release script and reports ONLY metadata to the local ship agent:
 * ci.pipeline (running -> success/failed/canceled) and one ci.job (category inferred from the
 * command name). provider is 'local' (not a hosted CI). Command lines, arguments and output are
 * never sent anywhere. A finished build is never a deployment: no deploy.status is ever emitted.
 * The wrapper must never break a build: if the agent is unreachable it warns and still runs the command.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, extname, win32 } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CanonicalEventInput } from './vendor/core/contract.ts';
import { sha } from './events.ts';

export type JobCategory = 'lint' | 'test' | 'build' | 'security' | 'other';

const TEST = new Set(['test', 'tests', 'testing', 'ctest', 'pytest', 'vitest', 'jest', 'spec', 'specs', 'check', 'gtest']);
const LINT = new Set(['lint', 'eslint', 'format', 'fmt', 'prettier', 'tidy', 'clang', 'cppcheck', 'typecheck', 'tsc']);
const SECURITY = new Set(['security', 'audit', 'scan', 'trivy', 'snyk', 'semgrep']);
const BUILD = new Set(['build', 'builds', 'ninja', 'cmake', 'make', 'msbuild', 'xcodebuild', 'cargo', 'gradle', 'gradlew', 'compile', 'release', 'package', 'bundle', 'pack', 'dist', 'nmake', 'mingw32', 'webpack', 'vite']);

/**
 * Category from the command NAME (and its first few args, used locally only). A release build is
 * category 'build' - never 'deploy' (we have no evidence of a deployment).
 */
export function inferCategory(argv: string[], release: boolean): JobCategory {
  const toks = argv.slice(0, 6).flatMap((a, i) => (i === 0 ? basename(a.replace(/\\/g, '/')) : a).toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean);
  const has = (s: Set<string>) => toks.some((t) => s.has(t) || (t.length > 4 && t.endsWith('s') && s.has(t.slice(0, -1))));
  if (has(TEST)) return 'test';
  if (has(SECURITY)) return 'security';
  if (has(LINT) && !has(BUILD)) return 'lint';
  if (release || has(BUILD)) return 'build';
  return 'other';
}

/** cmd.exe quoting for .bat/.cmd (best effort; `%VAR%` cannot be escaped reliably). */
export function quoteForCmd(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^()!%]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface SpawnPlan { command: string; args: string[]; shell: boolean }

const WIN_SHIM_NAMES = new Set(['npm', 'npx', 'pnpm', 'yarn', 'corepack']);

/**
 * Windows: .bat/.cmd (and bare names that only exist as .cmd shims, e.g. npm) need shell:true,
 * everything else (ninja.exe, cmake.exe) is spawned directly with no shell.
 */
export function resolveSpawn(argv: string[], o: { platform?: NodeJS.Platform; env?: Record<string, string | undefined>; exists?: (p: string) => boolean } = {}): SpawnPlan {
  const platform = o.platform ?? process.platform;
  const [cmd = '', ...args] = argv;
  if (platform !== 'win32') return { command: cmd, args, shell: false };
  const exists = o.exists ?? existsSync;
  const ext = extname(cmd.replace(/\\/g, '/')).toLowerCase();
  let target = cmd;
  let shell = ext === '.bat' || ext === '.cmd';
  if (!ext && !/[\\/]/.test(cmd)) {
    const dirs = (o.env?.PATH ?? o.env?.Path ?? '').split(';').filter(Boolean);
    for (const e of ['.exe', '.com', '.cmd', '.bat']) {
      const hit = dirs.find((d) => exists(win32.join(d, cmd + e)));
      if (hit) { target = cmd + e; shell = e === '.cmd' || e === '.bat'; break; }
    }
    if (target === cmd && WIN_SHIM_NAMES.has(cmd.toLowerCase())) shell = true;
  }
  return shell ? { command: [target, ...args].map(quoteForCmd).join(' '), args: [], shell: true } : { command: target, args, shell: false };
}

export type Poster = (events: CanonicalEventInput[]) => Promise<boolean>;

export function makePoster(o: { port: number; token: string; fetchImpl?: typeof fetch }): Poster {
  return async (events) => {
    try {
      const res = await (o.fetchImpl ?? fetch)(`http://127.0.0.1:${o.port}/ingest`, {
        method: 'POST', headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events }), signal: AbortSignal.timeout(2500),
      });
      return res.ok;
    } catch { return false; }
  };
}

type Phase = 'running' | 'success' | 'failed' | 'canceled';

function ciEvents(o: { instance: string; projectId: string; pipelineKey: string; release: boolean; category: JobCategory; phase: Phase; at: Date; updatedAt: Date; command: string; exitCode: number | null }): CanonicalEventInput[] {
  const at = o.at.toISOString();
  const upd = o.updatedAt.toISOString();
  const common = { schemaVersion: 1 as const, source: 'collector' as const, sourceInstance: o.instance, occurredAt: at, observedAt: at, sourceUpdatedAt: upd, projectId: o.projectId, provider: 'local' as const, pipelineKey: o.pipelineKey };
  // private detail stays local (ops room): command NAME and exit code only, never arguments.
  const priv = { command: o.command.slice(0, 64), exitCode: o.exitCode, release: o.release };
  return [
    { ...common, eventId: `run-${sha(o.pipelineKey, 'p', o.phase).slice(0, 32)}`, sourceEventId: `${o.pipelineKey}:p:${o.phase}`, type: 'ci.pipeline', purpose: o.release ? 'tag_release' : 'integration', status: o.phase, private: priv },
    { ...common, eventId: `run-${sha(o.pipelineKey, 'j', o.phase).slice(0, 32)}`, sourceEventId: `${o.pipelineKey}:j:${o.phase}`, type: 'ci.job', jobKey: `${o.pipelineKey}-job`, stage: 'local', category: o.category, status: o.phase, retried: false, private: priv },
  ];
}

export interface RunOptions {
  argv: string[];
  release: boolean;
  projectId: string;
  instance: string;
  post: Poster;
  now?: () => Date;
  spawnImpl?: (command: string, args: string[], opts: SpawnOptions) => ChildProcess;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  warn?: (msg: string) => void;
}

/** Runs the command (inherit stdio). Returns the exit code to propagate. */
export async function runWrapped(o: RunOptions): Promise<number> {
  const now = o.now ?? (() => new Date());
  const warn = o.warn ?? ((m: string) => process.stderr.write(`[botwarren] ${m}\n`));
  const pipelineKey = `local-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const category = inferCategory(o.argv, o.release);
  const name = basename((o.argv[0] ?? '').replace(/\\/g, '/'));
  const base = { instance: o.instance, projectId: o.projectId, pipelineKey, release: o.release, category, command: name };
  let warned = false;
  const send = async (events: CanonicalEventInput[]) => { if (!(await o.post(events)) && !warned) { warned = true; warn('ship agent not reachable - running the command without reporting (is "Botwarren Ship Agent" running?)'); } };

  const start = now();
  await send(ciEvents({ ...base, phase: 'running', at: start, updatedAt: start, exitCode: null }));

  const plan = resolveSpawn(o.argv, { ...(o.platform ? { platform: o.platform } : {}), env: o.env ?? process.env });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: boolean }>((resolve) => {
    const child = (o.spawnImpl ?? spawn)(plan.command, plan.args, { stdio: 'inherit', shell: plan.shell, windowsHide: false, ...(o.env ? { env: o.env as NodeJS.ProcessEnv } : {}) });
    let done = false;
    child.once('error', () => { if (!done) { done = true; resolve({ code: 127, signal: null, spawnError: true }); } });
    child.once('close', (code, signal) => { if (!done) { done = true; resolve({ code, signal, spawnError: false }); } });
  });

  const WIN_CTRL_C = 3221225786; // 0xC000013A STATUS_CONTROL_C_EXIT
  const canceled = !exit.spawnError && (exit.signal === 'SIGINT' || exit.signal === 'SIGTERM' || exit.signal === 'SIGBREAK' || exit.code === WIN_CTRL_C);
  const phase: Phase = canceled ? 'canceled' : exit.code === 0 ? 'success' : 'failed';
  const end = now();
  const updatedAt = new Date(Math.max(end.getTime(), start.getTime() + 1));
  await send(ciEvents({ ...base, phase, at: end, updatedAt, exitCode: exit.code }));
  if (exit.spawnError) warn(`could not start "${name}"`);
  return exit.code ?? (canceled ? 130 : 1);
}
