import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SECRET_PROMPT = 'SECRET_PROMPT_do-not-leak-hunter2';
export const SECRET_TOKEN = 'sk-ant-api03-LEAKLEAKLEAKLEAK';
export const SECRET_CODE = 'proprietary_function_xyzzy()';

export const tmp = (): string => mkdtempSync(join(tmpdir(), 'bw-ship-'));

export const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;

/** A realistic-ish Claude Code log full of content that must never leave the machine. */
export function claudeLines(cwd: string, n = 3): string {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += line({ parentUuid: null, cwd, sessionId: 's', type: 'user', timestamp: new Date(1_000_000 + i).toISOString(), message: { role: 'user', content: `${SECRET_PROMPT} please fix ${SECRET_CODE}` } });
    s += line({ cwd, type: 'assistant', timestamp: new Date(2_000_000 + i).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `token ${SECRET_TOKEN}` }, { type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: `echo ${SECRET_TOKEN}`, cwd: 'C:\\somewhere\\else' } }] } });
  }
  return s;
}

export function writeSession(root: string, projDir: string, id: string, cwd: string, mtime: Date, content?: string): string {
  const dir = join(root, projDir);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(p, content ?? claudeLines(cwd));
  utimesSync(p, mtime, mtime);
  return p;
}

export function appendSession(path: string, text: string, mtime: Date): void {
  appendFileSync(path, text);
  utimesSync(path, mtime, mtime);
}

export const SECRET_INSTRUCTIONS = 'BASE_INSTRUCTIONS_SECRET_do-not-leak-4242';

/** <root>/<proj>/<masterId>/subagents/agent-<agentId>.jsonl with top-level cwd/sessionId/agentId/requestedModel. */
export function writeSub(root: string, proj: string, masterId: string, agentId: string, cwd: string, mtime: Date, requestedModel?: string): string {
  const dir = join(root, proj, masterId, 'subagents');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `agent-${agentId}.jsonl`);
  const first = { parentUuid: null, isSidechain: true, sessionId: masterId, agentId, cwd, ...(requestedModel ? { requestedModel } : {}), type: 'user', timestamp: new Date(1_000_000).toISOString(), message: { role: 'user', content: `${SECRET_PROMPT} ${SECRET_CODE}` } };
  writeFileSync(p, line(first) + claudeLines(cwd, 2));
  utimesSync(p, mtime, mtime);
  return p;
}

/** <root>/YYYY/MM/DD/rollout-*.jsonl whose first line is a session_meta carrying a secret base_instructions. */
export function writeCodex(root: string, day: Date, name: string, payload: Record<string, unknown>, mtime: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const dir = join(root, String(day.getFullYear()), two(day.getMonth() + 1), two(day.getDate()));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `rollout-${name}.jsonl`);
  const meta = line({ type: 'session_meta', payload: { cli_version: '0.9.9', base_instructions: { text: SECRET_INSTRUCTIONS + ' '.repeat(20_000) }, ...payload } });
  const msg = line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${SECRET_PROMPT} ${SECRET_CODE}` }] } });
  writeFileSync(p, meta + msg);
  utimesSync(p, mtime, mtime);
  return p;
}

/** A currently free loopback TCP port (asked from the OS, so parallel runs and busy machines cannot collide on a guessed one). */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
}
