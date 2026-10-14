/**
 * The in-agent updater: CHECK -> VERIFY manifest signature -> DECIDE -> DOWNLOAD -> VERIFY sha256 -> EXTRACT to staging ->
 * move to versions/<v> -> SELFTEST -> write the pointer in state "trial". It never executes anything that is not in a
 * verified manifest with a matching hash, never overwrites a version directory, and never touches the running version.
 * Restarting into the new version (and rolling back if it is unhealthy) belongs to the launcher.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { extractTo, readZip } from './archive.ts';
import { decideUpdate, type Channel, type Decision } from './decide.ts';
import { MAX_MANIFEST_BYTES, type Artifact, type Platform } from './manifest.ts';
import { PINNED_PUBLIC_KEYS, type PinnedKey } from './keys.ts';
import { verifyManifest, type VerifyCode } from './verify.ts';
import { applyKeysDoc, effectiveKeys, MAX_KEYS_DOC_BYTES, verifyKeysDoc } from './trust.ts';
import { nextCheckAt } from './schedule.ts';
import {
  paths, readDenylist, readOrCreateInstallId, readPointer, readTrust, readUpdateState, writePointer, writeResult, writeTrust, writeUpdateState,
  type ResultCode, type TrustState,
} from './state.ts';

export type Outcome =
  | { status: 'up_to_date'; version: string }
  | { status: 'skipped'; reason: string; version?: string }
  | { status: 'would_update'; version: string; forced: boolean; rollback: boolean }
  | { status: 'staged'; version: string; forced: boolean; rollback: boolean }
  | { status: 'error'; code: VerifyCode | 'download_failed' | 'hash_mismatch' | 'size_mismatch' | 'bad_bundle' | 'selftest_failed' | 'insecure_url' | 'no_pointer' };

export interface UpdaterOptions {
  root: string;
  baseUrl: string;
  currentVersion: string;
  channel: Channel;
  platform: Platform;
  maximumVersion?: string | undefined;
  fetchImpl?: typeof fetch;
  keys?: readonly PinnedKey[];
  allowDevKey?: boolean;
  now?: () => number;
  rand?: () => number;
  log?: (m: string) => void;
  /** run the staged version's `cli.mjs --version`; tests inject a stub */
  selftest?: (versionDir: string, version: string) => Promise<boolean>;
  timeoutMs?: number;
}

const mapVerify: Record<VerifyCode, ResultCode | null> = {
  too_large: 'signature_invalid', bad_signature_file: 'signature_invalid', unknown_key: 'signature_invalid', dev_key_refused: 'signature_invalid',
  key_expired: 'signature_invalid', key_revoked: 'signature_invalid', wrong_key_role: 'signature_invalid', bad_signature: 'signature_invalid', malformed: 'signature_invalid',
  expired: 'manifest_expired', rollback: 'manifest_rollback', epoch_rollback: 'manifest_rollback', epoch_unknown: 'signature_invalid', version_jump: 'signature_invalid',
};

const isLoopback = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

/** https only (http only for loopback, used by tests/mirrors on the same machine); no credentials in URLs. */
export function resolveUrl(url: string, base: string): string | null {
  try {
    const u = new URL(url, base);
    if (u.username || u.password) return null;
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) return null;
    return u.toString();
  } catch { return null; }
}

export async function defaultSelftest(dir: string, version: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(dir, 'cli.mjs'), '--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    p.stdout.on('data', (c: Buffer) => { out += c.toString('utf8').slice(0, 200); });
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve(false); }, 15_000); t.unref();
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('exit', (code) => { clearTimeout(t); resolve(code === 0 && out.includes(version)); });
  });
}

export class Updater {
  private readonly o: UpdaterOptions;
  constructor(o: UpdaterOptions) { this.o = o; }

  private get now(): number { return (this.o.now ?? Date.now)(); }
  private log(m: string): void { this.o.log?.(m); }

  private async get(url: string, maxBytes: number): Promise<Buffer> {
    const f = this.o.fetchImpl ?? fetch;
    const res = await f(url, { redirect: 'follow', signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000), headers: { 'user-agent': `botwarren-agent/${this.o.currentVersion}` } });
    if (!res.ok || !res.body) throw new Error('http');
    const chunks: Buffer[] = []; let n = 0;
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) { n += c.length; if (n > maxBytes) throw new Error('too large'); chunks.push(Buffer.from(c)); }
    return Buffer.concat(chunks);
  }

  /**
   * The OPTIONAL keys document (keys.json + keys.json.sig, 2-of-3 recovery signatures; see trust.ts). Absent or invalid means "no change"
   * (an attacker who can withhold it can only keep the persisted trust). A newer valid one is persisted (unless `dryRun`) and returned.
   */
  private async refreshTrust(dryRun: boolean): Promise<TrustState> {
    const { root } = this.o;
    const cur = readTrust(root);
    const kUrl = resolveUrl('keys.json', this.o.baseUrl); const sUrl = resolveUrl('keys.json.sig', this.o.baseUrl);
    if (!kUrl || !sUrl) return cur;
    let kb: Buffer; let ks: Buffer;
    try { [kb, ks] = [await this.get(kUrl, MAX_KEYS_DOC_BYTES), await this.get(sUrl, 4096)]; } catch { return cur; }
    const v = verifyKeysDoc(kb, ks.toString('utf8'), { pinned: this.o.keys ?? PINNED_PUBLIC_KEYS, now: new Date(this.now) });
    if (!v.ok) { this.log(`update: keys document refused (${v.code})`); return cur; }
    const a = applyKeysDoc(cur, v.doc);
    if (!a.applied) return cur;
    this.log(`update: keys document ${v.doc.seq} accepted (signed by ${v.signers.join(', ')}; epoch ${a.state.epoch}; ${a.state.revoked.length} revoked)`);
    if (!dryRun) {
      writeTrust(root, a.state);
      if (a.epochRaised) writeUpdateState(root, { ...readUpdateState(root), highestManifestVersion: 0 }); // the version high-water mark is per epoch
    }
    return a.state;
  }

  /** One full check (and stage, unless `dryRun`). Records the next scheduled check. */
  async check(opts: { dryRun?: boolean; explicitVersion?: string } = {}): Promise<Outcome> {
    const { root } = this.o;
    const st0 = readUpdateState(root);
    const done = (failed: boolean, out: Outcome): Outcome => {
      if (!opts.dryRun) writeUpdateState(root, { ...readUpdateState(root), lastCheckMs: this.now, nextCheckMs: nextCheckAt(this.now, failed ? st0.consecutiveFailures + 1 : 0, this.o.rand), consecutiveFailures: failed ? st0.consecutiveFailures + 1 : 0 });
      return out;
    };
    const base = this.o.baseUrl;
    const mUrl = resolveUrl('manifest.json', base);
    const sUrl = resolveUrl('manifest.json.sig', base);
    if (!mUrl || !sUrl) return done(true, { status: 'error', code: 'insecure_url' });
    let bytes: Buffer; let sig: Buffer;
    try { [bytes, sig] = [await this.get(mUrl, MAX_MANIFEST_BYTES), await this.get(sUrl, 4096)]; } catch { return done(true, { status: 'error', code: 'download_failed' }); }

    const trust = await this.refreshTrust(!!opts.dryRun);
    const st = readUpdateState(root);
    const highest = trust.epoch > readTrust(root).epoch ? 0 : st.highestManifestVersion; // a dry run does not persist the epoch bump, but decides as if it had
    const v = verifyManifest(bytes, sig.toString('utf8'), {
      keys: effectiveKeys(this.o.keys ?? PINNED_PUBLIC_KEYS, trust), now: new Date(this.now), allowDev: this.o.allowDevKey === true,
      highestSeen: highest, epoch: trust.epoch, revoked: trust.revoked,
    });
    if (!v.ok) {
      const code = mapVerify[v.code];
      this.log(`update: manifest refused (${v.code})`);
      if (code && !opts.dryRun) writeResult(root, { code, from: this.o.currentVersion, to: this.o.currentVersion, atMs: this.now });
      return done(true, { status: 'error', code: v.code });
    }
    if (!opts.dryRun && v.manifest.manifestVersion > highest) writeUpdateState(root, { ...readUpdateState(root), highestManifestVersion: v.manifest.manifestVersion });

    const d: Decision = decideUpdate({
      manifest: v.manifest, current: this.o.currentVersion, channel: this.o.channel, installId: readOrCreateInstallId(root),
      denylist: readDenylist(root, this.now), nowMs: this.now, maximumVersion: this.o.maximumVersion, explicitVersion: opts.explicitVersion,
    });
    if (d.action === 'none') return done(false, d.reason === 'up_to_date' ? { status: 'up_to_date', version: this.o.currentVersion } : { status: 'skipped', reason: d.reason, ...(d.version ? { version: d.version } : {}) });
    if (opts.dryRun) return { status: 'would_update', version: d.version, forced: d.forced, rollback: d.rollback };

    const staged = await this.stage(d.version, d.release.bundle);
    if (staged !== 'ok') { writeResult(root, { code: staged === 'hash_mismatch' ? 'hash_mismatch' : staged === 'selftest_failed' ? 'selftest_failed' : 'download_failed', from: this.o.currentVersion, to: d.version, atMs: this.now }); return done(true, { status: 'error', code: staged }); }
    const ptr = readPointer(root);
    if (!ptr) return done(true, { status: 'error', code: 'no_pointer' });
    writePointer(root, { version: d.version, previous: ptr.version, knownGood: ptr.knownGood ?? (ptr.state === 'stable' ? ptr.version : ptr.previous), state: 'trial', bootCount: 0, trialStarted: null });
    writeResult(root, { code: 'updated', from: ptr.version, to: d.version, atMs: this.now });
    this.log(`update: ${ptr.version} -> ${d.version} staged (trial); starts at the next restart`);
    return done(false, { status: 'staged', version: d.version, forced: d.forced, rollback: d.rollback });
  }

  private async stage(version: string, art: Artifact): Promise<'ok' | 'download_failed' | 'hash_mismatch' | 'size_mismatch' | 'bad_bundle' | 'selftest_failed' | 'insecure_url'> {
    const { root } = this.o;
    const p = paths(root);
    const url = resolveUrl(art.url, this.o.baseUrl);
    if (!url) return 'insecure_url';
    let data: Buffer;
    try { data = await this.get(url, art.size + 1); } catch { return 'download_failed'; }
    if (data.length !== art.size) return 'size_mismatch';
    if (createHash('sha256').update(data).digest('hex') !== art.sha256) return 'hash_mismatch'; // nothing is extracted before this passes
    const tmp = join(p.staging, `${version}.${randomBytes(4).toString('hex')}`);
    try {
      mkdirSync(p.staging, { recursive: true, mode: 0o700 });
      const entries = readZip(data);
      const names = new Set(entries.map((e) => e.name));
      const ver = entries.find((e) => e.name === 'VERSION')?.data.toString('utf8').trim();
      if (!['agent.mjs', 'cli.mjs', 'VERSION'].every((n) => names.has(n)) || ver !== version) { rmSync(tmp, { recursive: true, force: true }); return 'bad_bundle'; }
      extractTo(entries, tmp);
      const dest = p.version(version);
      if (readPointer(root)?.version === version) { rmSync(tmp, { recursive: true, force: true }); return 'ok'; } // already the running version: never replaced
      mkdirSync(p.versions, { recursive: true, mode: 0o755 });
      rmSync(dest, { recursive: true, force: true }); // only a leftover (never current): safe to replace
      renameSync(tmp, dest);
    } catch { rmSync(tmp, { recursive: true, force: true }); return 'bad_bundle'; }
    const ok = await (this.o.selftest ?? defaultSelftest)(p.version(version), version);
    if (!ok) { rmSync(p.version(version), { recursive: true, force: true }); return 'selftest_failed'; }
    return 'ok';
  }
}
