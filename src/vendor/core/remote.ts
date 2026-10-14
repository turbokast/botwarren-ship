/**
 * VENDORED FILE: remote.ts of the Botwarren core contract (event schema, local reducer, one-way public projection, public schema).
 * Copied verbatim from the Botwarren core package when this repository was exported; the only edits are this header and, in
 * public.ts, the removal of constants that belong to the hosted service. Do not edit here: changes to the public contract are made
 * upstream and re-exported, and reviewed as a change to what this agent may publish.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/** Git remote normalisation (shared with the open-source ship agent). */

/** Normalises ssh/https git remote URLs, stripping credentials and `.git`. */
export function normaliseRemote(url: string): string | null {
  const s = url.trim();
  const ssh = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(s);
  if (ssh) return `${ssh[1]}/${ssh[2]}`.toLowerCase();
  try {
    const u = new URL(s);
    if (!['https:', 'http:', 'ssh:'].includes(u.protocol)) return null;
    return `${u.hostname}${u.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return null;
  }
}
