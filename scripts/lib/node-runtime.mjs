/**
 * Pinned official Node.js runtime for the per-OS archives.
 *
 * Trust chain: the archive downloaded from nodejs.org must match BOTH
 *   (1) the SHA-256 listed in nodejs.org's SHASUMS256.txt for that file, and
 *   (2) the SHA-256 committed in packaging/node-pins.json (so a later change on nodejs.org, or a poisoned cache, is caught).
 * Downloads are cached under apps/shipagent/.cache/node (gitignored) and re-verified on every use; a mismatch deletes the
 * cached file and fails the build. Offline: works from the cache; with an empty cache it fails with instructions.
 * Only the `node` binary and its LICENSE are taken from the archive (nothing else from it is executed or shipped).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTarGz, readZip } from '../../src/update/archive.ts';

export const DIST = 'https://nodejs.org/dist';

/** manifest platform key -> how Node names its archive and where the binary sits inside it */
export const NODE_TARGETS = {
  'win-x64': { slug: 'win-x64', ext: 'zip', bin: 'node.exe', binDir: '' },
  'win-arm64': { slug: 'win-arm64', ext: 'zip', bin: 'node.exe', binDir: '' },
  'mac-arm64': { slug: 'darwin-arm64', ext: 'tar.gz', bin: 'node', binDir: 'bin/' },
  'mac-x64': { slug: 'darwin-x64', ext: 'tar.gz', bin: 'node', binDir: 'bin/' },
  'linux-x64': { slug: 'linux-x64', ext: 'tar.gz', bin: 'node', binDir: 'bin/' },
  'linux-arm64': { slug: 'linux-arm64', ext: 'tar.gz', bin: 'node', binDir: 'bin/' },
};

export const archiveName = (version, target) => `node-v${version}-${NODE_TARGETS[target].slug}.${NODE_TARGETS[target].ext}`;
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** "<hash>  <file>" lines of SHASUMS256.txt -> Map(file -> hash) */
export function parseShasums(text) {
  const m = new Map();
  for (const line of text.split('\n')) {
    const x = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (x) m.set(x[2], x[1]);
  }
  return m;
}

/** Throws unless the archive matches SHASUMS256 (when given) and the committed pin (when given). */
export function verifyArchive({ name, data, shasums, pin }) {
  const got = sha256(data);
  if (!shasums && !pin) throw new Error(`no hash to verify ${name} against`);
  if (shasums) {
    const want = shasums.get(name);
    if (!want) throw new Error(`${name} is not listed in SHASUMS256.txt`);
    if (want !== got) throw new Error(`${name} does not match SHASUMS256.txt (got ${got}, expected ${want})`);
  }
  if (pin && pin !== got) throw new Error(`${name} does not match the pinned hash in packaging/node-pins.json (got ${got}, pinned ${pin})`);
  return got;
}

/** { name, data, mode } of the node binary (+ LICENSE) from a verified archive. */
export function extractNode(archive, version, target) {
  const t = NODE_TARGETS[target];
  const root = `node-v${version}-${t.slug}/`;
  const only = (n) => n === `${root}${t.binDir}${t.bin}` || n === `${root}LICENSE`;
  const entries = t.ext === 'zip' ? readZip(archive, { only, maxEntries: 100_000 }) : readTarGz(archive, { only, maxEntries: 100_000 });
  const bin = entries.find((e) => e.name === `${root}${t.binDir}${t.bin}`);
  if (!bin) throw new Error(`node binary not found in ${archiveName(version, target)}`);
  const lic = entries.find((e) => e.name === `${root}LICENSE`);
  return { bin: { name: t.bin, data: bin.data, mode: 0o755 }, license: lic ? lic.data : null };
}

export function loadPins(pinFile) {
  try { return JSON.parse(readFileSync(pinFile, 'utf8')); } catch { return null; }
}

async function download(url, fetchImpl) {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download failed: ${url} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Returns Map(target -> { bin, license, archiveSha256 }). `pins` = { version, sha256: { <archive name>: hash } }.
 * With `updatePins`, a first-time download records the verified hashes into the pin file.
 */
export async function fetchRuntimes({ version, targets, cacheDir, pinFile, offline = false, updatePins = false, fetchImpl = fetch, log = () => {} }) {
  const dir = join(cacheDir, `v${version}`);
  mkdirSync(dir, { recursive: true });
  const pins = loadPins(pinFile);
  if (pins && pins.version !== version && !updatePins) throw new Error(`packaging/node-pins.json pins Node ${pins.version}, not ${version}; run with --update-pins to re-pin`);
  const sumsFile = join(dir, 'SHASUMS256.txt');
  if (!existsSync(sumsFile)) {
    if (offline) throw new Error(`offline and SHASUMS256.txt for Node ${version} is not cached in ${dir}. Run once with network access.`);
    log(`downloading SHASUMS256.txt for Node ${version}`);
    const t = join(dir, `SHASUMS256.txt.part`);
    writeFileSync(t, await download(`${DIST}/v${version}/SHASUMS256.txt`, fetchImpl));
    renameSync(t, sumsFile);
  }
  const shasums = parseShasums(readFileSync(sumsFile, 'utf8'));
  const out = new Map();
  const newPins = { version, sha256: { ...(pins?.version === version ? pins.sha256 : {}) } };
  for (const target of targets) {
    const name = archiveName(version, target);
    const file = join(dir, name);
    if (!existsSync(file)) {
      if (offline) throw new Error(`offline and ${name} is not cached in ${dir}. Run once with network access.`);
      log(`downloading ${name}`);
      const t = `${file}.part`;
      writeFileSync(t, await download(`${DIST}/v${version}/${name}`, fetchImpl));
      renameSync(t, file);
    }
    const data = readFileSync(file);
    const pin = pins?.version === version ? pins.sha256?.[name] : undefined;
    if (!pin && !updatePins) throw new Error(`no pinned hash for ${name} in packaging/node-pins.json; run with --update-pins after checking SHASUMS256.txt`);
    let got;
    try { got = verifyArchive({ name, data, shasums, pin }); }
    catch (e) { rmSync(file, { force: true }); throw e; } // never keep a file that failed verification
    newPins.sha256[name] = got;
    log(`verified ${name} (${got.slice(0, 12)}...)`);
    out.set(target, { ...extractNode(data, version, target), archiveSha256: got });
  }
  if (updatePins) writeFileSync(pinFile, JSON.stringify(newPins, null, 2) + '\n');
  return out;
}
