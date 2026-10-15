/**
 * The install gate for the optional Botwarren Companion component. The hard constraints (owner decision 2026-10-15), each enforced here and tested:
 *
 *  1. ONLY the component named "companion", from a manifest signed with the release key (pinned keys, own signature domain, trust epoch,
 *     anti-rollback, expiry). A manifest for any other component, or an agent manifest, is refused.
 *  2. VERIFY BEFORE ANYTHING RUNS: the signature is checked before the manifest is parsed; the bundle's SHA-256 and size are checked before
 *     it is opened; the archive is opened with the path-safe reader and only allowlisted file names are extracted; only then is the
 *     self-test (`companion.mjs version`) executed. A failure at any step runs nothing.
 *  3. CONSENT RECORDED: nothing is downloaded without a consent record written from the website's directive (`recordConsent`), and the
 *     install leaves a local log line and a notice file.
 *  4. THE CLOUD CANNOT CHOOSE WHAT RUNS: the manifest address comes from this install's own configuration (the same downloads base as agent
 *     updates), never from the website. The website's directive is the two words install / remove plus a consent time (directive.ts).
 *  5. REMOVABLE: `removeCompanion` (website "remove" directive, `botwarren companion remove`) uninstalls and deletes the files.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { extractTo, readZip } from '../update/archive.ts';
import { COMPONENT_PUBLIC_KEYS, type PinnedKey } from '../update/keys.ts';
import { isVersion, compareVersions } from '../update/semver.ts';
import { effectiveKeys } from '../update/trust.ts';
import { paths, readJson, readTrust, writeJsonAtomic } from '../update/state.ts';
import { resolveUrl } from '../update/updater.ts';
import { BUNDLE_FILES, BUNDLE_REQUIRED, MAX_COMPONENT_MANIFEST_BYTES, type ComponentName } from './manifest.ts';
import { verifyComponentManifest, type ComponentVerifyCode } from './verify.ts';

export const COMPONENT: ComponentName = 'companion';
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export const componentPaths = (root: string) => {
  const dir = join(root, 'components', COMPONENT);
  return { dir, versions: join(dir, 'versions'), version: (v: string) => join(dir, 'versions', v), current: join(dir, 'current.json'), notice: join(dir, 'NOTICE.txt'), state: join(paths(root).state, `component-${COMPONENT}.json`), consent: join(paths(root).state, `component-${COMPONENT}-consent.json`), blocked: join(paths(root).state, `component-${COMPONENT}-blocked`), staging: join(root, 'staging') };
};

// ---------------------------------------------------------------- consent and local switches
const ConsentFile = z.object({ component: z.literal('companion'), consentAt: z.string().datetime({ offset: true }), recordedAt: z.string().datetime({ offset: true }) }).strict();
export type ConsentRecord = z.infer<typeof ConsentFile>;

export function recordConsent(root: string, consentAt: string, nowMs: number): ConsentRecord {
  const rec: ConsentRecord = { component: COMPONENT, consentAt, recordedAt: new Date(nowMs).toISOString() };
  writeJsonAtomic(componentPaths(root).consent, rec);
  return rec;
}
export function readConsent(root: string): ConsentRecord | null {
  const p = ConsentFile.safeParse(readJson(componentPaths(root).consent));
  return p.success ? p.data : null;
}
export function clearConsent(root: string): void { rmSync(componentPaths(root).consent, { force: true }); }

/** `botwarren companion block`: this computer refuses the companion whatever the website says */
export function isLocallyBlocked(root: string, env: Record<string, string | undefined> = process.env): boolean {
  return env.BOTWARREN_DISABLE_COMPONENTS === '1' || env.BOTWARREN_DISABLE_COMPONENTS === 'true' || existsSync(componentPaths(root).blocked);
}
export function setLocalBlock(root: string, on: boolean): void {
  const p = componentPaths(root).blocked;
  if (on) { mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 }); writeFileSync(p, 'blocked locally\n', { mode: 0o600 }); } else rmSync(p, { force: true });
}

// ---------------------------------------------------------------- what is installed
export interface CurrentRecord { version: string; sha256: string; installedAt: string; consentAt: string; keyId: string; manifestVersion: number }
export function readCurrent(root: string): CurrentRecord | null {
  const j = readJson(componentPaths(root).current) as Partial<CurrentRecord> | null;
  return j && typeof j.version === 'string' && isVersion(j.version) && existsSync(join(componentPaths(root).version(j.version), 'companion.mjs')) ? (j as CurrentRecord) : null;
}
export const entryPath = (root: string, version: string): string => join(componentPaths(root).version(version), 'companion.mjs');

interface HighState { highestManifestVersion: number }
const readHigh = (root: string): number => { const j = readJson(componentPaths(root).state) as Partial<HighState> | null; return typeof j?.highestManifestVersion === 'number' && j.highestManifestVersion >= 0 ? j.highestManifestVersion : 0; };

// ---------------------------------------------------------------- install
export type InstallCode =
  | 'no_consent' | 'disabled_locally' | 'insecure_url' | 'download_failed' | 'manifest_refused' | 'version_not_installable' | 'hash_mismatch' | 'size_mismatch'
  | 'bad_bundle' | 'selftest_failed' | 'agent_too_old' | 'runtime_too_old';
export type InstallOutcome =
  | { status: 'installed'; version: string; replaced: string | null }
  | { status: 'current'; version: string }
  | { status: 'refused'; code: InstallCode; detail?: ComponentVerifyCode };

export interface InstallOptions {
  root: string;
  /** the downloads base of THIS install (policy.baseUrl); never supplied by the website */
  baseUrl: string;
  agentVersion: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  keys?: readonly PinnedKey[];
  allowDevKey?: boolean;
  env?: Record<string, string | undefined>;
  log: (m: string) => void;
  /** executes the staged `companion.mjs version`; tests inject a stub. Only ever called AFTER every check passed. */
  selftest?: (entry: string, version: string) => Promise<boolean>;
  runtime?: string;
  timeoutMs?: number;
}

async function get(f: typeof fetch, url: string, max: number, ms: number): Promise<Buffer> {
  const res = await f(url, { redirect: 'follow', signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'botwarren-agent-component' } });
  if (!res.ok || !res.body) throw new Error('http');
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) { n += c.length; if (n > max) throw new Error('too large'); chunks.push(Buffer.from(c)); }
  return Buffer.concat(chunks);
}

export function defaultSelftest(entry: string, version: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry, 'version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: { PATH: process.env.PATH ?? '' } });
    let out = '';
    p.stdout.on('data', (c: Buffer) => { out += c.toString('utf8').slice(0, 100); });
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve(false); }, 15_000); t.unref();
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('exit', (code) => { clearTimeout(t); resolve(code === 0 && out.trim() === version); });
  });
}

export async function installCompanion(o: InstallOptions): Promise<InstallOutcome> {
  const now = (o.now ?? Date.now)();
  const P = componentPaths(o.root);
  const refuse = (code: InstallCode, detail?: ComponentVerifyCode): InstallOutcome => { o.log(`companion: install refused (${code}${detail ? `: ${detail}` : ''}); nothing was installed or run`); return { status: 'refused', code, ...(detail ? { detail } : {}) }; };

  // (3) consent first: nothing is even downloaded without it
  const consent = readConsent(o.root);
  if (!consent) return refuse('no_consent');
  if (isLocallyBlocked(o.root, o.env ?? process.env)) return refuse('disabled_locally');

  const base = o.baseUrl.replace(/\/*$/, '/') + `${COMPONENT}/`;
  const mUrl = resolveUrl('manifest.json', base); const sUrl = resolveUrl('manifest.json.sig', base);
  if (!mUrl || !sUrl) return refuse('insecure_url');
  const f = o.fetchImpl ?? fetch; const ms = o.timeoutMs ?? 30_000;
  let bytes: Buffer; let sig: Buffer;
  try { [bytes, sig] = [await get(f, mUrl, MAX_COMPONENT_MANIFEST_BYTES, ms), await get(f, sUrl, 4096, ms)]; } catch { return refuse('download_failed'); }

  // (1)(2) signature first, then schema, expiry, epoch, rollback, component name
  const trust = readTrust(o.root);
  const v = verifyComponentManifest(bytes, sig.toString('utf8'), {
    component: COMPONENT, keys: effectiveKeys(o.keys ?? COMPONENT_PUBLIC_KEYS, trust), now: new Date(now), allowDev: o.allowDevKey === true, highestSeen: readHigh(o.root), epoch: trust.epoch, revoked: trust.revoked,
  });
  if (!v.ok) return refuse('manifest_refused', v.code);
  if (v.manifest.manifestVersion > readHigh(o.root)) writeJsonAtomic(P.state, { highestManifestVersion: v.manifest.manifestVersion });

  const version = v.manifest.channels.stable;
  const rel = v.manifest.releases[version];
  if (!rel || v.manifest.blocked.includes(version) || !(rel.protocol.min <= 1 && 1 <= rel.protocol.max)) return refuse('version_not_installable');
  if (rel.minAgent && compareVersions(o.agentVersion, rel.minAgent) < 0) return refuse('agent_too_old');
  if (rel.minRuntime && compareVersions(o.runtime ?? process.versions.node, rel.minRuntime) < 0) return refuse('runtime_too_old');
  const cur = readCurrent(o.root);
  if (cur?.version === version) return { status: 'current', version };

  // download, then hash and size BEFORE the archive is opened
  const bUrl = resolveUrl(rel.bundle.url, base);
  if (!bUrl) return refuse('insecure_url');
  let zip: Buffer;
  try { zip = await get(f, bUrl, Math.min(rel.bundle.size + 1, MAX_BUNDLE_BYTES), ms); } catch { return refuse('download_failed'); }
  if (zip.length !== rel.bundle.size) return refuse('size_mismatch');
  const digest = createHash('sha256').update(zip).digest('hex');
  if (digest !== rel.bundle.sha256) return refuse('hash_mismatch');

  // only allowlisted names; required files present; VERSION agrees with the signed manifest
  const tmp = join(P.staging, `${COMPONENT}-${version}.${now}`);
  try {
    const entries = readZip(zip);
    const allowed = new Set(BUNDLE_FILES[COMPONENT]);
    if (entries.some((e) => !allowed.has(e.name)) || !BUNDLE_REQUIRED[COMPONENT].every((n) => entries.some((e) => e.name === n))) return refuse('bad_bundle');
    if (entries.find((e) => e.name === 'VERSION')?.data.toString('utf8').trim() !== version) return refuse('bad_bundle');
    mkdirSync(P.staging, { recursive: true, mode: 0o700 });
    extractTo(entries.map((e) => ({ ...e, mode: 0o644 })), tmp);
    mkdirSync(P.versions, { recursive: true, mode: 0o755 });
    rmSync(P.version(version), { recursive: true, force: true });
    renameSync(tmp, P.version(version));
  } catch { rmSync(tmp, { recursive: true, force: true }); return refuse('bad_bundle'); }

  // (2) only now is anything executed
  if (!(await (o.selftest ?? defaultSelftest)(entryPath(o.root, version), version))) { rmSync(P.version(version), { recursive: true, force: true }); return refuse('selftest_failed'); }

  const rec: CurrentRecord = { version, sha256: digest, installedAt: new Date(now).toISOString(), consentAt: consent.consentAt, keyId: v.keyId, manifestVersion: v.manifest.manifestVersion };
  writeJsonAtomic(P.current, rec, 0o644);
  writeFileSync(P.notice, [
    'Botwarren Companion is installed on this computer.',
    '',
    `Version ${version}, installed ${rec.installedAt}, because your Botwarren account asked for it (consent recorded ${consent.consentAt}).`,
    `Verified before it ran: manifest signed by release key ${v.keyId}, bundle SHA-256 ${digest}.`,
    '',
    'It is a separate program from the metadata-only ship agent. It reads your agent\'s own words on this computer and sends them, end-to-end encrypted, to your own paired devices.',
    'Remove it: `botwarren companion remove` (here), or "Turn off" on your account page at botwarren.com.',
    'Refuse it for good on this computer: `botwarren companion block`.',
    '',
  ].join('\n'), { mode: 0o644 });
  o.log(`companion: installed ${version} (signed by ${v.keyId}, sha256 ${digest.slice(0, 12)}...; consent recorded ${consent.consentAt}). Remove with: botwarren companion remove`);
  return { status: 'installed', version, replaced: cur?.version ?? null };
}

// ---------------------------------------------------------------- remove
export interface RemoveOptions { root: string; log: (m: string) => void; run?: (entry: string, args: string[]) => Promise<boolean> }

export async function runCompanion(entry: string, args: string[], input?: string, timeoutMs = 30_000): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...args], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    p.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8').slice(0, 20_000); });
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve({ code: null, stdout }); }, timeoutMs); t.unref();
    p.on('error', () => { clearTimeout(t); resolve({ code: null, stdout }); });
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, stdout }); });
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

/** Removes the companion: its own uninstall (revokes devices, stops the daemon, removes its hooks, deletes its keys), then the files. */
export async function removeCompanion(o: RemoveOptions): Promise<void> {
  const cur = readCurrent(o.root);
  if (cur) {
    const entry = entryPath(o.root, cur.version);
    const ok = o.run ? await o.run(entry, ['uninstall', '--purge', '--yes']) : (await runCompanion(entry, ['uninstall', '--purge', '--yes'])).code === 0;
    if (!ok) o.log('companion: its own uninstall did not finish cleanly; the files are removed anyway');
  }
  rmSync(componentPaths(o.root).dir, { recursive: true, force: true });
  clearConsent(o.root);
  o.log('companion: removed from this computer (devices revoked, keys deleted, files removed)');
}

