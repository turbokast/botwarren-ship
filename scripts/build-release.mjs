#!/usr/bin/env node
/**
 * Builds a release: per-OS/arch archives (pinned official Node runtime + launcher + app bundle), the silent-update bundle,
 * an UNSIGNED manifest.json, install-index.txt, installers and SHA256SUMS. Signing the manifest is a separate step: scripts/release-sign.mjs
 * (the release workflow's gated sign-manifest job through Cloud KMS, or the owner's emergency --kms run; this script never holds a key).
 *
 *   node scripts/build-release.mjs [--targets win-x64,mac-arm64,...] [--out dist/release] [--offline] [--no-runtime] [--no-manifest]
 *        [--release] [--require-signing] [--update-pins] [--previous <manifest.json>] [--rollout-bp 10000] [--critical]
 *        [--stable-version <v>] [--commit <sha>] [--expires-days 14] [--manifest-version <n>]
 *
 *  --offline          use only the cached Node archives (apps/shipagent/.cache/node); fails with instructions if missing
 *  --no-runtime       only the update bundle + manifest (development, CI without network); no per-OS archives
 *  --emit-bundle      with --no-manifest: also write bundle-<version>.zip (the release workflow's sign-manifest job describes it)
 *  --epoch            trust epoch of the manifest (default: the previous manifest's, else 1)
 *  --no-manifest      archives, installers and SHA256SUMS only: NO update bundle, manifest.json or install-index.txt. This is how
 *                     releases are published until a production release key exists (see docs/RELEASING.md): the agent's updater and the
 *                     one-line installers need a signed manifest, so they stay inert and refuse to install.
 *  --release          refuses to build unless a production release key and the 3 offline recovery keys are pinned in src/update/keys.ts
 *  --require-signing  a skipped OS-signing stage (missing credentials / wrong host) is an error
 *  --previous         merge the releases (and blocked / rollbackFrom lists) of an earlier manifest; manifestVersion increases
 *
 * Requires Node >= 22.18 (runs the TypeScript sources of src/update directly); CI uses Node 24.
 * Layout inside every archive (identical to the installed layout):
 *   runtime/node/node(.exe)  runtime/NODE_VERSION  launcher/launcher.mjs  versions/<v>/{agent.mjs,cli.mjs,ops.html,VERSION}
 *   current.json  uninstall.sh|uninstall.ps1  [bin/botwarren.cmd]
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTo, writeTarGz, writeZip } from '../src/update/archive.ts';
import { PLATFORMS } from '../src/update/manifest.ts';
import { PINNED_PUBLIC_KEYS, RECOVERY_THRESHOLD, recoveryKeys, roleOf } from '../src/update/keys.ts';
import { assembleManifest } from './lib/manifest-build.mjs';
import { DEFAULT_BASE_URL } from '../src/update/policy.ts';
import { fetchRuntimes, loadPins } from './lib/node-runtime.mjs';
import { planSigning, signStage } from './lib/signing.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const banner = "import { createRequire as __bwCreateRequire } from 'node:module'; const require = __bwCreateRequire(import.meta.url);";

export async function bundleSources({ outDir }) {
  mkdirSync(outDir, { recursive: true });
  for (const [entry, out] of [['src/main.ts', 'agent.mjs'], ['src/cli.ts', 'cli.mjs'], ['src/launcher/main.ts', 'launcher.mjs']]) {
    await build({
      entryPoints: [join(root, entry)], outfile: join(outDir, out), bundle: true, platform: 'node', format: 'esm', target: 'node22',
      minify: false, legalComments: 'none', banner: { js: banner }, logLevel: 'warning', sourcemap: false, absWorkingDir: root,
    });
  }
  const ops = join(root, 'src/ops.html');
  if (!existsSync(ops)) throw new Error('ops.html missing');
  const files = {};
  for (const n of ['agent.mjs', 'cli.mjs', 'launcher.mjs']) files[n] = readFileSync(join(outDir, n));
  files['ops.html'] = readFileSync(ops);
  // guard: nothing machine- or secret-specific may ship
  for (const n of ['agent.mjs', 'cli.mjs', 'launcher.mjs']) {
    const text = files[n].toString('utf8');
    for (const needle of ['/home/', 'secrets.env', 'sk-ant-', 'ELEVEN', 'BEGIN PRIVATE KEY']) if (text.includes(needle)) throw new Error(`${n} contains suspicious text: ${needle}`);
  }
  return files;
}


function installLayout({ version, target, files, runtime, nodeVersion, installDir }) {
  const win = target.startsWith('win-');
  const entries = [];
  const add = (name, data, m = 0o644) => entries.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data), mode: m });
  if (runtime) {
    add(`runtime/node/${runtime.bin.name}`, runtime.bin.data, 0o755);
    if (runtime.license) add('runtime/node/LICENSE', runtime.license);
    add('runtime/NODE_VERSION', `${nodeVersion}\n`);
  }
  add('launcher/launcher.mjs', files['launcher.mjs']);
  for (const n of ['agent.mjs', 'cli.mjs', 'ops.html']) add(`versions/${version}/${n}`, files[n]);
  add(`versions/${version}/VERSION`, `${version}\n`);
  add('current.json', JSON.stringify({ version, previous: null, knownGood: version, state: 'stable', bootCount: 0, trialStarted: null }, null, 2) + '\n');
  if (win) {
    add('uninstall.ps1', readFileSync(join(installDir, 'uninstall.ps1'), 'utf8').replace(/\r?\n/g, '\r\n'));
    add('bin/botwarren.cmd', ['@echo off', 'set "BOTWARREN_HOME=%~dp0.."', '"%~dp0..\\runtime\\node\\node.exe" --disable-warning=ExperimentalWarning "%~dp0..\\launcher\\launcher.mjs" cli %*', 'exit /b %ERRORLEVEL%', ''].join('\r\n'));
  } else {
    add('uninstall.sh', readFileSync(join(installDir, 'uninstall.sh'), 'utf8').replace(/\r\n/g, '\n'), 0o755);
  }
  return entries;
}

function walkFiles(dir, base = dir, out = []) {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walkFiles(p, base, out); else out.push({ name: p.slice(base.length + 1).replaceAll('\\', '/'), data: readFileSync(p), mode: statSync(p).mode & 0o777 }); }
  return out;
}

/** Programmatic entry (also used by the tests). Returns { dir, manifest, files }. */
export async function buildRelease(o = {}) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = o.version ?? pkg.version;
  const targets = o.targets ?? PLATFORMS;
  const out = resolve(o.out ?? join(root, 'dist', 'release'), version);
  const log = o.log ?? ((m) => console.log(m));
  const installDir = join(root, 'packaging');
  if (o.release) {
    // release gate: the agent must pin a production release key and the full offline recovery set (the DEV key may stay pinned: it is refused at runtime without the explicit opt-in)
    const pinned = o.pinnedKeys ?? PINNED_PUBLIC_KEYS;
    if (!pinned.some((k) => !k.dev && roleOf(k) === 'release')) throw new Error('refusing --release: no production (non-dev) release public key is pinned in src/update/keys.ts');
    if (recoveryKeys(pinned).length < RECOVERY_THRESHOLD + 1) throw new Error(`refusing --release: fewer than ${RECOVERY_THRESHOLD + 1} recovery public keys are pinned in src/update/keys.ts`);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  log(`bundling ${version}`);
  const files = await bundleSources({ outDir: join(out, '.build') });
  rmSync(join(out, '.build'), { recursive: true, force: true });

  const bundleName = `bundle-${version}.zip`;
  const bundleZip = writeZip([...['agent.mjs', 'cli.mjs', 'ops.html'].map((n) => ({ name: n, data: files[n], mode: 0o644 })), { name: 'VERSION', data: Buffer.from(`${version}\n`), mode: 0o644 }]);
  if (!o.noManifest || o.emitBundle) writeFileSync(join(out, bundleName), bundleZip); // --emit-bundle: the reproducible bundle the release workflow's sign-manifest job describes

  const pinFile = join(root, 'packaging', 'node-pins.json');
  const nodeVersion = o.nodeVersion ?? loadPins(pinFile)?.version ?? '24.21.0';
  let runtimes = o.runtimes ?? null;
  const withRuntime = o.runtime !== false;
  if (withRuntime && !runtimes) {
    runtimes = await fetchRuntimes({ version: nodeVersion, targets, cacheDir: o.cacheDir ?? join(root, '.cache', 'node'), pinFile, offline: !!o.offline, updatePins: !!o.updatePins, log });
  }

  const full = {};
  if (withRuntime) {
    for (const target of targets) {
      const runtime = runtimes.get(target);
      if (!runtime) throw new Error(`no runtime for ${target}`);
      let entries = installLayout({ version, target, files, runtime, nodeVersion, installDir });
      const platform = target.split('-')[0];
      const plan = planSigning({ platform, files: entries.map((e) => e.name), env: o.env ?? process.env, host: o.host ?? process.platform, stageDir: '<stage>', entitlements: join(root, 'packaging', 'macos', 'entitlements.plist') });
      if (plan.status === 'planned' || o.requireSigning || o.dryRunSigning) {
        const stage = join(out, '.stage', target);
        extractTo(entries, stage);
        signStage({ platform, stageDir: stage, env: o.env ?? process.env, host: o.host ?? process.platform, entitlements: join(root, 'packaging', 'macos', 'entitlements.plist'), requireSigning: !!o.requireSigning, dryRun: !!o.dryRunSigning, log });
        entries = walkFiles(stage);
        rmSync(stage, { recursive: true, force: true });
      } else log(`  signing skipped for ${target}: ${plan.reason}${plan.missing ? ` (missing: ${plan.missing.join(', ')})` : ''}`);
      const win = target.startsWith('win-');
      const name = `botwarren-${version}-${target}.${win ? 'zip' : 'tar.gz'}`;
      const data = win ? writeZip(entries) : writeTarGz(entries);
      writeFileSync(join(out, name), data);
      full[target] = { url: name, sha256: sha256(data), size: data.length };
      log(`  ${name}  ${(data.length / 1e6).toFixed(1)} MB  ${full[target].sha256.slice(0, 12)}`);
    }
    rmSync(join(out, '.stage'), { recursive: true, force: true });
  }

  let manifest = null;
  if (!o.noManifest) {
    const prev = o.previous ? JSON.parse(readFileSync(o.previous, 'utf8')) : null;
    const commit = o.commit ?? (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(); } catch { return undefined; } })();
    const built = assembleManifest({
      version, bundle: { url: bundleName, sha256: sha256(bundleZip), size: bundleZip.length }, full, ...(withRuntime ? { minRuntime: nodeVersion } : {}), previous: prev, commit,
      ...(o.manifestVersion !== undefined ? { manifestVersion: o.manifestVersion } : {}), ...(o.epoch !== undefined ? { epoch: o.epoch } : {}),
      ...(o.expiresDays !== undefined ? { expiresDays: o.expiresDays } : {}), ...(o.rolloutBp !== undefined ? { rolloutBp: o.rolloutBp } : {}),
      critical: !!o.critical, ...(o.stableVersion ? { stableVersion: o.stableVersion } : {}),
    });
    manifest = built.manifest;
    writeFileSync(join(out, 'manifest.json'), built.text);
    writeFileSync(join(out, 'install-index.txt'), built.indexText);
  }

  for (const n of ['install.sh', 'install.ps1']) cpSync(join(installDir, n), join(out, n));
  const sums = readdirSync(out).filter((n) => !n.startsWith('.') && n !== 'SHA256SUMS').sort().map((n) => `${sha256(readFileSync(join(out, n)))}  ${n}`);
  writeFileSync(join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
  log(`release ${version} written to ${out}`);
  if (manifest) log(`next: sign it (docs/RELEASING.md): node scripts/release-sign.mjs --kms <key version resource> --key-id kms-2026a ${join(out, 'manifest.json')}`);
  else log('no manifest written (--no-manifest): the updater and the one-line installers stay inert for this release');
  return { dir: out, manifest, version };
}

function parseArgs(argv) {
  const o = {}; const val = (i) => argv[i + 1];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--targets') o.targets = val(i++).split(',');
    else if (a === '--out') o.out = val(i++);
    else if (a === '--offline') o.offline = true;
    else if (a === '--no-runtime') o.runtime = false;
    else if (a === '--no-manifest') o.noManifest = true;
    else if (a === '--emit-bundle') o.emitBundle = true;
    else if (a === '--epoch') o.epoch = Number(val(i++));
    else if (a === '--release') o.release = true;
    else if (a === '--require-signing') o.requireSigning = true;
    else if (a === '--dry-run-signing') o.dryRunSigning = true;
    else if (a === '--update-pins') o.updatePins = true;
    else if (a === '--critical') o.critical = true;
    else if (a === '--previous') o.previous = val(i++);
    else if (a === '--rollout-bp') o.rolloutBp = Number(val(i++));
    else if (a === '--stable-version') o.stableVersion = val(i++);
    else if (a === '--commit') o.commit = val(i++);
    else if (a === '--expires-days') o.expiresDays = Number(val(i++));
    else if (a === '--manifest-version') o.manifestVersion = Number(val(i++));
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRelease(parseArgs(process.argv.slice(2))).catch((e) => { console.error(`build-release: ${e.message}`); process.exit(1); });
}
export { DEFAULT_BASE_URL };
