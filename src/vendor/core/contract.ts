/**
 * VENDORED FILE: contract.ts of the Botwarren core contract (event schema, local reducer, one-way public projection, public schema).
 * Copied verbatim from the Botwarren core package when this repository was exported; the only edits are this header and, in
 * public.ts, the removal of constants that belong to the hosted service. Do not edit here: changes to the public contract are made
 * upstream and re-exported, and reviewed as a change to what this agent may publish.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * The subset of the core package that the open-source ship agent (apps/shipagent, published as github.com/turbokast/botwarren-ship)
 * depends on: the canonical event schema, the local world reducer, the one-way private -> public projection and the public schema.
 * `scripts/export-shipagent.mjs` vendors exactly these files into the public repository. Keep this list small: everything exported
 * here becomes part of the audited, public privacy contract. Do not add hosted-service constants, personas, captions or records.
 */
export * from './canonical.ts';
export * from './reducer.ts';
export * from './projection.ts';
export * from './public.ts';
export * from './remote.ts';
export * from './agentlink.ts';
