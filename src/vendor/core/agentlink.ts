/**
 * VENDORED FILE: agentlink.ts of the Botwarren core contract (event schema, local reducer, one-way public projection, public schema).
 * Copied verbatim from the Botwarren core package when this repository was exported; the only edits are this header and, in
 * public.ts, the removal of constants that belong to the hosted service. Do not edit here: changes to the public contract are made
 * upstream and re-exported, and reviewed as a change to what this agent may publish.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * The link between a ship's agent and its OWNER's website account (zero-touch onboarding). Everything here is OWNER-ONLY: it
 * goes agent -> owner console and back, never into a public store, projection or event.
 *
 *  - `AgentReport`: what the agent tells the owner console about itself (computer kind, agent version, which tools it can see,
 *    which projects it has noticed). A project is an OPAQUE key (`p-` + 8 hex, derived on the computer from a per-install salt) plus a
 *    display name (the repository name from its git remote, else the folder's own name). A local path NEVER appears here: the
 *    agent derives the name and drops the path. Both ends validate this schema strictly (no extra keys, bounded sizes).
 *  - Directives: what the website may tell the agent (which noticed projects to show and what to call them, publish delay, which
 *    tools are switched off). The agent validates and CLAMPS them: the cloud can only choose among things the agent itself reported
 *    and can never make the agent read anything else or run anything.
 */
import { z } from 'zod';
import { DisplayText } from './public.ts';

/** Opaque per-install project key: public-safe by construction (random-looking), but only ever sent to the owner. */
export const ProjectKey = z.string().regex(/^p-[a-f0-9]{8}$/);
export type ProjectKey = z.infer<typeof ProjectKey>;

export const AGENT_ADAPTERS = ['claude-code', 'codex', 'herdr', 'ninox', 'opencode', 'gemini-cli'] as const;
export const AgentAdapterId = z.enum(AGENT_ADAPTERS);
export type AgentAdapterId = z.infer<typeof AgentAdapterId>;

export const MAX_DISCOVERED_PROJECTS = 100;

export const AgentReport = z.object({
  v: z.literal(1),
  os: z.enum(['windows', 'macos', 'linux', 'other']),
  arch: z.enum(['x64', 'arm64', 'other']),
  /** which tools the agent can see on this computer (ids and a coarse state only) */
  adapters: z.array(z.object({ id: AgentAdapterId, state: z.enum(['ok', 'degraded', 'unsupported_version', 'failed', 'idle']), found: z.boolean() }).strict()).max(12),
  /** projects noticed from coding sessions; opaque key + display name only */
  projects: z.array(z.object({ id: ProjectKey, name: DisplayText }).strict()).max(MAX_DISCOVERED_PROJECTS),
  /** the computer is being uninstalled: the cloud stops accepting this ship secret */
  bye: z.boolean().optional(),
}).strict();
export type AgentReport = z.infer<typeof AgentReport>;

export interface ProjectChoice { id: string; show: boolean; name?: string }
export const MIN_DELAY_S = 30;
export const MAX_DELAY_S = 120;

/**
 * `settings.projects` from the website, reduced to well-formed choices. Anything malformed is dropped; the caller additionally
 * ignores keys it did not discover itself. Returns null when the field is absent or not an array (= leave things as they are).
 */
export function parseProjectChoices(raw: unknown): ProjectChoice[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ProjectChoice[] = [];
  const seen = new Set<string>();
  for (const x of raw.slice(0, MAX_DISCOVERED_PROJECTS)) {
    if (!x || typeof x !== 'object') continue;
    const o = x as { id?: unknown; show?: unknown; name?: unknown };
    const id = ProjectKey.safeParse(o.id);
    if (!id.success || seen.has(id.data) || typeof o.show !== 'boolean') continue;
    seen.add(id.data);
    const name = o.name === undefined ? null : DisplayText.safeParse(o.name);
    out.push({ id: id.data, show: o.show, ...(name?.success ? { name: name.data } : {}) });
  }
  return out;
}

/** `settings.delaySeconds`, clamped to the allowed 30..120 s; null when absent or not a number. */
export function parseDelay(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.round(raw)));
}

/** `settings.adapters`: the set of tools the owner switched OFF on the website (unknown ids ignored). null = absent. */
export function parseAdaptersOff(raw: unknown): string[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const off: string[] = [];
  for (const id of AGENT_ADAPTERS) if ((raw as Record<string, unknown>)[id] === false) off.push(id);
  return off;
}
