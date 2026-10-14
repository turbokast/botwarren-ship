#!/usr/bin/env node
/**
 * The release workflow's sign-manifest job step 1: describe, never rebuild. Reads the output of the reproducible build job
 * (archives, bundle-<version>.zip, SHA256SUMS, already hash-checked) and writes the unsigned manifest.json and install-index.txt.
 *
 *   node scripts/assemble-manifest.mjs --dir <build output> --version X.Y.Z --out <dir>
 *        [--previous <manifest.json> --previous-sig <manifest.json.sig>] [--commit <sha>] [--epoch <n>] [--expires-days 30] [--keep-releases 25]
 *
 * The previous manifest comes from the (untrusted) download host. It is used only after it verifies against the PINNED keys (an expired but
 * genuine one is fine); a previous manifest that fails verification aborts the release rather than being silently dropped or trusted.
 * The epoch is the previous manifest's, or --epoch (the workflow passes the RELEASE_EPOCH variable, which the owner raises after a recovery).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINNED_PUBLIC_KEYS } from '../src/update/keys.ts';
import { PLATFORMS } from '../src/update/manifest.ts';
import { verifyManifest } from '../src/update/verify.ts';
import { assembleManifest } from './lib/manifest-build.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const fail = (m) => { console.error(`assemble-manifest: ${m}`); process.exit(1); };
const dir = opt('--dir'); const version = opt('--version'); const out = opt('--out');
if (!dir || !version || !out) fail('usage: --dir <build output> --version X.Y.Z --out <dir> [--previous <f> --previous-sig <f>] [--commit <sha>] [--epoch <n>] [--expires-days n] [--keep-releases n]');
if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) fail('--version must be x.y.z');

const sums = new Map(readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean).map((l) => { const m = /^([0-9a-f]{64})  (.+)$/.exec(l); if (!m) fail(`bad SHA256SUMS line`); return [m[2], m[1]]; }));
const artifact = (name) => {
  const p = join(dir, name);
  if (!existsSync(p)) fail(`${name} is missing from ${dir}`);
  const data = readFileSync(p);
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (sums.get(name) !== sha256) fail(`${name} does not match SHA256SUMS`);
  return { url: name, sha256, size: data.length };
};
const bundle = artifact(`bundle-${version}.zip`);
const full = {};
for (const t of PLATFORMS) {
  const name = readdirSync(dir).find((n) => n === `botwarren-${version}-${t}.tar.gz` || n === `botwarren-${version}-${t}.zip`);
  if (name) full[t] = artifact(name);
}
if (Object.keys(full).length !== PLATFORMS.length) fail(`expected ${PLATFORMS.length} platform archives, found ${Object.keys(full).length}`);
const here = dirname(fileURLToPath(import.meta.url));
const minRuntime = JSON.parse(readFileSync(join(here, '..', 'packaging', 'node-pins.json'), 'utf8')).version; // the runtime inside the archives (build-release pins it)

let previous = null;
const pf = opt('--previous'); const ps = opt('--previous-sig');
if (pf || ps) {
  if (!pf || !ps) fail('--previous and --previous-sig go together');
  const v = verifyManifest(readFileSync(pf), readFileSync(ps, 'utf8'), { keys: PINNED_PUBLIC_KEYS, now: new Date(), highestSeen: 0, epoch: 1_000_000 });
  // epoch is validated below; here only the signature and schema matter, so accept any epoch and an expired manifest
  const parsed = (() => { try { return JSON.parse(readFileSync(pf, 'utf8')); } catch { return null; } })();
  const code = v.ok ? null : v.code;
  if (code && !['expired', 'epoch_rollback'].includes(code)) fail(`the previous manifest does not verify against the pinned keys (${code}); refusing to build on it`);
  previous = parsed;
}

const built = assembleManifest({
  version, bundle, full, minRuntime, previous, ...(opt('--commit') ? { commit: opt('--commit') } : {}),
  ...(opt('--epoch') ? { epoch: Math.max(Number(opt('--epoch')), previous?.epoch ?? 1) } : {}),
  expiresDays: Number(opt('--expires-days') ?? 30), keepReleases: Number(opt('--keep-releases') ?? 25),
});
writeFileSync(join(resolve(out), 'manifest.json'), built.text);
writeFileSync(join(resolve(out), 'install-index.txt'), built.indexText);
console.log(`manifest ${built.manifest.manifestVersion} (epoch ${built.manifest.epoch}, ${Object.keys(built.manifest.releases).length} releases, ${Buffer.byteLength(built.text)} bytes, expires ${built.manifest.expires}) and install-index.txt written to ${resolve(out)}`);
