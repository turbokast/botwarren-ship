/**
 * VENDORED FILE: codemap.ts of the Botwarren core contract (event schema, local reducer, one-way public projection, public schema).
 * Copied verbatim from the Botwarren core package when this repository was exported; the only edits are this header and, in
 * public.ts, the removal of constants that belong to the hosted service. Do not edit here: changes to the public contract are made
 * upstream and re-exported, and reviewed as a change to what this agent may publish.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * Code map: the pure, browser-safe half of "areas of a codebase inside a project's room".
 *
 * PRIVACY SHAPE (read this first). Folder names and file paths exist only inside the owner's computer, and only while the owner has
 * switched Code map on. Everything in this file that is exported to the public contract is a closed enum or a small integer:
 *   - an area INDEX 1..AREA_MAX (opaque; assigned in a salted-hash order, so it says nothing about names or sizes),
 *   - an area KIND (closed enum, classified locally from the folder's name; the name itself never leaves),
 *   - a STALENESS bucket (closed enum, from time since the area last changed).
 * `deriveAreas` is a pure function from a list of tracked file paths to a grouping. It never emits names: the node side
 * (apps/shipagent/src/readers/codemap.ts) keeps the names in memory, hashes them with a per-install random salt and sends indices.
 *
 * TRUTH RULE. Staleness is a FACT (how long ago the area last changed in git, or an edit the agent saw), never a judgement of
 * quality. The words are time ranges ("last changed 3 to 6 months ago"), never "bad", "dead" or "neglected".
 */
import { z } from 'zod';

export const AREA_MAX = 9;

/** time since an area last changed, bucketed. 'unknown' = no history yet: the art shows nothing rather than inventing a value. */
export const Staleness = z.enum(['unknown', 'today', 'week', 'month', 'quarter', 'half', 'year', 'long']);
export type Staleness = z.infer<typeof Staleness>;

export const AreaKind = z.enum(['server', 'ui', 'tests', 'docs', 'infra', 'data', 'tooling', 'other']);
export type AreaKind = z.infer<typeof AreaKind>;

export const AreaIndex = z.number().int().min(1).max(AREA_MAX);

/** one area of a project's room, as published */
export const PublicArea = z.object({ i: AreaIndex, kind: AreaKind, stale: Staleness }).strict();
export type PublicArea = z.infer<typeof PublicArea>;

/** the areas of one project: unique indices, 1..AREA_MAX of them */
export const PublicAreas = z.array(PublicArea).min(1).max(AREA_MAX).refine((a) => new Set(a.map((x) => x.i)).size === a.length, 'duplicate area index');

const DAY = 86_400_000;
/** Edges: under a day, a week, a month (30 d), 3 months (90 d), 6 months (180 d), a year (365 d); beyond that 'long'. */
export function stalenessOf(ageMs: number): Staleness {
  if (!Number.isFinite(ageMs)) return 'unknown';
  const a = Math.max(0, ageMs);
  return a < DAY ? 'today' : a < 7 * DAY ? 'week' : a < 30 * DAY ? 'month' : a < 90 * DAY ? 'quarter' : a < 180 * DAY ? 'half' : a < 365 * DAY ? 'year' : 'long';
}

/** How worn the art is: 0 clean (today to a month, or unknown), 1 light dust, 2 cobwebs, 3 overgrown, 4 a skeleton in a spacesuit. */
export type DecayStage = 0 | 1 | 2 | 3 | 4;
export function decayStage(s: Staleness): DecayStage {
  switch (s) {
    case 'quarter': return 1;
    case 'half': return 2;
    case 'year': return 3;
    case 'long': return 4;
    default: return 0;
  }
}

/** the tooltip's time words: a RANGE, never a verdict */
export function stalenessText(s: Staleness): string {
  switch (s) {
    case 'today': return 'changed today';
    case 'week': return 'changed this week';
    case 'month': return 'changed this month';
    case 'quarter': return 'last changed 1 to 3 months ago';
    case 'half': return 'last changed 3 to 6 months ago';
    case 'year': return 'last changed 6 to 12 months ago';
    case 'long': return 'last changed over a year ago';
    default: return 'no history yet';
  }
}

/** "Area 3", or the owner's name for it (only ever passed when the ship shows real names) */
export function areaLabel(i: number, name?: string | null): string { return name ? name : `Area ${i}`; }
export function areaTooltip(i: number, stale: Staleness, name?: string | null): string { return `${areaLabel(i, name)} · ${stalenessText(stale)}`; }

/** a crew member's tool call at an area: the tool family only (never which file) */
export const AreaAct = z.enum(['edit', 'read', 'other']);
export type AreaAct = z.infer<typeof AreaAct>;

/** Owner-chosen area names, per project: only ever published while the ship shows real names (the cloud enforces this). */
export const AreaNames = z.record(z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/), z.record(z.string().regex(/^[1-9]$/), z.string().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9 '&.\-]*$/)));
export type AreaNames = z.infer<typeof AreaNames>;

// ------------------------------------------------------------------ local derivation (names stay on this side of the boundary)

/** Directories that hold several sub-projects: their children become the units. */
const CONTAINERS = new Set(['apps', 'packages', 'services', 'libs', 'modules', 'crates', 'projects', 'plugins', 'cmd', 'internal', 'pkg', 'src', 'lib']);
/** Never an area of their own: dependencies, build output, caches. */
const IGNORED = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', '.git', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'bower_components', 'deps', '_build', 'priv']);

const KIND_RULES: [AreaKind, RegExp][] = [
  ['tests', /^(?:tests?|__tests__|specs?|e2e|cypress|playwright|testing|qa|fixtures?|mocks?|integration|benchmarks?)$/],
  ['docs', /^(?:docs?|documentation|wiki|guides?|research|design|adrs?|rfcs?|proposals?|handbook|manual|website|blog)$/],
  ['infra', /^(?:infra|infrastructure|deploy|deployment|ops|terraform|k8s|kubernetes|helm|docker|ci|cd|charts?|ansible|cloud|cdk|pulumi|packaging|install|installer|release|releases|github|gitlab|circleci|nix|systemd|orchestration)$/],
  ['ui', /^(?:web|ui|frontend|front|client|clients|app|site|www|public|static|assets|components?|pages|views|styles?|css|mobile|ios|android|desktop|storybook|art|graphics|icons?|images|themes?|renderer|canvas|audio|media)$/],
  ['data', /^(?:data|datasets?|migrations?|seeds?|schemas?|sql|db|database|models?|prisma|warehouse|analytics|etl)$/],
  ['server', /^(?:server|servers?|backend|back|api|apis|service|services|core|engine|lib|libs|internal|cmd|pkg|worker|workers|handlers?|controllers?|routes?|collector|relay|agent|daemon|gateway|rpc|graphql)$/],
  ['tooling', /^(?:scripts?|tools?|tooling|bin|utils?|devtools?|config|configs?|conf|hack|taskfiles?|makefiles?|lint|generators?|codegen)$/],
];

/** Classify a folder NAME into a coarse kind. Runs locally; only the enum is ever sent. Matches the whole name or any '-', '_' or '.' separated word. */
export function classifyFolder(name: string): AreaKind {
  const n = name.toLowerCase().replace(/^\.+/, '');
  const words = [n, ...n.split(/[-_.]+/)];
  for (const [kind, re] of KIND_RULES) if (words.some((w) => re.test(w))) return kind;
  return 'other';
}

/** an area unit: a top-level folder, a child of a container folder, or the repository root's own files */
export interface AreaUnit { /** folder path relative to the repo root ('' = root-level files) */ name: string; kind: AreaKind; files: number }
/** a group of units shown as ONE area. `anchor` (the largest unit's name) identifies it locally across runs. */
export interface AreaGroup { anchor: string; kind: AreaKind; units: string[]; files: number }

/** the repo-relative path split, or null when the file is outside any area (ignored directories, binary-looking names) */
function segments(path: string): string[] | null {
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) return null;
  const dirs = parts.slice(0, -1);
  if (dirs.some((d) => IGNORED.has(d.toLowerCase()))) return null;
  return parts;
}

/** Units from a list of tracked files (repo-relative, forward slashes). Deterministic: sorted by size then name. */
export function deriveUnits(paths: readonly string[]): AreaUnit[] {
  const top = new Map<string, { files: number; children: Map<string, number>; direct: number }>();
  let rootFiles = 0;
  for (const p of paths) {
    const s = segments(p);
    if (!s) continue;
    if (s.length === 1) { rootFiles++; continue; }
    const t = s[0]!;
    let e = top.get(t); if (!e) { e = { files: 0, children: new Map(), direct: 0 }; top.set(t, e); }
    e.files++;
    if (s.length === 2) e.direct++; else e.children.set(s[1]!, (e.children.get(s[1]!) ?? 0) + 1);
  }
  const units: AreaUnit[] = [];
  for (const [name, e] of top) {
    const lower = name.toLowerCase();
    // a container with several real sub-folders is split into them; a lone sub-folder stays one unit
    if (CONTAINERS.has(lower) && e.children.size >= 2) {
      for (const [c, n] of e.children) units.push({ name: `${name}/${c}`, kind: classifyFolder(c) === 'other' ? classifyFolder(name) : classifyFolder(c), files: n });
      if (e.direct > 0) units.push({ name, kind: classifyFolder(name), files: e.direct });
    } else units.push({ name, kind: classifyFolder(name), files: e.files });
  }
  if (rootFiles > 0) units.push({ name: '', kind: 'other', files: rootFiles });
  return units.sort((a, b) => b.files - a.files || (a.name < b.name ? -1 : 1));
}

/**
 * Groups units into at most `max` areas, deterministically:
 *  1. tiny units (under 1% of the files and at most 2) fold into one 'other' pool,
 *  2. while there are too many areas, merge the pair of SAME-kind areas with the fewest combined files, else the two smallest areas
 *     (the merged area keeps the larger one's anchor and, across kinds, becomes 'other').
 */
export function groupAreas(units: readonly AreaUnit[], max = AREA_MAX): AreaGroup[] {
  const total = units.reduce((n, u) => n + u.files, 0);
  let groups: AreaGroup[] = [];
  const pool: AreaGroup[] = [];
  for (const u of units) {
    const g: AreaGroup = { anchor: u.name, kind: u.kind, units: [u.name], files: u.files };
    if (units.length > max && u.files <= 2 && u.files * 100 < total) pool.push(g); else groups.push(g);
  }
  if (pool.length) {
    const big = pool.slice().sort((a, b) => b.files - a.files || (a.anchor < b.anchor ? -1 : 1))[0]!;
    groups.push({ anchor: big.anchor, kind: 'other', units: pool.flatMap((g) => g.units), files: pool.reduce((n, g) => n + g.files, 0) });
  }
  const order = (a: AreaGroup, b: AreaGroup): number => b.files - a.files || (a.anchor < b.anchor ? -1 : 1);
  const merge = (a: AreaGroup, b: AreaGroup): AreaGroup => {
    const [big, small] = order(a, b) <= 0 ? [a, b] : [b, a];
    return { anchor: big.anchor, kind: big.kind === small.kind ? big.kind : 'other', units: [...big.units, ...small.units], files: big.files + small.files };
  };
  while (groups.length > max) {
    let best: [number, number] | null = null, bestFiles = Infinity;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      if (groups[i]!.kind !== groups[j]!.kind) continue;
      const n = groups[i]!.files + groups[j]!.files;
      if (n < bestFiles) { bestFiles = n; best = [i, j]; }
    }
    if (!best) {
      const sorted = groups.map((g, i) => ({ g, i })).sort((a, b) => a.g.files - b.g.files || (a.g.anchor < b.g.anchor ? 1 : -1));
      best = [sorted[0]!.i, sorted[1]!.i];
    }
    const [i, j] = best;
    const merged = merge(groups[i]!, groups[j]!);
    groups = groups.filter((_g, k) => k !== i && k !== j);
    groups.push(merged);
  }
  return groups.sort(order);
}

/** unit name -> index in a group list, for resolving a path */
export function unitIndex(groups: readonly AreaGroup[]): Map<string, number> {
  const m = new Map<string, number>();
  groups.forEach((g, gi) => { for (const u of g.units) m.set(u, gi); });
  return m;
}

/**
 * Which group a repo-relative path belongs to: the longest known unit prefix (`lib/web/x.ts` -> unit `lib/web`, else `lib`, else the
 * root-level-files unit), else the 'other' group, else null. Pure; the caller discards the path immediately.
 */
export function groupOfPath(index: ReadonlyMap<string, number>, groups: readonly AreaGroup[], relPath: string): number | null {
  const s = relPath.split('/').filter((p) => p !== '' && p !== '.');
  if (s.length === 0 || s[0] === '..') return null;
  if (s.slice(0, -1).some((d) => IGNORED.has(d.toLowerCase()))) return null;
  if (s.length === 1) { const r = index.get(''); if (r !== undefined) return r; }
  if (s.length >= 3) { const a = index.get(`${s[0]}/${s[1]}`); if (a !== undefined) return a; }
  const t = index.get(s[0]!);
  if (t !== undefined) return t;
  const other = groups.findIndex((g) => g.kind === 'other');
  return other >= 0 ? other : null;
}
