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
 * DECKS (multiple floors, optional and backward compatible). `rows` / `rm` / `decor` / `statues` describe deck 0, the MAIN deck, exactly as
 * before. `decks` lists up to MAX_DECKS - 1 EXTRA decks above it (bottom to top), each with a kind and its own rows of rooms; a part or statue
 * stands on deck `d` (absent = 0). A room not listed on any deck is Auto: the generator docks it on deck 0. A plan with no `decks` (every plan
 * saved before floors) is one deck and its canonical JSON is byte-identical to what it always was. See `decks.ts` for the pure helpers
 * (resolveDecks, addDeck, removeDeck, moveRoomToDeck) for the edits the renderer and builder use.
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
/** Hall of Fame statues a ship can stand on its hull sockets (in total, over every deck) */
export const MAX_STATUES = 8;
/** decks per ship including the main deck (so `decks` holds at most MAX_DECKS - 1 extra ones) */
export const MAX_DECKS = 4;
/** lift shafts per ship (a lift runs through every deck at a fixed corridor column) */
export const MAX_LIFTS = 2;
/** highest corridor column a lift may stand at (columns are 2 tiles; the renderer clamps to the shortest deck) */
export const MAX_LIFT_COL = 15;
/** what a deck is for: `work` holds the project rooms, `ci` is the CI and deploy deck (fabricators, the deploy bay, the release train), `lounge` is the crew lounge (idle crew rest there). One `ci` and one `lounge` at most; those two hold amenity rooms only. */
export const DECK_KINDS = ['work', 'ci', 'lounge'] as const;
export type DeckKind = (typeof DECK_KINDS)[number];
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

/** the deck a hull part or statue stands on: 0 (absent) = the main deck, 1.. = `decks[d - 1]` */
const DeckIndex = z.number().int().min(1).max(MAX_DECKS - 1);
export const PlanDecor = z.object({ k: z.enum(DECOR_KINDS), a: z.number().int().min(0).max(63), f: z.boolean().default(false), d: DeckIndex.optional() }).strict();
export type PlanDecor = z.infer<typeof PlanDecor>;

/** A Hall of Fame statue on a hull socket (the same 0-63 sockets as `decor`): `id` is one of the ship's own earned statues (the cloud checks that), `f` mirrors it. */
export const PlanStatue = z.object({ id: z.string().regex(/^st-[a-f0-9]{8}$/), a: z.number().int().min(0).max(63), f: z.boolean().default(false), d: DeckIndex.optional() }).strict();
export type PlanStatue = z.infer<typeof PlanStatue>;

export const PlanRows = z.object({ N: z.array(PlanRoomId).max(MAX_ROW_ROOMS), S: z.array(PlanRoomId).max(MAX_ROW_ROOMS) }).strict();
export type PlanRows = z.infer<typeof PlanRows>;
/** an extra deck: what it is for and the rooms on it (rows default to empty) */
export const PlanDeck = z.object({ k: z.enum(DECK_KINDS).default('work'), rows: PlanRows.default({ N: [], S: [] }) }).strict();
export type PlanDeck = z.infer<typeof PlanDeck>;
/**
 * The ship's sky (backdrop behind the station), chosen from a curated set: no uploads, so nothing to moderate. `hue` rotates the
 * backdrop's colours (degrees), `stars` is the star density (0 sparse, 1 normal, 2 dense). Optional on the plan, so every plan before
 * backgrounds is unchanged; `deep` with no tweaks is the original sky and is stored as no `bg` at all.
 */
export const SKY_IDS = ['deep', 'nebula-violet', 'nebula-teal', 'planet', 'gas-giant', 'belt', 'aurora', 'red-dwarf', 'ice-ring', 'twin-moons', 'dust-lane', 'void'] as const;
export type SkyId = (typeof SKY_IDS)[number];
export const SKY_NAMES: Record<SkyId, string> = { deep: 'Deep space', 'nebula-violet': 'Violet nebula', 'nebula-teal': 'Teal nebula', planet: 'Planet below', 'gas-giant': 'Gas giant', belt: 'Asteroid belt', aurora: 'Aurora', 'red-dwarf': 'Red dwarf', 'ice-ring': 'Ringed ice', 'twin-moons': 'Twin moons', 'dust-lane': 'Dust lane', void: 'Quiet void' };
export const PlanSky = z.object({
  id: z.enum(SKY_IDS),
  hue: z.number().int().min(0).max(359).optional(),
  stars: z.number().int().min(0).max(2).optional(),
}).strict();
export type PlanSky = z.infer<typeof PlanSky>;
/** the sky with defaults removed (hue 0, normal stars); null = the original sky, which a plan stores as no `bg` */
export function canonicalSky(bg: PlanSky | null | undefined): PlanSky | null {
  if (!bg) return null;
  const out: PlanSky = { id: bg.id };
  if (bg.hue) out.hue = bg.hue;
  if (bg.stars !== undefined && bg.stars !== 1) out.stars = bg.stars;
  return out.id === 'deep' && out.hue === undefined && out.stars === undefined ? null : out;
}

export const ShipPlanV2 = z.object({
  v: z.literal(2),
  /** generator seed for everything left Auto ("Remix" changes it); 0 = derived from the ship id alone */
  seed: z.number().int().min(0).max(999).default(0),
  bow: z.enum(['auto', ...HULL_BOWS]).default('auto'),
  stern: z.enum(['auto', ...HULL_STERNS]).default('auto'),
  pal: z.enum(['auto', ...PLAN_PALETTES]).default('auto'),
  thr: z.number().int().min(0).max(12).optional(),
  pad: z.enum(['auto', ...PAD_SIDES]).default('auto'),
  rows: PlanRows.optional(),
  rm: z.record(PlanRoomId, RoomOverride).optional(),
  decor: z.array(PlanDecor).max(MAX_DECOR * MAX_DECKS).optional(),
  /** earned statues placed on the hull; optional, so a ship without any (every plan before statues) is unchanged */
  statues: z.array(PlanStatue).max(MAX_STATUES).optional(),
  /** extra decks above the main deck, bottom to top; optional, so a single-deck ship (every plan before floors) is unchanged */
  decks: z.array(PlanDeck).max(MAX_DECKS - 1).optional(),
  /** lift shafts: corridor columns, only with at least two decks */
  lifts: z.array(z.number().int().min(0).max(MAX_LIFT_COL)).max(MAX_LIFTS).optional(),
  /** the backdrop behind the station; optional, so a plan without one (every plan before backgrounds) is unchanged */
  bg: PlanSky.optional(),
}).strict().superRefine((p, ctx) => {
  const bad = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: 'custom', message, path });
  const extra = p.decks ?? [];
  const n = 1 + extra.length; // decks including the main deck
  // rooms: unique over every deck, one cargo bay (main deck only), amenity and total caps grow with the deck count
  const placed: string[] = [...(p.rows ? [...p.rows.N, ...p.rows.S] : [])];
  if (placed.includes('cargo') && placed.filter((x) => x === 'cargo').length > 1) bad('only one cargo bay', ['rows']);
  extra.forEach((dk, i) => {
    const ids = [...dk.rows.N, ...dk.rows.S];
    if (ids.includes('cargo')) bad('the cargo bay stays on the main deck', ['decks', i, 'rows']);
    if ((dk.k === 'ci' || dk.k === 'lounge') && ids.some((id) => !isAmenityId(id))) bad('this deck holds decorative rooms only', ['decks', i, 'rows']);
    placed.push(...ids);
  });
  if (new Set(placed).size !== placed.length) bad('a room appears twice', ['rows']);
  if (placed.filter(isAmenityId).length > Math.min(MAX_AMENITIES * n, 12)) bad('too many amenity rooms', ['rows']);
  if (placed.length > 16 * n) bad('too many rooms', ['rows']);
  if (extra.filter((d) => d.k === 'ci').length > 1) bad('only one CI deck', ['decks']);
  if (extra.filter((d) => d.k === 'lounge').length > 1) bad('only one crew lounge', ['decks']);
  if (p.rm && Object.keys(p.rm).length > 16 * n) bad('too many room overrides', ['rm']);
  if (p.lifts?.length) {
    if (n < 2) bad('a lift needs at least two decks', ['lifts']);
    if (new Set(p.lifts).size !== p.lifts.length) bad('two lifts in one place', ['lifts']);
  }
  // parts and statues: a deck that exists, one thing per socket PER DECK, caps over the whole ship
  if (p.decor && p.decor.length > MAX_DECOR * n) bad('too many exterior parts', ['decor']);
  const taken = new Set<string>();
  const sock = (d: number | undefined, a: number): string => `${d ?? 0}:${a}`;
  p.decor?.forEach((d, i) => {
    if ((d.d ?? 0) >= n) bad('that deck does not exist', ['decor', i]);
    const k = sock(d.d, d.a);
    if (taken.has(k)) bad('two parts on one socket', ['decor', i]);
    taken.add(k);
  });
  if (p.statues) {
    const ids = new Set<string>();
    p.statues.forEach((t, i) => {
      if ((t.d ?? 0) >= n) bad('that deck does not exist', ['statues', i]);
      if (ids.has(t.id)) bad('a statue is placed twice', ['statues', i]);
      const k = sock(t.d, t.a);
      if (taken.has(k)) bad('two things on one socket', ['statues', i]);
      ids.add(t.id); taken.add(k);
    });
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
  if (plan.decor) out.decor = plan.decor.map((d) => ({ k: d.k, a: d.a, ...(d.f ? { f: true } : {}), ...(d.d ? { d: d.d } : {}) }));
  if (plan.statues?.length) out.statues = plan.statues.map((t) => ({ id: t.id, a: t.a, ...(t.f ? { f: true } : {}), ...(t.d ? { d: t.d } : {}) }));
  if (plan.decks?.length) out.decks = plan.decks.map((dk) => ({ ...(dk.k !== 'work' ? { k: dk.k } : {}), rows: { N: [...dk.rows.N], S: [...dk.rows.S] } }));
  if (plan.lifts?.length) out.lifts = [...plan.lifts].sort((a, b) => a - b);
  const bg = canonicalSky(plan.bg);
  if (bg) out.bg = bg;
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

/** every room id a plan names: rooms on every deck plus the ids it has overrides for (what a server checks against the ship's projects) */
export function planRoomIds(plan: ShipPlanV2): string[] {
  return [
    ...(plan.rows?.N ?? []), ...(plan.rows?.S ?? []),
    ...(plan.decks ?? []).flatMap((d) => [...d.rows.N, ...d.rows.S]),
    ...Object.keys(plan.rm ?? {}),
  ];
}

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
  delete out.statues; // earned statues belong to one ship: a blueprint code never carries them
  // one `seen` set over EVERY deck: a room appears once on the whole ship
  const seen = new Set<string>();
  const map = (ids: string[]) => ids.map(f).filter((x): x is string => x !== null && !seen.has(x) && !!seen.add(x));
  if (plan.rows) out.rows = { N: map(plan.rows.N), S: map(plan.rows.S) };
  if (plan.decks) out.decks = plan.decks.map((dk) => ({ k: dk.k, rows: { N: map(dk.rows.N), S: map(dk.rows.S) } }));
  if (plan.rm) {
    const rm: Record<string, RoomOverride> = {};
    for (const [k, v] of Object.entries(plan.rm)) { const n = f(k); if (n !== null && !(n in rm)) rm[n] = v; }
    out.rm = rm;
  }
  // statues are gone, so any hull part keeps its deck; parts on a deck the plan still has stay valid
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
  for (const id of [...planRoomIds(r.plan)]) { const m = ROLE.exec(id); if (m) roles.add(Number(m[1])); }
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
