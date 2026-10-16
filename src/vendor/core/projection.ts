/**
 * VENDORED FILE: projection.ts of the Botwarren core contract (event schema, local reducer, one-way public projection, public schema).
 * Copied verbatim from the Botwarren core package when this repository was exported; the only edits are this header and, in
 * public.ts, the removal of constants that belong to the hosted service. Do not edit here: changes to the public contract are made
 * upstream and re-exported, and reviewed as a change to what this agent may publish.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * The ONLY bridge from private canonical events to public events.
 * Deny-by-default: every output field is constructed from enums or pseudonyms;
 * `e.private` and source identifiers are never read.
 */
import type { CanonicalEvent, CiStatus, DeployPhase, HerdrStatus, PipelinePurpose, ProjectId } from './canonical.ts';
import { PublicEvent, type ContextFill, PublicProject as PublicProjectSchema, branchLabel, sizeTier, roundSig, type PublicCiStatus, type PublicEventDraft, type PublicProject, type PublicPurpose, type WorkerState } from './public.ts';

export interface ProjectionPolicy {
  /** projects approved for public display */
  publicProjects: ReadonlySet<ProjectId>;
  /** when false, fixture events are never projected */
  demoMode: boolean;
  /** keyed pseudonym (HMAC in the server). Must return 8 lowercase alnum chars. */
  pseudonym: (namespace: 'w' | 'p' | 'j' | 'd' | 'r', privateKey: string) => string;
  /**
   * Owner opt-in ("Show branch names"), default OFF. Only then may a sanitised branch label (DisplayText rules)
   * appear on repository events. Never commit messages, file paths or author identities, whatever the setting.
   */
  showBranchNames?: boolean;
  /**
   * Owner opt-in "Code map", default OFF. Only then may area events be projected (the agent reads file paths locally ONLY while this is on;
   * this is the second, independent gate). Never a path, a folder name or a file count, whatever the setting.
   */
  codeMap?: boolean;
}

export type ProjectionResult =
  | { ok: true; draft: PublicEventDraft }
  | { ok: false; reason: 'fixture_in_live_mode' | 'project_not_public' | 'unattributed' | 'not_publishable' | 'schema_violation' };

const WORKER_STATE: Record<HerdrStatus | 'ended', WorkerState> = {
  working: 'working',
  idle: 'idle',
  // Herdr "done" means the pane is ready for input; it is NOT proof work completed.
  done: 'idle',
  blocked: 'waiting_for_human',
  unknown: 'unknown',
  ended: 'left',
};

const CI: Record<CiStatus, PublicCiStatus> = {
  created: 'queued', pending: 'queued', waiting: 'queued', scheduled: 'queued',
  running: 'running', manual: 'manual', success: 'passed', failed: 'failed',
  canceled: 'canceled', skipped: 'skipped', unknown: 'unknown',
};

const PURPOSE: Record<PipelinePurpose, PublicPurpose> = {
  integration: 'integration', release_train: 'release_train', deploy: 'deploy',
  merge_request: 'review', scheduled_other: 'other', tag_release: 'deploy', other: 'other',
};

/** Public timestamps are coarsened to 5s to limit correlation with private logs. */
export function coarsen(iso: string): string {
  const t = Date.parse(iso);
  return new Date(Math.floor(t / 5000) * 5000).toISOString();
}

export function projectPublic(e: CanonicalEvent, policy: ProjectionPolicy): ProjectionResult {
  if (e.fixture && !policy.demoMode) return { ok: false, reason: 'fixture_in_live_mode' };
  const common = { v: 1 as const, occurredAt: coarsen(e.occurredAt), demo: e.fixture };
  const proj = (p: ProjectId | null): PublicProject | null => asPublicProject(p, policy);
  let draft: PublicEventDraft;

  switch (e.type) {
    case 'session.observed': {
      if (e.projectId === null) return { ok: false, reason: 'unattributed' };
      const project = proj(e.projectId);
      if (!project) return { ok: false, reason: 'project_not_public' };
      draft = {
        ...common, kind: 'worker', project, worker: `w-${policy.pseudonym('w', e.sessionKey)}`,
        harness: e.harness, state: WORKER_STATE[e.status], certainty: e.attribution.certainty,
        ...(e.workCategory !== 'unknown' ? { focus: e.workCategory } : {}),
        ...(e.role !== 'main' ? { role: e.role } : {}),
        ...(e.parentKey ? { parent: `w-${policy.pseudonym('w', e.parentKey)}` } : {}),
        ...(e.maker ? { maker: e.maker } : {}),
        ...(e.model ? { model: e.model } : {}),
        ...(e.effort ? { effort: e.effort } : {}),
      };
      break;
    }
    case 'session.activity':
      // needs the session's project from private state: see projectMishap
      return { ok: false, reason: 'not_publishable' };
    case 'session.ended':
      // Ended sessions need their project, which this event does not carry; the
      // publisher resolves it from private state and calls projectSessionEnded.
      return { ok: false, reason: 'not_publishable' };
    case 'ci.pipeline': {
      const project = proj(e.projectId);
      if (!project) return { ok: false, reason: 'project_not_public' };
      draft = {
        ...common, kind: 'pipeline', project, pipeline: `p-${policy.pseudonym('p', e.pipelineKey)}`,
        provider: e.provider, purpose: PURPOSE[e.purpose], status: CI[e.status], certainty: 'observed',
      };
      break;
    }
    case 'ci.job': {
      const project = proj(e.projectId);
      if (!project) return { ok: false, reason: 'project_not_public' };
      draft = {
        ...common, kind: 'job', project, pipeline: `p-${policy.pseudonym('p', e.pipelineKey)}`,
        job: `j-${policy.pseudonym('j', e.jobKey)}`, category: e.category, status: CI[e.status], retried: e.retried, certainty: 'observed',
      };
      break;
    }
    case 'deploy.status': {
      const project = proj(e.projectId);
      if (!project) return { ok: false, reason: 'project_not_public' };
      const phase: DeployPhase = e.phase;
      // a production_verified claim requires verification evidence, otherwise it is downgraded
      const safePhase: DeployPhase = phase === 'production_verified' && !['health_check', 'canary', 'parity_check'].includes(e.evidence) ? 'deployed' : phase;
      draft = {
        ...common, kind: 'deploy', project, deploy: `d-${policy.pseudonym('d', e.deployKey)}`, phase: safePhase,
        certainty: e.evidence === 'none' ? 'inferred' : 'observed',
      };
      break;
    }
    case 'project.metrics': {
      const project = proj(e.projectId);
      if (!project) return { ok: false, reason: 'project_not_public' };
      draft = { ...common, kind: 'project', project, sizeTier: sizeTier(e.codeLines), linesApprox: roundSig(e.codeLines), certainty: 'observed' };
      break;
    }
    case 'repo.push': {
      const project = proj(e.projectId);
      if (!project) return { ok: false, reason: 'project_not_public' };
      const branch = optInBranch(e.branchName, policy);
      draft = { ...common, kind: 'repo_push', project, target: e.branchKind, commits: Math.min(e.commits, 999), certainty: 'observed', ...(branch ? { branch } : {}) };
      break;
    }
    case 'repo.branch': {
      const project = proj(e.projectId);
      if (!project) return { ok: false, reason: 'project_not_public' };
      const branch = optInBranch(e.branchName, policy);
      draft = { ...common, kind: 'repo_branch', project, action: e.action, certainty: 'observed', ...(branch ? { branch } : {}) };
      break;
    }
    case 'repo.change': {
      const project = proj(e.projectId);
      if (!project) return { ok: false, reason: 'project_not_public' };
      const branch = optInBranch(e.branchName, policy);
      draft = { ...common, kind: 'change', project, change: `r-${policy.pseudonym('r', e.changeKey)}`, action: e.action, certainty: 'observed', ...(branch ? { branch } : {}) };
      break;
    }
    case 'project.areas': {
      if (policy.codeMap !== true) return { ok: false, reason: 'not_publishable' };
      const project = proj(e.projectId);
      if (!project) return { ok: false, reason: 'project_not_public' };
      draft = { ...common, kind: 'areas', project, areas: e.areas.map((a) => ({ i: a.i, kind: a.kind, stale: a.stale })), certainty: 'observed' };
      break;
    }
    case 'collector.heartbeat':
      draft = { ...common, kind: 'feed', source: e.collector, health: e.health, certainty: 'observed' };
      break;
  }
  // Defence in depth: the draft must validate against the strict public schema.
  const check = PublicEvent.safeParse({ ...draft, seq: 0, publishedAt: common.occurredAt });
  if (!check.success) return { ok: false, reason: 'schema_violation' };
  return { ok: true, draft };
}

function optInBranch(name: string | undefined, policy: ProjectionPolicy): string | null {
  return policy.showBranchNames === true ? branchLabel(name) : null;
}

/** Allow-listed AND representable in the public schema. */
export function asPublicProject(p: ProjectId | null, policy: ProjectionPolicy): PublicProject | null {
  if (!p || !policy.publicProjects.has(p)) return null;
  const parsed = PublicProjectSchema.safeParse(p);
  return parsed.success ? parsed.data : null;
}

export function projectSessionEnded(sessionKey: string, projectId: ProjectId | null, harness: 'claude' | 'codex' | 'muse' | 'unknown', occurredAt: string, fixture: boolean, policy: ProjectionPolicy): ProjectionResult {
  if (fixture && !policy.demoMode) return { ok: false, reason: 'fixture_in_live_mode' };
  const project = asPublicProject(projectId, policy);
  if (!project) return { ok: false, reason: 'project_not_public' };
  return {
    ok: true,
    draft: { v: 1, kind: 'worker', project, worker: `w-${policy.pseudonym('w', sessionKey)}`, harness, state: 'left', certainty: 'observed', occurredAt: coarsen(occurredAt), demo: fixture },
  };
}

export function projectStep(sessionKey: string, projectId: ProjectId | null, step: string, occurredAt: string, fixture: boolean, policy: ProjectionPolicy): ProjectionResult {
  if (fixture && !policy.demoMode) return { ok: false, reason: 'fixture_in_live_mode' };
  const project = asPublicProject(projectId, policy);
  if (!project) return { ok: false, reason: 'project_not_public' };
  const draft = { v: 1 as const, kind: 'step' as const, project, worker: `w-${policy.pseudonym('w', sessionKey)}`, step: step as 'thinking', certainty: 'observed' as const, occurredAt: coarsen(occurredAt), demo: fixture };
  return PublicEvent.safeParse({ ...draft, seq: 0, publishedAt: draft.occurredAt }).success ? { ok: true, draft } : { ok: false, reason: 'schema_violation' };
}

/** Context fill of a session (already a bucket). Never reads or carries any raw number. */
export function projectContext(sessionKey: string, projectId: ProjectId | null, fill: ContextFill, compacted: boolean, occurredAt: string, fixture: boolean, policy: ProjectionPolicy): ProjectionResult {
  if (fixture && !policy.demoMode) return { ok: false, reason: 'fixture_in_live_mode' };
  const project = asPublicProject(projectId, policy);
  if (!project) return { ok: false, reason: 'project_not_public' };
  const draft = { v: 1 as const, kind: 'context' as const, project, worker: `w-${policy.pseudonym('w', sessionKey)}`, fill, ...(compacted ? { compacted: true as const } : {}), certainty: 'observed' as const, occurredAt: coarsen(occurredAt), demo: fixture };
  return PublicEvent.safeParse({ ...draft, seq: 0, publishedAt: draft.occurredAt }).success ? { ok: true, draft } : { ok: false, reason: 'schema_violation' };
}

/** Code map (opt-in): a crew member's latest tool call touched area `area`. Only the index and the tool family; never which file. */
export function projectArea(sessionKey: string, projectId: ProjectId | null, area: number, act: 'edit' | 'read' | 'other', occurredAt: string, fixture: boolean, policy: ProjectionPolicy): ProjectionResult {
  if (policy.codeMap !== true) return { ok: false, reason: 'not_publishable' };
  if (fixture && !policy.demoMode) return { ok: false, reason: 'fixture_in_live_mode' };
  const project = asPublicProject(projectId, policy);
  if (!project) return { ok: false, reason: 'project_not_public' };
  const draft = { v: 1 as const, kind: 'area' as const, project, worker: `w-${policy.pseudonym('w', sessionKey)}`, area, act, certainty: 'observed' as const, occurredAt: coarsen(occurredAt), demo: fixture };
  return PublicEvent.safeParse({ ...draft, seq: 0, publishedAt: draft.occurredAt }).success ? { ok: true, draft } : { ok: false, reason: 'schema_violation' };
}

export function projectMishap(sessionKey: string, projectId: ProjectId | null, occurredAt: string, fixture: boolean, eventId: string, policy: ProjectionPolicy): ProjectionResult {
  if (fixture && !policy.demoMode) return { ok: false, reason: 'fixture_in_live_mode' };
  const project = asPublicProject(projectId, policy);
  if (!project) return { ok: false, reason: 'project_not_public' };
  void eventId;
  return { ok: true, draft: { v: 1, kind: 'mishap', project, worker: `w-${policy.pseudonym('w', sessionKey)}`, cause: 'tool_error', certainty: 'observed', occurredAt: coarsen(occurredAt), demo: fixture } };
}

/** Coalescing identity: a newer pending draft with the same identity supersedes the older one. */
export function draftIdentity(d: PublicEventDraft): string {
  switch (d.kind) {
    case 'worker': return `worker:${d.worker}`;
    case 'pipeline': return `pipeline:${d.pipeline}`;
    case 'job': return `job:${d.job}`;
    case 'deploy': return `deploy:${d.deploy}`;
    case 'feed': return `feed:${d.source}`;
    case 'mishap': return `mishap:${d.worker}:${d.occurredAt}`;
    case 'step': return `step:${d.worker}:${d.occurredAt}`; // keep the sequence (each step waits its own delay)
    case 'project': return `project:${d.project}`;
    case 'areas': return `areas:${d.project}`;
    // a visit is a moment: keep the sequence like steps (each waits its own delay)
    case 'area': return `area:${d.worker}:${d.occurredAt}`;
    case 'repo_push': return `repo_push:${d.project}:${d.occurredAt}:${d.target}:${d.commits}`;
    case 'repo_branch': return `repo_branch:${d.project}:${d.occurredAt}:${d.action}:${d.branch ?? ''}`;
    case 'change': return `change:${d.change}:${d.action}`;
    // plain updates coalesce (latest wins); a compaction is a moment and keeps its own slot
    case 'context': return d.compacted ? `context:${d.worker}:${d.occurredAt}` : `context:${d.worker}`;
  }
}
