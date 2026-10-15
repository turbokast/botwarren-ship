/**
 * SHARED CANARY REDACTION TEST. Every adapter is fed fixtures in which a unique canary string sits in every place a real
 * machine holds secrets: prompts, tool output, titles, summaries, notes, env values, base instructions, folder names.
 * The test fails if a canary reaches any emitted event, public projection or log line (see kit.assertNoLeak for the
 * exact rules). A new adapter is not done until it has a scenario here.
 */
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CanonicalEventInput } from '../../src/vendor/core/contract.ts';
import type { Adapter } from '../../src/adapters/api.ts';
import { ClaudeCodeAdapter, CodexAdapter } from '../../src/adapters/claude.ts';
import { HerdrAdapter } from '../../src/adapters/herdr.ts';
import { NinoxAdapter } from '../../src/adapters/ninox.ts';
import { OpenCodeAdapter } from '../../src/adapters/opencode.ts';
import { GeminiCliAdapter, projectHash } from '../../src/adapters/gemini.ts';
import { line, writeCodex, writeSession } from '../helpers.ts';
import type { Host } from '../../src/paths.ts';
import { fakeOpencodeV2, v2Bodies } from './opencode-fixtures.ts';
import { CANARY_CONTENT, CANARY_PATH, assertNoLeak, fakeHerdr, fakeHttp, herdrHost, linuxHost, makeHost, mkTmp, rmTmp } from './kit.ts';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const at = (s: number) => new Date(NOW.getTime() + s * 1000);
const REPO = `/work/${CANARY_PATH}/game`;
const projects = [{ id: 'demo1', repoPaths: [REPO] }];
const UUID = '0b1c2d3e-aaaa-bbbb-cccc-0123456789ab';
const cleanup: (() => Promise<void> | void)[] = [];

beforeEach(() => { process.env.CANARY_ENV_SECRET = CANARY_CONTENT; process.env.ANTHROPIC_API_KEY = CANARY_CONTENT; });
afterEach(async () => { delete process.env.CANARY_ENV_SECRET; delete process.env.ANTHROPIC_API_KEY; for (const c of cleanup.splice(0)) await c(); });

interface Scenario { name: string; build: (home: string) => Promise<{ adapters: Adapter[]; settings?: { port?: number }; step?: (n: number) => void; host?: (env: Record<string, string | undefined>) => Host }> }

const claudeLog = (cwd: string, n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += line({ cwd, sessionId: 's', type: 'user', timestamp: new Date(NOW.getTime() - 9000 + i).toISOString(), message: { role: 'user', content: `please fix ${CANARY_CONTENT}` } });
    s += line({ cwd, type: 'assistant', timestamp: new Date(NOW.getTime() - 8000 + i).toISOString(), message: { role: 'assistant', model: 'claude-opus-4-5', usage: { input_tokens: 50_000 }, content: [{ type: 'text', text: CANARY_CONTENT }, { type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: `echo ${CANARY_CONTENT}`, cwd: CANARY_PATH } }] } });
    s += line({ cwd, type: 'user', timestamp: new Date(NOW.getTime() - 7000 + i).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${i}`, is_error: true, content: `error: ${CANARY_CONTENT} at ${CANARY_PATH}` }] } });
  }
  return s;
};

const scenarios: Scenario[] = [
  {
    name: 'claude-code',
    build: async (home) => {
      const root = join(home, '.claude', 'projects');
      const f = writeSession(root, `-work-${CANARY_PATH}-game`, UUID, REPO, new Date(NOW.getTime() - 3000), claudeLog(REPO, 1));
      const sub = join(root, `-work-${CANARY_PATH}-game`, UUID, 'subagents'); mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, 'agent-a1.jsonl'), line({ isSidechain: true, cwd: REPO, agentId: 'a1', requestedModel: 'haiku', message: { content: CANARY_CONTENT } }));
      utimesSync(join(sub, 'agent-a1.jsonl'), new Date(NOW.getTime() - 2000), new Date(NOW.getTime() - 2000));
      return { adapters: [new ClaudeCodeAdapter([root])], step: () => { appendFileSync(f, claudeLog(REPO, 2)); utimesSync(f, at(2), at(2)); } };
    },
  },
  {
    name: 'codex',
    build: async (home) => {
      const root = join(home, '.codex', 'sessions');
      const claudeRoot = join(home, '.claude', 'projects');
      writeSession(claudeRoot, 'p', UUID, REPO, new Date(NOW.getTime() - 3000), claudeLog(REPO, 1));
      const f = writeCodex(root, NOW, 'x', { id: '019abcde-0001-0002', cwd: REPO, originator: `codex_exec ${CANARY_CONTENT}`, source: 'exec', base_instructions: { text: CANARY_CONTENT } }, new Date(NOW.getTime() - 1000));
      appendFileSync(f, line({ type: 'response_item', payload: { type: 'message', content: [{ text: CANARY_CONTENT }] } }));
      const claude = new ClaudeCodeAdapter([claudeRoot]);
      return { adapters: [claude, new CodexAdapter([root], () => claude.mains())] };
    },
  },
  {
    name: 'herdr',
    build: async (home) => {
      const srv = await fakeHerdr(join(home, '.config', 'herdr'), () => [{
        agent: 'claude', agent_status: 'working', agent_session: { agent: 'claude', kind: 'id', source: 'hook', value: UUID, secret: CANARY_CONTENT },
        cwd: REPO, pane_id: 'p1', terminal_title_stripped: `fix bug ${CANARY_CONTENT}`, screen: CANARY_CONTENT, env: { KEY: CANARY_CONTENT }, history: [CANARY_CONTENT],
      }]);
      cleanup.push(srv.close);
      const dir = join(home, '.config', 'herdr');
      const a = new HerdrAdapter(herdrHost(home, dir));
      cleanup.push(() => a.stop());
      return { adapters: [a], host: (env) => herdrHost(home, dir, env) };
    },
  },
  {
    name: 'ninox',
    build: async () => {
      const srv = await fakeHttp({ '/api/v1/sessions': [{
        id: 's1', name: CANARY_CONTENT, repo: CANARY_CONTENT, status: 'working', agent_type: 'claude', cost_usd: 9, started_at: 1, workspace_path: REPO,
        summary: CANARY_CONTENT, activity_note: CANARY_CONTENT, activity: 'working', model: 'opus', context_used_pct: 10, claude_session_id: UUID, catalogue_path: `/${CANARY_PATH}`,
        gate_status: { ci: 'Failing' }, orchestrator_id: null, terminal_buffer: CANARY_CONTENT,
      }] }, { sse: { path: '/api/v1/events', lines: [`{"type":"notification","payload":{"text":"${CANARY_CONTENT}"}}`] } });
      cleanup.push(srv.close);
      const a = new NinoxAdapter(linuxHost('/h'));
      cleanup.push(() => a.stop());
      return { adapters: [a], settings: { port: srv.port } };
    },
  },
  {
    name: 'opencode',
    build: async () => {
      const srv = await fakeHttp({
        '/session/status': { ses_a: { type: 'busy', message: CANARY_CONTENT } },
        '/session': [{ id: 'ses_a', directory: REPO, title: CANARY_CONTENT, summary: { diffs: CANARY_CONTENT }, time: { created: NOW.getTime() - 5000, updated: NOW.getTime() - 1000 } }],
      });
      cleanup.push(srv.close);
      return { adapters: [new OpenCodeAdapter()], settings: { port: srv.port } };
    },
  },
  {
    // OpenCode 2.x: wrapped bodies, session titles/metadata, permission requests (action, resources, message) and forms full of
    // canaries, behind Basic auth whose PASSWORD is itself a content canary (so this also proves the password never reaches an event or log)
    name: 'opencode-v2',
    build: async (home) => {
      const b = v2Bodies({ content: CANARY_CONTENT, folder: REPO, now: NOW.getTime() });
      const srv = await fakeOpencodeV2({ '/api/session/active': b.active, '/api/session': b.list, '/api/permission/request': b.permissions, '/api/form': b.forms }, { password: CANARY_CONTENT });
      cleanup.push(srv.close);
      return { adapters: [new OpenCodeAdapter()], settings: { port: srv.port }, host: (env) => linuxHost(home, { ...env, OPENCODE_SERVER_PASSWORD: CANARY_CONTENT }) };
    },
  },
  {
    name: 'gemini-cli',
    build: async (home) => {
      const dir = join(home, '.gemini', 'tmp', projectHash(REPO), 'chats');
      mkdirSync(dir, { recursive: true });
      const p = join(dir, 'session-2026-10-14-abc.json');
      writeFileSync(p, JSON.stringify({ messages: [{ role: 'user', text: CANARY_CONTENT }], cwd: REPO }));
      utimesSync(p, new Date(NOW.getTime() - 2000), new Date(NOW.getTime() - 2000));
      return { adapters: [new GeminiCliAdapter(linuxHost(home))] };
    },
  },
];

describe('canary redaction: no adapter lets a secret reach an event, a public projection or a log', () => {
  for (const sc of scenarios) {
    it(`${sc.name}: content canary appears nowhere; path canary only in the private cwd`, async () => {
      const home = mkTmp(); cleanup.push(() => rmTmp(home));
      const b = await sc.build(home);
      const { host, logs } = makeHost({
        adapters: b.adapters.map((adapter) => ({ adapter, ...(b.settings ? { settings: b.settings } : {}) })),
        host: b.host ? b.host({ CANARY_ENV: CANARY_CONTENT }) : linuxHost(home, { CANARY_ENV: CANARY_CONTENT }), projects,
      });
      const all: CanonicalEventInput[] = [];
      all.push(...await host.tick(NOW));
      b.step?.(1);
      await new Promise((r) => setTimeout(r, 60));
      all.push(...await host.tick(at(3)), ...await host.tick(at(6)));
      // something real must have been observed, or the test proves nothing
      expect(all.some((e) => e.type === 'session.observed')).toBe(true);
      assertNoLeak(all, logs, ['demo1']);
      for (const a of b.adapters) await a.stop?.();
    });
  }

  it('the claude-code scenario really exercised tool errors, steps and context (so those paths were checked too)', async () => {
    const home = mkTmp(); cleanup.push(() => rmTmp(home));
    const b = await scenarios[0]!.build(home);
    const { host, logs } = makeHost({ adapters: b.adapters.map((adapter) => ({ adapter })), host: linuxHost(home), projects });
    const all: CanonicalEventInput[] = [...await host.tick(NOW)];
    b.step?.(1);
    all.push(...await host.tick(at(3)));
    const kinds = new Set(all.filter((e) => e.type === 'session.activity').map((e) => (e as { kind: string }).kind));
    expect(kinds.has('tool_error')).toBe(true);
    expect(all.some((e) => e.type === 'session.observed' && (e as { role?: string }).role === 'subagent')).toBe(true);
    assertNoLeak(all, logs, ['demo1']);
  });

  it('the leak check itself catches a leak (a deliberately broken adapter fails it)', async () => {
    const leaky: Adapter = {
      manifest: new GeminiCliAdapter(linuxHost('/h')).manifest,
      detect: async () => ({ found: true, confidence: 'high' }),
      poll: async () => [{ kind: 'session', key: 'x:abcdefgh', harness: 'unknown', status: 'idle', projectId: 'demo1', certainty: 'inferred', local: { cwd: REPO, log: `${CANARY_CONTENT}.json` } }],
    };
    const { host, logs } = makeHost({ adapters: [{ adapter: leaky }], host: linuxHost('/h'), projects });
    const evs = await host.tick(NOW);
    expect(() => assertNoLeak(evs, logs, ['demo1'])).toThrow();
  });
});
