/**
 * On-disk update state. DEPENDENCY-FREE on purpose (shared by the launcher, which must stay tiny and never import
 * anything that an update can change). All writes are atomic (write temp, rename); all reads validate and fall back.
 *
 *   <root>/current.json                the pointer: which versions/<v> runs, trial/stable, boot counter
 *   <root>/versions/<v>/               immutable, side by side; a running version is never overwritten
 *   <root>/state/install-id            random UUID (rollout bucket input; not hardware derived)
 *   <root>/state/update-state.json     highest manifestVersion ever accepted, last check, failures
 *   <root>/state/trust.json            persisted trust: keys-document sequence, epoch, revoked key ids, added release keys
 *   <root>/state/denylist.json         versions refused after a failed trial (version -> epoch ms until)
 *   <root>/state/install-receipt.json  how this was installed (standalone | brew | scoop | ...)
 *   <root>/state/last-update-result.json  one outcome record (enum codes only)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const EXIT_RESTART_FOR_UPDATE = 75; // EX_TEMPFAIL: "exited on purpose, start the (new) current version"

export interface Pointer {
  version: string;
  previous: string | null;
  /** last version that completed a healthy trial */
  knownGood: string | null;
  state: 'trial' | 'stable';
  bootCount: number;
  trialStarted: string | null;
}

const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const okVersion = (v: unknown): v is string => typeof v === 'string' && VERSION_RE.test(v);

export const paths = (root: string) => ({
  pointer: join(root, 'current.json'),
  versions: join(root, 'versions'),
  version: (v: string) => join(root, 'versions', v),
  state: join(root, 'state'),
  installId: join(root, 'state', 'install-id'),
  updateState: join(root, 'state', 'update-state.json'),
  denylist: join(root, 'state', 'denylist.json'),
  trust: join(root, 'state', 'trust.json'),
  receipt: join(root, 'state', 'install-receipt.json'),
  lastResult: join(root, 'state', 'last-update-result.json'),
  lock: join(root, 'state', 'launcher.lock'),
  staging: join(root, 'staging'),
});

export function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
}

export function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

export function readPointer(root: string): Pointer | null {
  const j = readJson(paths(root).pointer) as Partial<Pointer> | null;
  if (!j || !okVersion(j.version)) return null;
  return {
    version: j.version,
    previous: okVersion(j.previous) ? j.previous : null,
    knownGood: okVersion(j.knownGood) ? j.knownGood : null,
    state: j.state === 'trial' ? 'trial' : 'stable',
    bootCount: typeof j.bootCount === 'number' && j.bootCount >= 0 && j.bootCount < 1000 ? Math.trunc(j.bootCount) : 0,
    trialStarted: typeof j.trialStarted === 'string' ? j.trialStarted : null,
  };
}

export function writePointer(root: string, p: Pointer): void { writeJsonAtomic(paths(root).pointer, p, 0o644); }

export function hasVersionDir(root: string, v: string): boolean { return okVersion(v) && existsSync(join(paths(root).version(v), 'agent.mjs')); }

export type Denylist = Record<string, number>;
export function readDenylist(root: string, nowMs: number): Denylist {
  const j = readJson(paths(root).denylist) as Record<string, unknown> | null;
  const out: Denylist = {};
  if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) if (okVersion(k) && typeof v === 'number' && v > nowMs) out[k] = v;
  return out;
}
export function denylistVersion(root: string, v: string, untilMs: number, nowMs: number): void {
  const d = readDenylist(root, nowMs); d[v] = untilMs; writeJsonAtomic(paths(root).denylist, d);
}

export function readOrCreateInstallId(root: string): string {
  const p = paths(root).installId;
  try { const s = readFileSync(p, 'utf8').trim(); if (/^[0-9a-f-]{36}$/.test(s)) return s; } catch { /* create */ }
  const id = randomUUID();
  mkdirSync(paths(root).state, { recursive: true, mode: 0o700 });
  writeFileSync(p, id + '\n', { mode: 0o600 });
  return id;
}

export interface UpdateState { highestManifestVersion: number; lastCheckMs: number; nextCheckMs: number; consecutiveFailures: number }
export function readUpdateState(root: string): UpdateState {
  const j = readJson(paths(root).updateState) as Partial<UpdateState> | null;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return { highestManifestVersion: n(j?.highestManifestVersion, 0), lastCheckMs: n(j?.lastCheckMs, 0), nextCheckMs: n(j?.nextCheckMs, 0), consecutiveFailures: n(j?.consecutiveFailures, 0) };
}
export function writeUpdateState(root: string, s: UpdateState): void { writeJsonAtomic(paths(root).updateState, s); }

/**
 * Persisted trust (written only after a keys document passed its 2-of-3 recovery-signature check, see trust.ts).
 * Revocations are PERMANENT: a revoked id is refused even if an old signature by it is replayed later.
 */
export interface AddedKey { id: string; spki: string; notAfter?: string }
export interface TrustState { keysSeq: number; epoch: number; revoked: string[]; added: AddedKey[] }
export const EMPTY_TRUST: TrustState = { keysSeq: 0, epoch: 1, revoked: [], added: [] };
export function readTrust(root: string): TrustState {
  const j = readJson(paths(root).trust) as Partial<TrustState> | null;
  if (!j || typeof j !== 'object') return { ...EMPTY_TRUST, revoked: [], added: [] };
  const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v);
  const int = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1_000_000_000 ? v : d);
  const added = Array.isArray(j.added) ? j.added.filter((a): a is AddedKey => !!a && id((a as AddedKey).id) && typeof (a as AddedKey).spki === 'string' && /^[A-Za-z0-9+/]{59}=$/.test((a as AddedKey).spki)).slice(0, 16) : [];
  return { keysSeq: typeof j.keysSeq === 'number' && j.keysSeq >= 0 ? Math.trunc(j.keysSeq) : 0, epoch: int(j.epoch, 1), revoked: Array.isArray(j.revoked) ? [...new Set(j.revoked.filter(id))].slice(0, 256) : [], added };
}
export function writeTrust(root: string, t: TrustState): void { writeJsonAtomic(paths(root).trust, t); }

export type InstallMethod = 'standalone' | 'brew' | 'scoop' | 'winget' | 'apt' | 'npm' | 'docker' | 'dev';
export function readReceiptMethod(root: string): InstallMethod | null {
  const m = (readJson(paths(root).receipt) as { method?: unknown } | null)?.method;
  return typeof m === 'string' && ['standalone', 'brew', 'scoop', 'winget', 'apt', 'npm', 'docker', 'dev'].includes(m) ? (m as InstallMethod) : null;
}

export type ResultCode =
  | 'updated' | 'rolled_back_crash' | 'rolled_back_unhealthy' | 'selftest_failed' | 'hash_mismatch' | 'signature_invalid'
  | 'manifest_expired' | 'manifest_rollback' | 'download_failed' | 'blocked_version' | 'confirmed';
export interface UpdateResult { code: ResultCode; from: string; to: string; atMs: number }
export function writeResult(root: string, r: UpdateResult): void { try { writeJsonAtomic(paths(root).lastResult, r); } catch { /* best effort */ } }
export function readResult(root: string): UpdateResult | null {
  const j = readJson(paths(root).lastResult) as Partial<UpdateResult> | null;
  return j && typeof j.code === 'string' && okVersion(j.from) && okVersion(j.to) && typeof j.atMs === 'number' ? (j as UpdateResult) : null;
}
