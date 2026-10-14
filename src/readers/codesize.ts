/**
 * Read-only codebase size per project: source lines on the committed main branch
 * (git grep over the tree object — no checkout, no working-tree access).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { CanonicalEventInput, ProjectId } from '../vendor/core/contract.ts';

const run = promisify(execFile);

export const SOURCE_EXT = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'ex', 'exs', 'heex', 'eex', 'leex', 'go', 'py', 'rs', 'sql', 'css', 'scss', 'html', 'sh', 'bash', 'zsh', 'swift', 'kt', 'java', 'rb', 'c', 'h', 'cpp', 'hpp', 'vue', 'svelte'];
const EXCLUDES = ['*.min.js', '**/vendor/**', 'vendor/**', 'deps/**', '**/node_modules/**', '**/dist/**', '**/priv/static/**', '**/_build/**'].map((p) => `:(exclude)${p}`);

/** Parses `git grep -c` output ("<ref>:<path>:<count>") into totals. */
export function sumCounts(stdout: string): { codeLines: number; files: number } {
  let codeLines = 0, files = 0;
  for (const line of stdout.split('\n')) {
    const i = line.lastIndexOf(':');
    if (i < 0) continue;
    const n = Number(line.slice(i + 1));
    if (Number.isFinite(n)) { codeLines += n; files++; }
  }
  return { codeLines, files };
}

export async function measure(repoDir: string, ref = 'origin/main'): Promise<{ codeLines: number; files: number } | null> {
  try {
    await run('git', ['-C', repoDir, 'rev-parse', '--verify', '-q', ref], { timeout: 5000 });
  } catch { return null; }
  try {
    const { stdout } = await run('git', ['-C', repoDir, 'grep', '-I', '-c', '', ref, '--', ...SOURCE_EXT.map((e) => `*.${e}`), ...EXCLUDES],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return sumCounts(stdout);
  } catch (e) {
    // git grep exits 1 when nothing matches
    if ((e as { code?: number }).code === 1) return { codeLines: 0, files: 0 };
    return null;
  }
}

export function metricsEvent(project: ProjectId, m: { codeLines: number; files: number }, instance: string, now: Date): CanonicalEventInput {
  const at = now.toISOString();
  return {
    schemaVersion: 1, eventId: `size-${createHash('sha256').update(`${project}\0${at}`).digest('hex').slice(0, 32)}`,
    source: 'collector', sourceInstance: instance, sourceEventId: `size:${project}:${at}`, occurredAt: at, observedAt: at,
    type: 'project.metrics', projectId: project, codeLines: m.codeLines, files: m.files,
  };
}
