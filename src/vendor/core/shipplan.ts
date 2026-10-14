/**
 * VENDORED FILE: shipplan.ts of the Botwarren core contract (event schema, local reducer, one-way public projection, public schema).
 * Copied verbatim from the Botwarren core package when this repository was exported; the only edits are this header and, in
 * public.ts, the removal of constants that belong to the hosted service. Do not edit here: changes to the public contract are made
 * upstream and re-exported, and reviewed as a change to what this agent may publish.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * ShipPlan v2: the owner's ship layout, saved by the Refit editor and published with the ship's manifest.
 *
 * Like ShipLook it is enums and bounded integers only: no free text exists, so it is public-safe by construction.
 * It is also COMPACT (hard cap `PLAN_MAX_BYTES`, typically well under 1 KB) and versioned (`v: 2`; the cloud stores it as
 * look version 2 beside ShipLook = 1).
 *
 * Auto versus Pinned is explicit in the data and there is no hidden "freeze" mode:
 *   - a scalar field is Pinned when it holds a value, Auto when it is `auto` / absent (the generator chooses and follows
 *     the ship: new projects, a new seed);
 *   - `rows` present = the owner arranged the rooms (Pinned); absent = the generator arranges them (Auto);
 *   - `decor` present = the owner placed the exterior parts (Pinned); absent = generated;
 *   - `rm[roomId]` holds only the per-room fields the owner set (size S/M/L, interior style, accent); a missing key is Auto.
 *
 * This file is pure and has no dependency on the rest of core (public.ts re-exports it and embeds it in ShipManifest).
 */
import { z } from 'zod';

export const PLAN_VERSION = 2;
/** hard cap of the canonical JSON, in bytes (the cloud API also caps request bodies) */
export const PLAN_MAX_BYTES = 8192;
export const MAX_ROW_ROOMS = 8;
export const MAX_DECOR = 24;
export const MAX_AMENITIES = 4;
/** published versions kept per ship (history / restore) */
export const HISTORY_CAP = 10;

export const HULL_BOWS = ['flat', 'wedge', 'nose', 'ring'] as const;
export const HULL_STERNS = ['flat', 'long', 'twin'] as const;
export const PLAN_PALETTES = ['steel-orange', 'navy-cyan', 'white-red', 'olive-amber', 'graphite-violet', 'sand-teal'] as const;
export const PAD_SIDES = ['port', 'starboard', 'none'] as const;
export const ROOM_STYLES = ['broadcast', 'lab', 'bridge', 'hydro', 'meter'] as const;
export const AMENITY_KINDS = ['garden', 'observatory', 'galley'] as const;
export const DECOR_KINDS = ['solar', 'dish', 'antenna', 'crane', 'garden', 'lights', 'radiator', 'tank'] as const;
export type HullBow = (typeof HULL_BOWS)[number];
export type HullStern = (typeof HULL_STERNS)[number];
export type PlanPalette = (typeof PLAN_PALETTES)[number];
export type PadSide = (typeof PAD_SIDES)[number];
export type RoomStyle = (typeof ROOM_STYLES)[number];
export type AmenityKind = (typeof AMENITY_KINDS)[number];
/** 0 small, 1 medium, 2 large */
export type RoomSize = 0 | 1 | 2;

/** A room: a project id, `cargo`, or a decorative amenity (`x-garden-1` ... `x-galley-4`). */
export const PlanRoomId = z.string().regex(/^(?:x-(?:garden|observatory|galley)-[1-4]|[a-z][a-z0-9-]{1,30}[a-z0-9])$/);
export const isAmenityId = (id: string): boolean => /^x-(?:garden|observatory|galley)-[1-4]$/.test(id);
export const amenityKind = (id: string): AmenityKind | null => (isAmenityId(id) ? (id.split('-')[1] as AmenityKind) : null);

const Size = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export const RoomOverride = z.object({
  s: Size.optional(),
  st: z.enum(ROOM_STYLES).optional(),
  ac: z.number().int().min(0).max(11).optional(),
}).strict();
export type RoomOverride = z.infer<typeof RoomOverride>;

export const PlanDecor = z.object({ k: z.enum(DECOR_KINDS), a: z.number().int().min(0).max(63), f: z.boolean().default(false) }).strict();
export type PlanDecor = z.infer<typeof PlanDecor>;

export const ShipPlanV2 = z.object({
  v: z.literal(2),
  /** generator seed for everything left Auto ("Remix" changes it); 0 = derived from the ship id alone */
  seed: z.number().int().min(0).max(999).default(0),
  bow: z.enum(['auto', ...HULL_BOWS]).default('auto'),
  stern: z.enum(['auto', ...HULL_STERNS]).default('auto'),
  pal: z.enum(['auto', ...PLAN_PALETTES]).default('auto'),
  thr: z.number().int().min(0).max(12).optional(),
  pad: z.enum(['auto', ...PAD_SIDES]).default('auto'),
  rows: z.object({ N: z.array(PlanRoomId).max(MAX_ROW_ROOMS), S: z.array(PlanRoomId).max(MAX_ROW_ROOMS) }).strict().optional(),
  rm: z.record(PlanRoomId, RoomOverride).optional(),
  decor: z.array(PlanDecor).max(MAX_DECOR).optional(),
}).strict().superRefine((p, ctx) => {
  const bad = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: 'custom', message, path });
  if (p.rows) {
    const all = [...p.rows.N, ...p.rows.S];
    if (new Set(all).size !== all.length) bad('a room appears twice', ['rows']);
    if (all.filter((x) => x === 'cargo').length > 1) bad('only one cargo bay', ['rows']);
    if (all.filter(isAmenityId).length > MAX_AMENITIES) bad('too many amenity rooms', ['rows']);
    if (all.length > 16) bad('too many rooms', ['rows']);
  }
  if (p.rm && Object.keys(p.rm).length > 16) bad('too many room overrides', ['rm']);
  if (p.decor) {
    const seen = new Set<number>();
    p.decor.forEach((d, i) => { if (seen.has(d.a)) bad('two parts on one socket', ['decor', i]); seen.add(d.a); });
  }
});
export type ShipPlanV2 = z.infer<typeof ShipPlanV2>;

/** The smallest plan: every field Auto. */
export const emptyPlan = (seed = 0): ShipPlanV2 => ({ v: 2, seed, bow: 'auto', stern: 'auto', pal: 'auto', pad: 'auto' });

/** Canonical form: defaults and empty containers removed, keys in a fixed order. Equal plans give equal JSON. */
export function canonicalPlan(plan: ShipPlanV2): ShipPlanV2 {
  const out: Record<string, unknown> = { v: 2 };
  if (plan.seed) out.seed = plan.seed;
  if (plan.bow !== 'auto') out.bow = plan.bow;
  if (plan.stern !== 'auto') out.stern = plan.stern;
  if (plan.pal !== 'auto') out.pal = plan.pal;
  if (plan.thr !== undefined) out.thr = plan.thr;
  if (plan.pad !== 'auto') out.pad = plan.pad;
  if (plan.rows) out.rows = { N: [...plan.rows.N], S: [...plan.rows.S] };
  if (plan.rm) {
    const rm: Record<string, RoomOverride> = {};
    for (const id of Object.keys(plan.rm).sort()) {
      const o = plan.rm[id]!;
      const c: RoomOverride = {};
      if (o.s !== undefined) c.s = o.s;
      if (o.st !== undefined) c.st = o.st;
      if (o.ac !== undefined) c.ac = o.ac;
      if (Object.keys(c).length) rm[id] = c;
    }
    if (Object.keys(rm).length) out.rm = rm;
  }
  if (plan.decor) out.decor = plan.decor.map((d) => (d.f ? { k: d.k, a: d.a, f: true } : { k: d.k, a: d.a }));
  return out as unknown as ShipPlanV2;
}

export const planJson = (plan: ShipPlanV2): string => JSON.stringify(canonicalPlan(plan));
export const planBytes = (plan: ShipPlanV2): number => new TextEncoder().encode(planJson(plan)).length;

/** Strict parse + size cap. Never throws. */
export function parsePlan(raw: unknown): { ok: true; plan: ShipPlanV2 } | { ok: false; reason: string } {
  const r = ShipPlanV2.safeParse(raw);
  if (!r.success) return { ok: false, reason: r.error.issues[0]?.message ?? 'not a valid ship plan' };
  if (planBytes(r.data) > PLAN_MAX_BYTES) return { ok: false, reason: 'the plan is too large' };
  return { ok: true, plan: r.data };
}

/** Same layout, whatever the key order or defaults. */
export const samePlan = (a: ShipPlanV2, b: ShipPlanV2): boolean => planJson(a) === planJson(b);

// ------------------------------------------------------------------ blueprint code (share / remix)
/**
 * A blueprint code is a plan with the owner's project ids replaced by ROLES (`r01`, `r02`, ... = the project's position in
 * the manifest), so it carries no names and maps onto whoever imports it: their first project takes role r01 and so on.
 * Text only, versioned (`BW2.` prefix), base64url JSON: it survives copy and paste and can be rebuilt after a format change.
 */
export const BLUEPRINT_PREFIX = 'BW2.';
const roleOf = (i: number): string => `r${String(i + 1).padStart(2, '0')}`;
const ROLE = /^r(\d{2})$/;

const mapIds = (plan: ShipPlanV2, f: (id: string) => string | null): ShipPlanV2 => {
  const out: ShipPlanV2 = { ...plan };
  if (plan.rows) {
    const seen = new Set<string>();
    const map = (ids: string[]) => ids.map(f).filter((x): x is string => x !== null && !seen.has(x) && !!seen.add(x));
    out.rows = { N: map(plan.rows.N), S: map(plan.rows.S) };
  }
  if (plan.rm) {
    const rm: Record<string, RoomOverride> = {};
    for (const [k, v] of Object.entries(plan.rm)) { const n = f(k); if (n !== null && !(n in rm)) rm[n] = v; }
    out.rm = rm;
  }
  return out;
};

const toB64 = (s: string): string => { const b = new TextEncoder().encode(s); let bin = ''; for (const x of b) bin += String.fromCharCode(x); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const fromB64 = (s: string): string => { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); };

export function encodeBlueprint(plan: ShipPlanV2, projectIds: string[]): string {
  const idx = new Map(projectIds.map((id, i) => [id, i]));
  const role = mapIds(canonicalPlan(plan), (id) => (idx.has(id) ? roleOf(idx.get(id)!) : id === 'cargo' || isAmenityId(id) ? id : null));
  return BLUEPRINT_PREFIX + toB64(planJson(role));
}

/** Decode a blueprint code into a role plan (ids are `rNN`). */
export function decodeBlueprint(code: string): { ok: true; plan: ShipPlanV2; roles: number } | { ok: false; reason: string } {
  const c = code.trim();
  if (!c.startsWith(BLUEPRINT_PREFIX)) return { ok: false, reason: 'That is not a Botwarren blueprint code (it should start with BW2.).' };
  const body = c.slice(BLUEPRINT_PREFIX.length);
  if (body.length > PLAN_MAX_BYTES * 2 || !/^[A-Za-z0-9_-]+$/.test(body)) return { ok: false, reason: 'That blueprint code is damaged or too long.' };
  let json: unknown;
  try { json = JSON.parse(fromB64(body)); } catch { return { ok: false, reason: 'That blueprint code is damaged.' }; }
  const r = parsePlan(json);
  if (!r.ok) return { ok: false, reason: `That blueprint code is not valid (${r.reason}).` };
  const roles = new Set<number>();
  for (const id of [...(r.plan.rows?.N ?? []), ...(r.plan.rows?.S ?? []), ...Object.keys(r.plan.rm ?? {})]) { const m = ROLE.exec(id); if (m) roles.add(Number(m[1])); }
  return { ok: true, plan: r.plan, roles: roles.size };
}

/** Map a role plan onto this ship's projects (by manifest order). Roles without a project are dropped. */
export function applyBlueprint(rolePlan: ShipPlanV2, projectIds: string[]): { plan: ShipPlanV2; mapped: number; dropped: number } {
  const ok = new Set<string>(), lost = new Set<string>();
  const plan = mapIds(rolePlan, (id) => {
    const m = ROLE.exec(id);
    if (!m) return id;
    const p = projectIds[Number(m[1]) - 1];
    if (p) { ok.add(id); return p; }
    lost.add(id); return null;
  });
  return { plan: canonicalPlan(plan), mapped: ok.size, dropped: lost.size };
}
