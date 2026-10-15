/**
 * Adapter API v1 (stable, versioned). An adapter turns what ONE tool exposes locally (log files, a loopback API, a
 * socket) into a stream of `Observation`s. The core (host.ts) validates every observation, attributes projects,
 * de-duplicates the same real session seen by several adapters and builds the canonical events.
 *
 * Privacy by construction:
 *  - Every field of an Observation is an enum, a bounded integer, a validated timestamp, or a SAFE KEY (see `safeKey`:
 *    anything that is not a short id-looking token is replaced by a hash). There is no free-text field.
 *  - Text that exists on the user's machine (cwd, a log file name) may appear ONLY in `local`, which is stored in the
 *    private journal / ops room and is never projected to public events.
 *  - The context offers only allowlisted, read-only access (loopback GETs, declared file roots), and a logger that
 *    cannot carry text.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AreaAct, AreaIndex, ContextFill, Harness, HerdrStatus, StepCategory, ToolCategory, WorkCategory } from '../vendor/core/contract.ts';
import type { Host } from '../paths.ts';

export const ADAPTER_API_VERSION = 1 as const;

export const AdapterId = z.enum(['claude-code', 'codex', 'herdr', 'ninox', 'opencode', 'gemini-cli']);
export type AdapterId = z.infer<typeof AdapterId>;

/** Which tool the session belongs to. Finer than the public `harness` enum; kept in the private journal only. */
export const ToolId = z.enum(['claude-code', 'codex', 'opencode', 'gemini-cli', 'aider', 'freebuff', 'muse', 'other']);
export type ToolId = z.infer<typeof ToolId>;

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9:._\-/]{0,127}$/;
/** Ids from other tools are used as keys only when they look like ids; anything else becomes `h:<hash>`. */
export function safeKey(raw: string): string {
  return SAFE_KEY.test(raw) && !raw.includes('..') ? raw : `h:${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

/** Same real session as seen by another adapter. Ids are normalised with `safeKey` by the core. */
export const CorrelationType = z.enum(['claude-session', 'codex-session', 'herdr-pane', 'ninox-session', 'opencode-session', 'gemini-session']);
export type CorrelationType = z.infer<typeof CorrelationType>;
export const Correlation = z.object({ type: CorrelationType, id: z.string().min(1).max(256) }).strict();
export type Correlation = z.infer<typeof Correlation>;

const Key = z.string().min(1).max(256);
const Iso = z.string().datetime({ offset: true });

/** Private, local-only detail. The only strings an adapter may hand over; never projected publicly. */
export const Local = z.object({
  cwd: z.string().min(1).max(1024).optional(),
  /** a log/session file's base name */
  log: z.string().min(1).max(160).optional(),
  pid: z.number().int().min(1).max(4_294_967_295).optional(),
  /** how a session was started, as an enum (e.g. Codex `exec` runs are short-lived) */
  launch: z.enum(['interactive', 'exec', 'other']).optional(),
  /** coarse lifecycle reported by an orchestrator (e.g. Ninox PR/CI state); local only, never a CI claim */
  lifecycle: z.enum(['spawning', 'working', 'pr_open', 'ci_failed', 'review_pending', 'mergeable', 'done', 'other']).optional(),
}).strict();
export type Local = z.infer<typeof Local>;

export const SessionObs = z.object({
  kind: z.literal('session'),
  key: Key,
  correlate: z.array(Correlation).max(8).default([]),
  tool: ToolId.default('other'),
  harness: Harness,
  status: HerdrStatus,
  role: z.enum(['main', 'subagent', 'pair']).default('main'),
  parentKey: Key.optional(),
  model: z.enum(['opus', 'sonnet', 'haiku', 'gpt', 'other']).optional(),
  /** a configured project id, obtained from `ctx.attribute()`; the core re-checks it */
  projectId: z.string().min(2).max(32).nullable(),
  certainty: z.enum(['observed', 'inferred']),
  workCategory: WorkCategory.optional(),
  local: Local.optional(),
}).strict();
export type SessionObs = z.infer<typeof SessionObs>;

export const EndedObs = z.object({
  kind: z.literal('session.ended'),
  key: Key,
  reason: z.enum(['pane_closed', 'agent_exited', 'not_seen_in_snapshot', 'unknown']).default('unknown'),
}).strict();

export const ActivityObs = z.object({
  kind: z.literal('activity'),
  key: Key,
  act: z.enum(['tool_error', 'step', 'context', 'area']),
  toolCategory: ToolCategory,
  /** act 'area' (Code map, opt-in): an opaque area index and the tool family; the path it came from was dropped by the reader */
  area: AreaIndex.optional(),
  areaAct: AreaAct.optional(),
  step: StepCategory.optional(),
  context: ContextFill.optional(),
  compacted: z.boolean().optional(),
  at: Iso,
}).strict();

export const HealthObs = z.object({
  kind: z.literal('adapter.health'),
  state: z.enum(['ok', 'degraded', 'unsupported_version']),
  code: z.enum(['none', 'unreachable', 'unexpected_shape', 'unsupported_platform', 'policy_denied', 'too_many_sessions']).default('none'),
}).strict();

export const ObservationSchema = z.discriminatedUnion('kind', [SessionObs, EndedObs, ActivityObs, HealthObs]);
export type Observation = z.input<typeof ObservationSchema>;

export interface ReadDecl {
  kind: 'file' | 'dir' | 'loopback-http' | 'unix-socket' | 'named-pipe' | 'env';
  /** human-readable, shown by `botwarren adapters explain <id>`. Never executed. */
  target: string;
  /** what we take from it, in plain words */
  keeps: string;
}

export interface AdapterManifest {
  id: AdapterId;
  apiVersion: typeof ADAPTER_API_VERSION;
  version: string;
  platforms: NodeJS.Platform[];
  reads: ReadDecl[];
  capabilities: { state: boolean; toolCategory: boolean; errors: boolean; subagents: boolean; tokens: boolean; hierarchy: boolean };
  /** upstream versions the fixtures were recorded against ('unverified' = documented format only, no live recording) */
  upstream: { name: string; tested: string; verification: 'live' | 'documented' | 'unverified' };
  /** one line shown to the user */
  summary: string;
}

export interface Detection { found: boolean; confidence: 'high' | 'medium' | 'low'; note?: string }

/** Per-adapter user settings (config.adapters.<id>). Unknown keys are rejected by the config schema. */
export interface AdapterSettings { enabled: boolean | 'auto'; port?: number | undefined; host?: '127.0.0.1' | '::1' | undefined }

export interface DetectEnv {
  host: Host;
  exists(path: string): boolean;
  /** true when `cmd` resolves on PATH (never executed) */
  hasCommand(cmd: string): boolean;
  settings: AdapterSettings;
  projects: ProjectRef[];
  /** probes through the same loopback policy as the adapter itself: only the given allowlisted GET paths */
  probe(allowPaths: string[], port: number, path: string, hostName?: '127.0.0.1' | '::1'): Promise<{ status: number; body: string } | null>;
  /** a scoped fs over the given roots */
  fs(roots: string[]): ScopedFs;
}

export interface ProjectRef { id: string; repoPaths: string[] }

export interface LoopbackHttp {
  get(path: string, opts?: { maxBytes?: number; timeoutMs?: number; auth?: boolean }): Promise<{ status: number; body: string }>;
  /** Server-sent events: `onData` receives complete `data:` lines (capped); resolves when the stream ends. */
  sse(path: string, onData: (line: string) => void, signal: AbortSignal): Promise<void>;
}

export interface ScopedFs {
  list(dir: string): { name: string; isFile: boolean; isDirectory: boolean }[];
  stat(path: string): { mtimeMs: number; size: number; isFile: boolean } | null;
  /** at most `maxBytes` (hard cap 1 MiB) from the start of a file; symlinks and paths outside the declared roots are refused */
  readHead(path: string, maxBytes: number): Buffer | null;
}

export type LogCode = 'started' | 'stopped' | 'unreachable' | 'unexpected_shape' | 'too_many_sessions' | 'recovered' | 'policy_denied';

export interface AdapterContext {
  host: Host;
  instance: string;
  settings: AdapterSettings;
  projects: ProjectRef[];
  /** Core attribution (git remote, then configured repo paths). Returns a configured project id or null. */
  attribute(cwd: string | null | undefined, nowMs: number): Promise<string | null>;
  /** changes whenever the set of projects changes (the owner showed or hid one): attribute known sessions again */
  attributionEpoch: () => number;
  /** Allowlisted, loopback-only, read-only HTTP for this adapter. Throws `PolicyError` for anything else. */
  http: LoopbackHttp;
  /** File access limited to the roots this adapter declared in its manifest. */
  fs: ScopedFs;
  /** A logger that can only say a fixed code (+ one integer), so it cannot carry user text. */
  log(code: LogCode, n?: number): void;
  /** Hint that something changed: the host polls this adapter again soon (debounced). */
  requestPoll(): void;
}

export interface Adapter {
  manifest: AdapterManifest;
  detect(env: DetectEnv): Promise<Detection>;
  /**
   * optional: HTTP Basic credentials for the tool's own loopback server, taken ONLY from environment variables the user set for
   * that tool (declared in the manifest as an `env` read). The host attaches them solely to requests that pass `auth: true`.
   */
  httpAuth?(env: Record<string, string | undefined>): { user: string; password: string } | null;
  /** optional: open streams / hints. Must not block. */
  start?(ctx: AdapterContext): Promise<void>;
  poll(ctx: AdapterContext, now: Date): Promise<Observation[]>;
  stop?(): Promise<void>;
}

export class PolicyError extends Error {
  constructor(msg: string) { super(msg); this.name = 'PolicyError'; }
}

/** Bounded, log-safe description of an error: a code or a class name, never a message (messages can hold paths). */
export function safeErrorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
  const name = (e as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error';
}
