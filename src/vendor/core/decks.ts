/**
 * VENDORED FILE: decks.ts of the Botwarren core contract (event schema, local reducer, one-way public projection, public schema).
 * Copied verbatim from the Botwarren core package when this repository was exported; the only edits are this header and, in
 * public.ts, the removal of constants that belong to the hosted service. Do not edit here: changes to the public contract are made
 * upstream and re-exported, and reviewed as a change to what this agent may publish.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * Decks (multiple floors) for ShipPlan v2: pure helpers over the optional `decks` / `lifts` fields and the `d` field of parts
 * and statues. See `shipplan.ts` for the schema and the rules (limits, one cargo bay on the main deck, one `ci` and one `lounge`
 * deck, a socket is unique per deck). The renderer, camera and builder edit plans only through these helpers.
 *
 * Deck indices: 0 = the MAIN deck (`plan.rows`, exactly the ship as it always was), 1.. = `plan.decks[d - 1]`, bottom to top.
 * A room that no deck lists is AUTO: the generator docks it on deck 0 (so a plan with no `decks`, or an old client that does not
 * know decks, still shows every project).
 *
 * Every helper returns a NEW plan in canonical form and never throws; an edit that would break a rule is refused with a reason in
 * plain words (`{ ok: false, reason }`) instead of producing an invalid plan. No dependency on the rest of core.
 */
import {
  DECK_KINDS, MAX_DECKS, MAX_LIFTS, MAX_LIFT_COL, MAX_ROW_ROOMS, ShipPlanV2, canonicalPlan, isAmenityId, planRoomIds,
  type DeckKind, type PlanDeck, type PlanRows,
} from './shipplan.ts';

export type DeckEdit = { ok: true; plan: ShipPlanV2 } | { ok: false; reason: string };
export type RowKey = 'N' | 'S';

export const DECK_KIND_NAME: Record<DeckKind, string> = { work: 'Work deck', ci: 'Pipeline deck', lounge: 'Crew lounge' };
/** short names for the floor rail (one word, fits a 44 px button label) */
export const DECK_KIND_SHORT: Record<DeckKind, string> = { work: 'Deck', ci: 'CI', lounge: 'Lounge' };

/** number of decks including the main deck (1 for every plan saved before floors) */
export const deckCount = (plan: ShipPlanV2): number => 1 + (plan.decks?.length ?? 0);
export const isMultiDeck = (plan: ShipPlanV2): boolean => deckCount(plan) > 1;
/** the kind of deck `d` (the main deck is always `work`) */
export const deckKind = (plan: ShipPlanV2, d: number): DeckKind => (d === 0 ? 'work' : plan.decks?.[d - 1]?.k ?? 'work');

/** display name of a deck: "Main deck", "Pipeline deck", "Crew lounge" or "Deck 2" (1-based, bottom to top); enums only, never free text */
export function deckName(plan: ShipPlanV2, d: number): string {
  if (d === 0) return 'Main deck';
  const k = deckKind(plan, d);
  return k === 'work' ? `Deck ${d + 1}` : DECK_KIND_NAME[k];
}

/** the rows of deck `d`; the main deck's rows are `null` while the generator arranges them (Auto) */
export function deckRows(plan: ShipPlanV2, d: number): PlanRows | null {
  if (d === 0) return plan.rows ?? null;
  const dk = plan.decks?.[d - 1];
  return dk ? dk.rows : null;
}

/** the deck a room is listed on, or `null` when no deck lists it (Auto: the generator docks it on deck 0) */
export function deckOfRoom(plan: ShipPlanV2, id: string): number | null {
  if (plan.rows && (plan.rows.N.includes(id) || plan.rows.S.includes(id))) return 0;
  const i = (plan.decks ?? []).findIndex((d) => d.rows.N.includes(id) || d.rows.S.includes(id));
  return i < 0 ? null : i + 1;
}

/** rooms the owner listed on deck `d`, north row then south row */
export const roomsOnDeck = (plan: ShipPlanV2, d: number): string[] => { const r = deckRows(plan, d); return r ? [...r.N, ...r.S] : []; };

/** rooms that upper decks list (the generator must NOT also dock these on deck 0) */
export const upperDeckRooms = (plan: ShipPlanV2): Set<string> => new Set((plan.decks ?? []).flatMap((d) => [...d.rows.N, ...d.rows.S]));

export interface ResolvedDeck {
  index: number;
  kind: DeckKind;
  name: string;
  /** listed rows; `null` for the main deck while Auto (the generator arranges it) */
  rows: PlanRows | null;
}
export interface ResolvedDecks {
  decks: ResolvedDeck[];
  /** corridor columns of the lift shafts (sorted); empty = no lift (a single-deck ship, or Auto) */
  lifts: number[];
  /** `true` when the lift columns are Auto: the generator picks them (see `autoLiftColumn`) */
  liftAuto: boolean;
  /** projects (from `projectIds`) that no deck lists: the generator docks them on deck 0 */
  unplaced: string[];
}

/**
 * What the plan means for the renderer: the deck list, the lifts and the projects nobody placed. `projectIds` are the ship's
 * real projects. A multi-deck plan always resolves to at least one lift (Auto when `lifts` is absent) because decks without a
 * lift would strand the crew.
 */
export function resolveDecks(plan: ShipPlanV2, projectIds: readonly string[] = []): ResolvedDecks {
  const n = deckCount(plan);
  const decks: ResolvedDeck[] = Array.from({ length: n }, (_, i) => ({ index: i, kind: deckKind(plan, i), name: deckName(plan, i), rows: deckRows(plan, i) }));
  const listed = new Set(planRoomIds(plan));
  const lifts = n > 1 ? (plan.lifts?.length ? [...plan.lifts].sort((a, b) => a - b) : [autoLiftColumn()]) : [];
  return { decks, lifts, liftAuto: n > 1 && !plan.lifts?.length, unplaced: projectIds.filter((id) => !listed.has(id)) };
}

/** where an Auto lift stands: near the middle of the corridor, a column every deck has (the renderer clamps to the shortest deck) */
export const autoLiftColumn = (): number => 4;

/** the lift column a renderer may actually use on a corridor `cols` columns long (never past the end) */
export const clampLift = (col: number, cols: number): number => Math.max(0, Math.min(Math.max(0, cols - 1), col, MAX_LIFT_COL));

// ------------------------------------------------------------------ pure edits (return a new canonical plan, or a reason)
const done = (p: Record<string, unknown>): DeckEdit => {
  const r = ShipPlanV2.safeParse(p);
  return r.success ? { ok: true, plan: canonicalPlan(r.data) } : { ok: false, reason: r.error.issues[0]?.message ?? 'not a valid ship plan' };
};
const clone = (plan: ShipPlanV2): Record<string, unknown> => JSON.parse(JSON.stringify(canonicalPlan(plan))) as Record<string, unknown>;
const rowsOf = (dk: PlanDeck): { N: string[]; S: string[] } => ({ N: [...dk.rows.N], S: [...dk.rows.S] });

/** add an empty deck on top; refused at MAX_DECKS and for a second `ci` / `lounge` deck */
export function addDeck(plan: ShipPlanV2, kind: DeckKind = 'work'): DeckEdit {
  if (!DECK_KINDS.includes(kind)) return { ok: false, reason: 'unknown deck kind' };
  if (deckCount(plan) >= MAX_DECKS) return { ok: false, reason: `A ship has at most ${MAX_DECKS} decks.` };
  if (kind !== 'work' && (plan.decks ?? []).some((d) => d.k === kind)) return { ok: false, reason: kind === 'ci' ? 'There is already a Pipeline deck.' : 'There is already a Crew lounge.' };
  const p = clone(plan);
  p.decks = [...(plan.decks ?? []), { k: kind, rows: { N: [], S: [] } }];
  return done(p);
}

/**
 * remove deck `d` (1..): its rooms drop one deck down (to the end of the same row), its hull parts and statues are taken off
 * (statues return to the owner's inventory: they exist only as placements), parts on higher decks keep their deck, and the
 * last deck takes the lifts with it. The main deck cannot be removed.
 */
export function removeDeck(plan: ShipPlanV2, d: number): DeckEdit {
  if (!Number.isInteger(d) || d < 1 || d >= deckCount(plan)) return { ok: false, reason: 'That deck does not exist (the main deck cannot be removed).' };
  const decks = (plan.decks ?? []).map(rowsOfDeck);
  const gone = decks[d - 1]!;
  const below = d === 1 ? null : decks[d - 2]!;
  const p = clone(plan);
  if (d === 1) {
    // rooms fall to the main deck; while its rows are Auto the generator docks them (nothing to write)
    if (plan.rows) p.rows = { N: [...plan.rows.N, ...gone.rows.N], S: [...plan.rows.S, ...gone.rows.S] };
  } else {
    below!.rows.N.push(...gone.rows.N); below!.rows.S.push(...gone.rows.S);
  }
  decks.splice(d - 1, 1);
  // parts and statues on the removed deck come off; those higher up keep their deck (renumbered)
  const fix = <T extends { d?: number | undefined }>(list: T[] | undefined): T[] | undefined => list?.filter((x) => (x.d ?? 0) !== d).map((x) => ((x.d ?? 0) > d ? { ...x, d: (x.d as number) - 1 } : x));
  const decor = fix(plan.decor), statues = fix(plan.statues);
  if (decor) p.decor = decor;
  if (statues) p.statues = statues;
  if (decks.length) p.decks = decks.map((x) => ({ k: x.k, rows: x.rows })); else { delete p.decks; delete p.lifts; }
  return done(p);
}
const rowsOfDeck = (dk: PlanDeck): PlanDeck => ({ k: dk.k, rows: rowsOf(dk) });

/**
 * move a room to deck `to` (0 = main), onto row `row` at `index` (default: the end). Refused with a reason when the rule says no:
 * the cargo bay stays on the main deck, `ci` and `lounge` decks hold decorative rooms only, a row holds at most 8 rooms.
 * Moving onto the main deck while its rows are Auto simply unlists the room (the generator docks it there).
 */
export function moveRoomToDeck(plan: ShipPlanV2, id: string, to: number, row: RowKey = 'N', index?: number): DeckEdit {
  if (!Number.isInteger(to) || to < 0 || to >= deckCount(plan)) return { ok: false, reason: 'That deck does not exist.' };
  if (id === 'cargo' && to !== 0) return { ok: false, reason: 'The cargo bay stays on the main deck.' };
  const kind = deckKind(plan, to);
  if (kind !== 'work' && !isAmenityId(id)) return { ok: false, reason: kind === 'ci' ? 'The Pipeline deck holds decorative rooms only; project rooms live on work decks.' : 'The Crew lounge holds decorative rooms only; project rooms live on work decks.' };
  const p = clone(plan);
  const strip = (r: { N: string[]; S: string[] }) => ({ N: r.N.filter((x) => x !== id), S: r.S.filter((x) => x !== id) });
  const main = plan.rows ? strip(plan.rows) : null;
  const decks = (plan.decks ?? []).map((dk) => ({ k: dk.k, rows: strip(dk.rows) }));
  const put = (r: { N: string[]; S: string[] }) => {
    const list = r[row];
    if (list.length >= MAX_ROW_ROOMS) return false;
    list.splice(index === undefined ? list.length : Math.max(0, Math.min(index, list.length)), 0, id);
    return true;
  };
  if (to === 0) {
    if (main) { if (!put(main)) return { ok: false, reason: `A row holds at most ${MAX_ROW_ROOMS} rooms.` }; }
    // Auto main deck: unlisted = docked there by the generator
  } else if (!put(decks[to - 1]!.rows)) return { ok: false, reason: `A row holds at most ${MAX_ROW_ROOMS} rooms.` };
  if (main) p.rows = main;
  if (decks.length) p.decks = decks;
  return done(p);
}

/** set the lift columns (0..15, at most 2, unique); an empty list makes them Auto. Only multi-deck plans have lifts. */
export function setLifts(plan: ShipPlanV2, cols: readonly number[]): DeckEdit {
  if (cols.length && !isMultiDeck(plan)) return { ok: false, reason: 'A lift needs at least two decks.' };
  if (cols.length > MAX_LIFTS) return { ok: false, reason: `At most ${MAX_LIFTS} lifts.` };
  const p = clone(plan);
  if (cols.length) p.lifts = [...cols]; else delete p.lifts;
  return done(p);
}

/** change what a deck is for; the same rules as `addDeck` apply, and a `ci` / `lounge` deck must not hold project rooms (refused, never silently moved) */
export function setDeckKind(plan: ShipPlanV2, d: number, kind: DeckKind): DeckEdit {
  if (!Number.isInteger(d) || d < 1 || d >= deckCount(plan)) return { ok: false, reason: 'That deck does not exist.' };
  if (kind !== 'work' && (plan.decks ?? []).some((x, i) => i !== d - 1 && x.k === kind)) return { ok: false, reason: kind === 'ci' ? 'There is already a Pipeline deck.' : 'There is already a Crew lounge.' };
  if (kind !== 'work' && roomsOnDeck(plan, d).some((id) => !isAmenityId(id))) return { ok: false, reason: 'Move this deck’s project rooms to a work deck first.' };
  const p = clone(plan);
  p.decks = (plan.decks ?? []).map((x, i) => ({ k: i === d - 1 ? kind : x.k, rows: rowsOf(x) }));
  return done(p);
}

/** the deck a new hull part or statue defaults to when the owner places it while viewing deck `viewing` (clamped to a deck that exists) */
export const placementDeck = (plan: ShipPlanV2, viewing: number | null | undefined): number => (viewing && viewing > 0 && viewing < deckCount(plan) ? viewing : 0);

/** a sensible number of decks for a ship with this many rooms: a hint for the builder ("this ship is long; add a deck?"), never applied automatically */
export const suggestDeckCount = (roomCount: number): number => (roomCount <= 8 ? 1 : roomCount <= 14 ? 2 : 3);
