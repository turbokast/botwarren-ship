/**
 * VENDORED FILE: reducer.ts of the Botwarren core contract (event schema, local reducer, one-way public projection, public schema).
 * Copied verbatim from the Botwarren core package when this repository was exported; the only edits are this header and, in
 * public.ts, the removal of constants that belong to the hosted service. Do not edit here: changes to the public contract are made
 * upstream and re-exported, and reviewed as a change to what this agent may publish.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * Pure, replayable reducer over PRIVATE canonical events.
 * Invariants:
 *  - idempotent: an eventId is applied at most once
 *  - order-tolerant: an older observation never regresses newer state
 *  - terminal CI states are not overwritten by older non-terminal reports
 */
import { TERMINAL_CI, type WorkCategory, type CanonicalEvent, type CiStatus, type DeployPhase, type Harness, type HerdrStatus, type PipelinePurpose, type ProjectId } from './canonical.ts';

export interface SessionState {
  sessionKey: string;
  harness: Harness;
  status: HerdrStatus | 'ended';
  projectId: ProjectId | null;
  attributionCertainty: 'observed' | 'inferred' | 'unknown';
  firstSeenAt: string;
  lastObservedAt: string;
  fixture: boolean;
  workCategory: WorkCategory;
  lastErrorAt: string | null;
  step?: string;
  context?: string;
}

export interface PipelineState {
  pipelineKey: string;
  projectId: ProjectId;
  provider: 'gitlab' | 'github' | 'codeberg' | 'local';
  purpose: PipelinePurpose;
  status: CiStatus;
  sourceUpdatedAt: string;
  jobs: Record<string, { category: string; status: CiStatus; retried: boolean; sourceUpdatedAt: string }>;
  fixture: boolean;
}

export interface DeployState {
  deployKey: string;
  projectId: ProjectId;
  phase: DeployPhase;
  evidence: string;
  sourceUpdatedAt: string;
}

export interface CollectorState {
  health: 'healthy' | 'delayed' | 'disconnected' | 'recovering';
  lastHeartbeatAt: string;
}

export interface ProjectMetricsState { codeLines: number; files: number; measuredAt: string }

export interface WorldState {
  applied: Set<string>;
  projects: Record<string, ProjectMetricsState>;
  sessions: Record<string, SessionState>;
  pipelines: Record<string, PipelineState>;
  deploys: Record<string, DeployState>;
  collectors: Record<string, CollectorState>;
}

export function emptyWorld(): WorldState {
  // null-prototype dictionaries: entity keys can never reach Object.prototype
  return { applied: new Set(), projects: Object.create(null), sessions: Object.create(null), pipelines: Object.create(null), deploys: Object.create(null), collectors: Object.create(null) };
}

const DEPLOY_RANK: Record<DeployPhase, number> = {
  unknown: 0, queued: 1, running: 2, failed: 3, deployed: 3, parity_verified: 4, production_verified: 5,
};

/** Returns true when `next` should replace `current` for a CI entity. */
export function ciShouldReplace(cur: { status: CiStatus; sourceUpdatedAt: string } | undefined, nextStatus: CiStatus, nextAt: string): boolean {
  if (!cur) return true;
  if (nextAt > cur.sourceUpdatedAt) return true;
  if (nextAt < cur.sourceUpdatedAt) return false;
  // same timestamp: terminal wins over non-terminal, never the reverse
  return TERMINAL_CI.has(nextStatus) && !TERMINAL_CI.has(cur.status);
}

/** Applies one event. Returns whether state changed. Mutates `w` for efficiency; callers own the instance. */
export function apply(w: WorldState, e: CanonicalEvent): boolean {
  if (w.applied.has(e.eventId)) return false;
  w.applied.add(e.eventId);
  switch (e.type) {
    case 'session.observed': {
      const cur = w.sessions[e.sessionKey];
      if (cur && e.occurredAt < cur.lastObservedAt) {
        // late delivery: never regress status, but it may be the earliest sighting
        if (e.occurredAt < cur.firstSeenAt) { cur.firstSeenAt = e.occurredAt; return true; }
        return false;
      }
      if (cur?.status === 'ended' && e.occurredAt <= cur.lastObservedAt) return false;
      w.sessions[e.sessionKey] = {
        sessionKey: e.sessionKey,
        harness: e.harness,
        status: e.status,
        projectId: e.projectId,
        attributionCertainty: e.attribution.certainty,
        firstSeenAt: cur?.firstSeenAt ?? e.occurredAt,
        lastObservedAt: e.occurredAt,
        fixture: e.fixture,
        workCategory: e.workCategory,
        lastErrorAt: cur?.lastErrorAt ?? null,
      };
      return true;
    }
    case 'session.activity': {
      const cur = w.sessions[e.sessionKey];
      if (!cur) return false;
      if (e.kind === 'step') { if (e.step) cur.step = e.step; return true; }
      if (e.kind === 'context') { if (e.context) cur.context = e.context; return true; }
      if (!cur.lastErrorAt || e.occurredAt > cur.lastErrorAt) cur.lastErrorAt = e.occurredAt;
      return true;
    }
    case 'session.ended': {
      const cur = w.sessions[e.sessionKey];
      if (!cur || e.occurredAt < cur.lastObservedAt) return false;
      cur.status = 'ended';
      cur.lastObservedAt = e.occurredAt;
      return true;
    }
    case 'ci.pipeline': {
      const cur = w.pipelines[e.pipelineKey];
      if (!ciShouldReplace(cur, e.status, e.sourceUpdatedAt)) return false;
      w.pipelines[e.pipelineKey] = {
        pipelineKey: e.pipelineKey,
        projectId: e.projectId,
        provider: e.provider,
        purpose: e.purpose,
        status: e.status,
        sourceUpdatedAt: e.sourceUpdatedAt,
        jobs: cur?.jobs ?? Object.create(null),
        fixture: e.fixture,
      };
      return true;
    }
    case 'ci.job': {
      const p = (w.pipelines[e.pipelineKey] ??= {
        pipelineKey: e.pipelineKey, projectId: e.projectId, provider: e.provider, purpose: 'other',
        status: 'unknown', sourceUpdatedAt: '0000', jobs: Object.create(null), fixture: e.fixture,
      });
      const cur = p.jobs[e.jobKey];
      if (!ciShouldReplace(cur, e.status, e.sourceUpdatedAt)) return false;
      p.jobs[e.jobKey] = { category: e.category, status: e.status, retried: e.retried, sourceUpdatedAt: e.sourceUpdatedAt };
      return true;
    }
    case 'deploy.status': {
      const cur = w.deploys[e.deployKey];
      if (cur) {
        if (e.sourceUpdatedAt < cur.sourceUpdatedAt) return false;
        if (e.sourceUpdatedAt === cur.sourceUpdatedAt && DEPLOY_RANK[e.phase] <= DEPLOY_RANK[cur.phase]) return false;
      }
      w.deploys[e.deployKey] = { deployKey: e.deployKey, projectId: e.projectId, phase: e.phase, evidence: e.evidence, sourceUpdatedAt: e.sourceUpdatedAt };
      return true;
    }
    case 'project.metrics': {
      const cur = w.projects[e.projectId];
      if (cur && e.occurredAt <= cur.measuredAt) return false;
      w.projects[e.projectId] = { codeLines: e.codeLines, files: e.files, measuredAt: e.occurredAt };
      return true;
    }
    case 'repo.push':
    case 'repo.branch':
    case 'repo.change':
      return true; // stateless: connected-repo activity is projected per ship, never kept in the private world
    case 'collector.heartbeat': {
      const cur = w.collectors[e.collector];
      if (cur && e.occurredAt < cur.lastHeartbeatAt) return false;
      w.collectors[e.collector] = { health: e.health, lastHeartbeatAt: e.occurredAt };
      return true;
    }
  }
}

/** Deterministic replay: sorted by observedAt then eventId so replays from any arrival order converge. */
export function replay(events: readonly CanonicalEvent[]): WorldState {
  const w = emptyWorld();
  const sorted = [...events].sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  for (const e of sorted) apply(w, e);
  return w;
}

/** Stable serialisation for equality tests (excludes the applied-set). */
export function worldDigest(w: WorldState): string {
  const sortObj = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ s: sortObj(w.sessions), p: sortObj(w.pipelines), d: sortObj(w.deploys), c: sortObj(w.collectors) });
}
