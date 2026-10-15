/**
 * VENDORED FILE: public.ts of the Botwarren core contract (event schema, local reducer, one-way public projection, public schema).
 * Copied verbatim from the Botwarren core package when this repository was exported; the only edits are this header and, in
 * public.ts, the removal of constants that belong to the hosted service. Do not edit here: changes to the public contract are made
 * upstream and re-exported, and reviewed as a change to what this agent may publish.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * PUBLIC contract. Every field is an enum, a bounded number, a timestamp, or a
 * pseudonymous key matching a strict pattern. There is deliberately NO free-text
 * field: captions are rendered from `labelKey` templates in captions.ts.
 * Safe to import from browser bundles.
 */
import { z } from 'zod';
import { ShipPlanV2 } from './shipplan.ts';
import { AreaAct, AreaIndex, PublicAreas, type PublicArea } from './codemap.ts';
export * from './shipplan.ts';
export * from './codemap.ts';
export * from './decks.ts';

/** Project slug (per ship). */
export const PublicProject = z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/);
export type PublicProject = z.infer<typeof PublicProject>;

/** Owner-chosen public display text: conservative charset, short. */
export const DisplayText = z.string().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9 '&.\-]*$/);

/**
 * Owner customisation of a procedurally generated ship. Enums and bounded integers only (no free text),
 * so it is safe to publish. Anything omitted falls back to the deterministic generator.
 */
export const DecorKind = z.enum(['solar', 'dish', 'antenna', 'crane', 'garden', 'lights', 'radiator', 'tank']);
export const ShipLook = z.object({
  /** generator seed variant (0 = default derived from ship id) */
  variant: z.number().int().min(0).max(999).default(0),
  hull: z.enum(['auto', 'wedge', 'long', 'ring', 'compact', 'twin']).default('auto'),
  palette: z.enum(['auto', 'steel-orange', 'navy-cyan', 'white-red', 'olive-amber', 'graphite-violet', 'sand-teal']).default('auto'),
  thrusters: z.number().int().min(0).max(12).optional(),
  cargoSide: z.enum(['auto', 'port', 'starboard']).default('auto'),
  padSide: z.enum(['auto', 'port', 'starboard', 'none']).default('auto'),
  /** module placement overrides on the generator's slot grid */
  modules: z.array(z.object({ project: PublicProject, slot: z.number().int().min(0).max(23) }).strict()).max(12).default([]),
  /** decor: explicit list replaces the generated decor when `decorMode` is 'custom' */
  decorMode: z.enum(['generated', 'custom']).default('generated'),
  decor: z.array(z.object({ kind: DecorKind, anchor: z.number().int().min(0).max(63), flip: z.boolean().default(false) }).strict()).max(24).default([]),
}).strict();
export type ShipLook = z.infer<typeof ShipLook>;

/** Safe generic project name every ship publishes unless its owner opts in to real names: "<SHIP> Project". */
export function defaultProjectName(shipId: string): string { return `${shipId.toUpperCase()} Project`; }

/** Settings the public service returns to a ship's agent in the /internal/publish response (owner-controlled; unknown fields are ignored by old agents). */
export const ReplicaSettings = z.object({
  showRealNames: z.boolean(),
  /** owner pressed "Pause publishing" on the website: the agent stops sending new events (it keeps its heartbeat). Absent = not paused. */
  paused: z.boolean().optional(),
  /** ship look saved in the website's hosted Ship Builder. Absent = the owner never used it (leave the local look alone); null = the owner reset it. Validated again by the agent (ShipLook). */
  look: z.unknown().optional(),
  /** when that look (a ShipLook, or a ShipPlan v2 `{v:2,...}`) was last changed on the website (ISO time); the most recent change wins against a local edit */
  lookAt: z.string().max(40).optional(),
  /**
   * Zero-touch onboarding (see agentlink.ts): the owner's choices about the projects the agent NOTICED, the publish delay and which tools are off.
   * Typed loosely here on purpose: a bad value in one of them must never drop `paused` or `showRealNames`; the agent validates each with
   * parseProjectChoices / parseDelay / parseAdaptersOff and clamps. Absent = no choice made.
   */
  projects: z.unknown().optional(),
  delaySeconds: z.unknown().optional(),
  adapters: z.unknown().optional(),
  /**
   * The Botwarren Companion install directive (opt-in, separate component). Typed loosely and validated by
   * the agent, which accepts ONLY `{ want: 'install' | 'remove', consent: <ISO time> }`: never a URL, a version to fetch or a command.
   */
  companion: z.unknown().optional(),
  /** Code map (opt-in per ship, default off): the agent may read the file paths of its own agents' tool calls ON THIS COMPUTER to place crew in areas. Anything but an explicit true = off. */
  codeMap: z.boolean().optional(),
});
export type ReplicaSettings = z.infer<typeof ReplicaSettings>;

/** Public manifest describing a ship (set by the ship owner's config; replicated as metadata). */
export const ShipManifest = z.object({
  name: DisplayText,
  projects: z.array(z.object({ id: PublicProject, name: DisplayText, building: DisplayText.optional() }).strict()).min(1).max(12),
  look: ShipLook.optional(),
  /** the owner's Refit layout (ShipPlan v2); wins over `look` when both exist */
  plan: ShipPlanV2.optional(),
  /** the owner allows the layout to be copied as a blueprint code (opt in, default off) */
  remixable: z.boolean().optional(),
}).strict();
export type ShipManifest = z.infer<typeof ShipManifest>;

export const WorkerState = z.enum(['working', 'idle', 'waiting_for_human', 'unknown', 'left']);
export const WorkerFocus = z.enum(['bugfix', 'feature', 'ops', 'docs', 'unknown']);
export const WorkerStep = z.enum(['thinking', 'reading', 'editing', 'running', 'researching', 'delegating', 'other']);
export type WorkerStep = z.infer<typeof WorkerStep>;
export type WorkerFocus = z.infer<typeof WorkerFocus>;
export type WorkerState = z.infer<typeof WorkerState>;

export const PublicCiStatus = z.enum(['queued', 'running', 'manual', 'passed', 'failed', 'canceled', 'skipped', 'unknown']);
export type PublicCiStatus = z.infer<typeof PublicCiStatus>;

export const PublicPurpose = z.enum(['integration', 'release_train', 'deploy', 'review', 'other']);
export type PublicPurpose = z.infer<typeof PublicPurpose>;

export const PublicDeployPhase = z.enum(['queued', 'running', 'deployed', 'parity_verified', 'production_verified', 'failed', 'unknown']);
export type PublicDeployPhase = z.infer<typeof PublicDeployPhase>;

/**
 * Coarse context-window fill of an agent session, BUCKETED locally in the collector from numeric token-usage metadata
 * (never from text). Only this enum is ever public; raw token counts and the window size never leave the collector.
 * 'unknown' = no usage metadata (other harnesses, no data yet): the art shows nothing rather than inventing a value.
 */
export const ContextFill = z.enum(['unknown', 'low', 'mid', 'high', 'full']);
export type ContextFill = z.infer<typeof ContextFill>;

/** Bucket edges as a fraction of the window: low < 25%, mid 25-60%, high 60-85%, full > 85%. A non-finite or negative fraction is 'unknown'. */
export function bucketContext(fraction: number): ContextFill {
  if (!Number.isFinite(fraction) || fraction < 0) return 'unknown';
  return fraction < 0.25 ? 'low' : fraction < 0.6 ? 'mid' : fraction < 0.85 ? 'high' : 'full';
}

export const JobCategory = z.enum(['lint', 'test', 'build', 'security', 'deploy', 'verify', 'other']);

/**
 * Branch name → public label under the DisplayText rules, or null when nothing safe is left.
 * Only ever used for ships whose owner opted in to "Show branch names". Slashes/underscores become hyphens, every
 * other character outside the DisplayText charset is dropped, token-looking runs are refused.
 */
export function branchLabel(name: string | undefined | null): string | null {
  if (!name) return null;
  if (/[0-9a-f]{20,}/i.test(name) || /[A-Za-z0-9+]{32,}/.test(name)) return null; // hashes / secrets
  const cleaned = name.replace(/[/_]+/g, '-').replace(/[^A-Za-z0-9 '&.\-]/g, '').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40).replace(/[ .-]+$/, '');
  const parsed = DisplayText.safeParse(cleaned);
  return parsed.success ? parsed.data : null;
}

const Key = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-[a-z0-9]{8}$`));
const Iso = z.string().datetime({ offset: true });

const common = {
  v: z.literal(1),
  seq: z.number().int().nonnegative(),
  occurredAt: Iso,
  publishedAt: Iso,
  certainty: z.enum(['observed', 'inferred', 'unknown']),
  demo: z.boolean(),
};

export const PublicEvent = z.discriminatedUnion('kind', [
  z.object({
    ...common,
    kind: z.literal('worker'),
    project: PublicProject,
    worker: Key('w'),
    harness: z.enum(['claude', 'codex', 'muse', 'unknown']),
    state: WorkerState,
    /** inferred from a locally classified task category; absent on older events */
    focus: WorkerFocus.optional(),
    /** crew structure (pseudonymous): sub-agent / pairing partner of `parent` */
    role: z.enum(['main', 'subagent', 'pair']).optional(),
    parent: Key('w').optional(),
    model: z.enum(['opus', 'sonnet', 'haiku', 'gpt', 'other']).optional(),
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('step'),
    project: PublicProject,
    worker: Key('w'),
    step: WorkerStep,
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('mishap'),
    project: PublicProject,
    worker: Key('w'),
    cause: z.enum(['tool_error']),
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('context'),
    project: PublicProject,
    worker: Key('w'),
    /** bucketed context fill (never a raw token count) */
    fill: ContextFill,
    /** the session's context was just compacted (a moment, metadata only); `fill` is the bucket after compaction */
    compacted: z.boolean().optional(),
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('area'),
    project: PublicProject,
    worker: Key('w'),
    /** Code map (opt-in): the opaque index of the area this crew member's latest tool call touched, and the tool family (never which file) */
    area: AreaIndex,
    act: AreaAct,
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('areas'),
    project: PublicProject,
    /** Code map (opt-in): the project's areas, each an opaque index, a closed-enum kind and a staleness bucket */
    areas: PublicAreas,
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('pipeline'),
    project: PublicProject,
    pipeline: Key('p'),
    provider: z.enum(['gitlab', 'github', 'codeberg', 'local']),
    purpose: PublicPurpose,
    status: PublicCiStatus,
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('job'),
    project: PublicProject,
    pipeline: Key('p'),
    job: Key('j'),
    category: JobCategory,
    status: PublicCiStatus,
    retried: z.boolean(),
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('deploy'),
    project: PublicProject,
    deploy: Key('d'),
    phase: PublicDeployPhase,
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('project'),
    project: PublicProject,
    /** logarithmic size tier 1..8 (see SIZE_TIERS) */
    sizeTier: z.number().int().min(1).max(8),
    /** source lines rounded to 2 significant figures */
    linesApprox: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('repo_push'),
    project: PublicProject,
    /** the repository's default branch or any other branch; never a name unless `branch` is present (owner opt-in) */
    target: z.enum(['default', 'other']),
    commits: z.number().int().min(1).max(999),
    branch: DisplayText.optional(),
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('repo_branch'),
    project: PublicProject,
    action: z.enum(['created', 'deleted']),
    branch: DisplayText.optional(),
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('change'),
    project: PublicProject,
    change: Key('r'),
    action: z.enum(['opened', 'merged', 'closed']),
    branch: DisplayText.optional(),
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('feed'),
    source: z.enum(['herdr', 'gitlab', 'github']),
    health: z.enum(['healthy', 'delayed', 'disconnected', 'recovering']),
  }).strict(),
]);
export type PublicEvent = z.infer<typeof PublicEvent>;
export type PublicEventDraft = PublicEvent extends infer T ? (T extends PublicEvent ? Omit<T, 'seq' | 'publishedAt'> : never) : never;

/** Public world state, reduced only from public events (used by public server + browser). */
export interface PublicWorker { worker: string; project: PublicProject; harness: string; state: WorkerState; since: string; lastAt: string; certainty: string; demo: boolean; focus: WorkerFocus; lastMishapAt: string | null; step?: WorkerStep; stepAt?: string; recentSteps?: { step: WorkerStep; at: string }[]; role?: 'main' | 'subagent' | 'pair'; parent?: string; model?: string; context?: ContextFill; compactedAt?: string; /** Code map: the area this crew member's latest tool call touched (index) and when (the renderer only walks there while working and the call is recent) */ area?: number; areaAt?: string; areaAct?: 'edit' | 'read' | 'other'; /** when this crew member was first seen (survives state changes): the "on shift" clock */ born?: string }
export interface PublicPipeline { pipeline: string; project: PublicProject; provider: string; purpose: PublicPurpose; status: PublicCiStatus; lastAt: string; jobs: Record<string, { category: string; status: PublicCiStatus; retried: boolean }>; demo: boolean }
export interface PublicDeploy { deploy: string; project: PublicProject; phase: PublicDeployPhase; lastAt: string; demo: boolean }
export interface PublicProjectSize { sizeTier: number; linesApprox: number; lastAt: string }
export type PublicRepoMoment = { kind: 'push' | 'branch_created' | 'branch_deleted' | 'change_opened' | 'change_merged' | 'change_closed'; at: string; n?: number; branch?: string };
/** Bounded recent repository activity per project (connected code host): counts and timings only. */
export interface PublicRepoActivity { recent: PublicRepoMoment[]; lastAt: string }
/** Code map (opt-in): a project's areas as last published */
export interface PublicProjectAreas { areas: PublicArea[]; lastAt: string }
export interface PublicWorld {
  areas?: Record<string, PublicProjectAreas>;
  repos?: Record<string, PublicRepoActivity>;
  lastSeq: number;
  projects: Record<string, PublicProjectSize>;
  workers: Record<string, PublicWorker>;
  pipelines: Record<string, PublicPipeline>;
  deploys: Record<string, PublicDeploy>;
  feeds: Record<string, { health: string; lastAt: string }>;
}

export function emptyPublicWorld(): PublicWorld {
  return { lastSeq: 0, projects: {}, repos: {}, workers: {}, pipelines: {}, deploys: {}, feeds: {} };
}

/** Pure public reducer. Events must be applied in seq order; lower/equal seq is ignored (idempotent). */
export function applyPublic(w: PublicWorld, e: PublicEvent): boolean {
  if (e.seq <= w.lastSeq) return false;
  w.lastSeq = e.seq;
  switch (e.kind) {
    case 'worker': {
      const cur = w.workers[e.worker];
      if (e.state === 'left') { delete w.workers[e.worker]; return true; }
      w.workers[e.worker] = {
        worker: e.worker, project: e.project, harness: e.harness, state: e.state,
        born: cur?.born ?? e.occurredAt,
        since: cur && cur.state === e.state ? cur.since : e.occurredAt, lastAt: e.occurredAt, certainty: e.certainty, demo: e.demo,
        focus: e.focus ?? cur?.focus ?? 'unknown', lastMishapAt: cur?.lastMishapAt ?? null,
        ...(e.role ? { role: e.role } : cur?.role ? { role: cur.role } : {}),
        ...(e.parent ? { parent: e.parent } : cur?.parent ? { parent: cur.parent } : {}),
        ...(e.model ? { model: e.model } : cur?.model ? { model: cur.model } : {}),
        ...(cur?.context ? { context: cur.context } : {}),
        ...(cur?.compactedAt ? { compactedAt: cur.compactedAt } : {}),
        ...(cur?.area ? { area: cur.area, areaAt: cur.areaAt!, areaAct: cur.areaAct! } : {}),
        ...(cur?.step ? { step: cur.step, stepAt: cur.stepAt!, recentSteps: cur.recentSteps ?? [] } : {}),
      };
      return true;
    }
    case 'step': {
      const cur = w.workers[e.worker];
      if (cur) {
        cur.step = e.step; cur.stepAt = e.occurredAt;
        cur.recentSteps = [...(cur.recentSteps ?? []), { step: e.step, at: e.occurredAt }].slice(-8);
      }
      return true;
    }
    case 'mishap': {
      const cur = w.workers[e.worker];
      if (cur) cur.lastMishapAt = e.occurredAt;
      return true;
    }
    case 'area': {
      const cur = w.workers[e.worker];
      if (cur) { cur.area = e.area; cur.areaAt = e.occurredAt; cur.areaAct = e.act; }
      return true;
    }
    case 'areas':
      (w.areas ??= {})[e.project] = { areas: e.areas, lastAt: e.occurredAt };
      return true;
    case 'context': {
      const cur = w.workers[e.worker];
      if (cur) { cur.context = e.fill; if (e.compacted) cur.compactedAt = e.occurredAt; }
      return true;
    }
    case 'pipeline': {
      const cur = w.pipelines[e.pipeline];
      w.pipelines[e.pipeline] = { pipeline: e.pipeline, project: e.project, provider: e.provider, purpose: e.purpose, status: e.status, lastAt: e.occurredAt, jobs: cur?.jobs ?? {}, demo: e.demo };
      return true;
    }
    case 'job': {
      const p = (w.pipelines[e.pipeline] ??= { pipeline: e.pipeline, project: e.project, provider: 'gitlab', purpose: 'other', status: 'unknown', lastAt: e.occurredAt, jobs: {}, demo: e.demo });
      p.jobs[e.job] = { category: e.category, status: e.status, retried: e.retried };
      return true;
    }
    case 'deploy':
      w.deploys[e.deploy] = { deploy: e.deploy, project: e.project, phase: e.phase, lastAt: e.occurredAt, demo: e.demo };
      return true;
    case 'project':
      (w.projects ??= {})[e.project] = { sizeTier: e.sizeTier, linesApprox: e.linesApprox, lastAt: e.occurredAt };
      return true;
    case 'repo_push': pushRepo(w, e.project, { kind: 'push', at: e.occurredAt, n: e.commits, ...(e.branch ? { branch: e.branch } : {}) }); return true;
    case 'repo_branch': pushRepo(w, e.project, { kind: e.action === 'created' ? 'branch_created' : 'branch_deleted', at: e.occurredAt, ...(e.branch ? { branch: e.branch } : {}) }); return true;
    case 'change': pushRepo(w, e.project, { kind: `change_${e.action}`, at: e.occurredAt, ...(e.branch ? { branch: e.branch } : {}) }); return true;
    case 'feed':
      w.feeds[e.source] = { health: e.health, lastAt: e.occurredAt };
      return true;
  }
}

const REPO_RECENT = 20;
function pushRepo(w: PublicWorld, project: string, m: PublicRepoMoment): void {
  const r = ((w.repos ??= {})[project] ??= { recent: [], lastAt: m.at });
  r.recent = [...r.recent, m].slice(-REPO_RECENT);
  r.lastAt = m.at;
}

/** Keeps the public world bounded: drop finished pipelines/deploys older than `keep` entries. */
export function prunePublicWorld(w: PublicWorld, keep = 40): void {
  for (const map of [w.pipelines, w.deploys] as Record<string, { lastAt: string }>[]) {
    const entries = Object.entries(map).sort(([, a], [, b]) => (a.lastAt < b.lastAt ? 1 : -1));
    for (const [k] of entries.slice(keep)) delete map[k];
  }
}

/** Upper bounds (exclusive) of size tiers 1..7; tier 8 is ≥ 1M lines. */
export const SIZE_TIERS = [5_000, 20_000, 50_000, 100_000, 250_000, 500_000, 1_000_000] as const;
export function sizeTier(lines: number): number {
  const i = SIZE_TIERS.findIndex((b) => lines < b);
  return i === -1 ? 8 : i + 1;
}
export function roundSig(n: number, sig = 2): number {
  if (n <= 0) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(n)) - sig + 1);
  return Math.round(n / p) * p;
}

