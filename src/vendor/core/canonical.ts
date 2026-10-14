/**
 * VENDORED FILE: canonical.ts of the Botwarren core contract (event schema, local reducer, one-way public projection, public schema).
 * Copied verbatim from the Botwarren core package when this repository was exported; the only edits are this header and, in
 * public.ts, the removal of constants that belong to the hosted service. Do not edit here: changes to the public contract are made
 * upstream and re-exported, and reviewed as a change to what this agent may publish.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * PRIVATE canonical event model. Nothing in this file is safe to publish.
 * Public data is derived only through `projectPublic` in projection.ts.
 */
import { z } from 'zod';
import { ContextFill } from './public.ts';

export const SCHEMA_VERSION = 1 as const;

/** Project slug, configured per ship (e.g. "alpha-one"). */
export const ProjectId = z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/);
export type ProjectId = z.infer<typeof ProjectId>;

export const Harness = z.enum(['claude', 'codex', 'muse', 'unknown']);
export type Harness = z.infer<typeof Harness>;

/** Herdr's own agent lifecycle enum (observed in herdr 0.9.1 API schema, protocol 22). */
export const HerdrStatus = z.enum(['idle', 'working', 'blocked', 'done', 'unknown']);
export type HerdrStatus = z.infer<typeof HerdrStatus>;

export const Certainty = z.enum(['observed', 'inferred', 'unknown']);

/** Coarse work category, classified LOCALLY from the private task title (only the enum leaves). */
export const WorkCategory = z.enum(['bugfix', 'feature', 'ops', 'docs', 'unknown']);
export type WorkCategory = z.infer<typeof WorkCategory>;

export const ToolCategory = z.enum(['shell', 'edit', 'read', 'web', 'agent', 'other']);

/** Coarse "what kind of thinking/doing" step — metadata only (block type / tool name), never content. */
export const StepCategory = z.enum(['thinking', 'reading', 'editing', 'running', 'researching', 'delegating', 'other']);
export type StepCategory = z.infer<typeof StepCategory>;
export type ToolCategory = z.infer<typeof ToolCategory>;
export type Certainty = z.infer<typeof Certainty>;

export const CiStatus = z.enum([
  'created', 'pending', 'waiting', 'running', 'manual', 'scheduled',
  'success', 'failed', 'canceled', 'skipped', 'unknown',
]);
export type CiStatus = z.infer<typeof CiStatus>;

export const TERMINAL_CI: ReadonlySet<CiStatus> = new Set(['success', 'failed', 'canceled', 'skipped']);

/** Which semantic lane a pipeline belongs to. Green integration != deployed != production verified. */
export const PipelinePurpose = z.enum(['integration', 'release_train', 'deploy', 'merge_request', 'scheduled_other', 'tag_release', 'other']);
export type PipelinePurpose = z.infer<typeof PipelinePurpose>;

export const DeployPhase = z.enum(['queued', 'running', 'deployed', 'parity_verified', 'production_verified', 'failed', 'unknown']);
export type DeployPhase = z.infer<typeof DeployPhase>;

const Iso = z.string().datetime({ offset: true });

/** Entity keys become dictionary keys: reject prototype-polluting names. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
const EntityKey = z.string().min(1).max(128).refine((k) => !RESERVED_KEYS.has(k), 'reserved key');

/** Private-only detail. Never copied into public events; the projection never reads it. */
const PrivateDetail = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

const base = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  eventId: z.string().min(8).max(128),
  source: z.enum(['herdr', 'gitlab', 'github', 'codeberg', 'fixture', 'collector']),
  sourceInstance: z.string().max(64),
  sourceEventId: z.string().max(256),
  occurredAt: Iso,
  observedAt: Iso,
  /** fixture events are never published outside an explicit DEMO world */
  fixture: z.boolean().default(false),
  private: PrivateDetail.default({}),
};

export const SessionObserved = z.object({
  ...base,
  type: z.literal('session.observed'),
  sessionKey: EntityKey,
  harness: Harness,
  status: HerdrStatus,
  projectId: ProjectId.nullable(),
  attribution: z.object({ method: z.enum(['cwd_registry', 'explicit', 'none']), certainty: Certainty }),
  workCategory: WorkCategory.default('unknown'),
  /** crew structure: a sub-agent or pairing partner points at its master session (private key) */
  role: z.enum(['main', 'subagent', 'pair']).default('main'),
  parentKey: EntityKey.optional(),
  /** coarse model family (metadata only) */
  model: z.enum(['opus', 'sonnet', 'haiku', 'gpt', 'other']).optional(),
});

/** Metadata-only activity from local session logs (e.g. a tool call returned an error). */
export const SessionActivity = z.object({
  ...base,
  type: z.literal('session.activity'),
  sessionKey: EntityKey,
  kind: z.enum(['tool_error', 'step', 'context']),
  toolCategory: ToolCategory,
  step: StepCategory.optional(),
  /** kind 'context': the BUCKETED context fill (derived locally from numeric token-usage metadata; never a raw count) */
  context: ContextFill.optional(),
  /** kind 'context': the session's context was just compacted (compact boundary marker, metadata only) */
  compacted: z.boolean().optional(),
});

export const SessionEnded = z.object({
  ...base,
  type: z.literal('session.ended'),
  sessionKey: EntityKey,
  reason: z.enum(['pane_closed', 'agent_exited', 'not_seen_in_snapshot', 'unknown']),
});

export const PipelineObserved = z.object({
  ...base,
  type: z.literal('ci.pipeline'),
  projectId: ProjectId,
  provider: z.enum(['gitlab', 'github', 'codeberg', 'local']),
  pipelineKey: EntityKey,
  purpose: PipelinePurpose,
  status: CiStatus,
  /** source-reported update time, used for ordering out-of-order deliveries */
  sourceUpdatedAt: Iso,
});

export const JobObserved = z.object({
  ...base,
  type: z.literal('ci.job'),
  projectId: ProjectId,
  provider: z.enum(['gitlab', 'github', 'codeberg', 'local']),
  pipelineKey: EntityKey,
  jobKey: EntityKey,
  stage: z.string().max(64),
  /** classified stage category; raw job names stay private */
  category: z.enum(['lint', 'test', 'build', 'security', 'deploy', 'verify', 'other']),
  status: CiStatus,
  retried: z.boolean().default(false),
  sourceUpdatedAt: Iso,
});

export const DeployObserved = z.object({
  ...base,
  type: z.literal('deploy.status'),
  projectId: ProjectId,
  deployKey: EntityKey,
  phase: DeployPhase,
  /** evidence category for the phase claim */
  evidence: z.enum(['ci_job', 'parity_check', 'health_check', 'canary', 'operator', 'none']),
  sourceUpdatedAt: Iso,
});

/** Codebase size of a project's main branch (source files only), measured locally. */
export const ProjectMetrics = z.object({
  ...base,
  type: z.literal('project.metrics'),
  projectId: ProjectId,
  codeLines: z.number().int().nonnegative().max(1e9),
  files: z.number().int().nonnegative().max(1e7),
});

/** Code hosts a ship owner can connect (read-only) so their ship shows real repository activity. */
export const CodeHost = z.enum(['github', 'gitlab', 'codeberg']);
export type CodeHost = z.infer<typeof CodeHost>;

/**
 * Repository activity from a CONNECTED code host (external ships). Names, messages and authors are never
 * stored here. `branchName` is the one exception: it is read by the projection ONLY when the ship owner
 * switched "Show branch names" on, and then only after sanitising (see `branchLabel`).
 */
export const RepoPush = z.object({
  ...base,
  type: z.literal('repo.push'),
  projectId: ProjectId,
  provider: CodeHost,
  /** commits that landed on the default branch since the previous observation (count only) */
  branchKind: z.enum(['default', 'other']),
  commits: z.number().int().min(1).max(100_000),
  branchName: z.string().min(1).max(255).optional(),
});

export const RepoBranch = z.object({
  ...base,
  type: z.literal('repo.branch'),
  projectId: ProjectId,
  provider: CodeHost,
  action: z.enum(['created', 'deleted']),
  branchName: z.string().min(1).max(255).optional(),
});

/** Pull request / merge request lifecycle. `changeKey` only seeds a keyed pseudonym; it is never published. */
export const RepoChange = z.object({
  ...base,
  type: z.literal('repo.change'),
  projectId: ProjectId,
  provider: CodeHost,
  changeKey: EntityKey,
  action: z.enum(['opened', 'merged', 'closed']),
  branchName: z.string().min(1).max(255).optional(),
});

export const CollectorHeartbeat = z.object({
  ...base,
  type: z.literal('collector.heartbeat'),
  collector: z.enum(['herdr', 'gitlab', 'github']),
  health: z.enum(['healthy', 'delayed', 'disconnected', 'recovering']),
});

export const CanonicalEvent = z.discriminatedUnion('type', [
  SessionObserved, SessionEnded, SessionActivity, ProjectMetrics, PipelineObserved, JobObserved, DeployObserved, RepoPush, RepoBranch, RepoChange, CollectorHeartbeat,
]);
export type CanonicalEvent = z.infer<typeof CanonicalEvent>;
export type CanonicalEventInput = z.input<typeof CanonicalEvent>;
