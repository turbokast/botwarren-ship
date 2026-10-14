/** Release-building helpers for the update tests: an in-memory signing key, bundles, manifests, a fake download host. */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../src/update/archive.ts';
import type { Manifest } from '../../src/update/manifest.ts';
import type { PinnedKey } from '../../src/update/keys.ts';
import { signManifestBytes } from '../../src/update/verify.ts';
import { writePointer, type Pointer } from '../../src/update/state.ts';

export const NOW = new Date('2026-10-14T12:00:00.000Z');
export const mkTmp = (): string => mkdtempSync(join(tmpdir(), 'bw-upd-'));
export const rmTmp = (p: string): void => rmSync(p, { recursive: true, force: true });

export interface TestKey { pinned: PinnedKey; pem: string }
export function makeKey(id = 'test-1', dev = false): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pinned: { id, spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), dev }, pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** An app bundle zip for `version`. `agentSrc` is the agent.mjs text (so launcher tests can run it). */
export function makeBundle(version: string, files: Record<string, string> = {}): Buffer {
  const base: Record<string, string> = { 'agent.mjs': '// agent\n', 'cli.mjs': `process.stdout.write('botwarren ship agent ${version}\\n');\n`, 'ops.html': '<h1>ops</h1>', VERSION: `${version}\n`, ...files };
  return writeZip(Object.entries(base).map(([name, data]) => ({ name, data: Buffer.from(data), mode: 0o644 })));
}

export interface ReleaseSpec { version: string; bundle?: Buffer; rolloutBp?: number; critical?: boolean; salt?: string; protocol?: { min: number; max: number } }

export function makeManifest(o: { manifestVersion?: number; expires?: string; stable: string; minSupported?: string; blocked?: string[]; rollbackFrom?: { from: string; to: string }[]; releases: ReleaseSpec[]; urlBase?: string }): { manifest: Manifest; bundles: Map<string, Buffer> } {
  const bundles = new Map<string, Buffer>();
  const releases: Manifest['releases'] = {};
  for (const r of o.releases) {
    const b = r.bundle ?? makeBundle(r.version);
    const url = `bundle-${r.version}.zip`;
    bundles.set(url, b);
    releases[r.version] = { protocol: r.protocol ?? { min: 1, max: 1 }, rolloutBp: r.rolloutBp ?? 10_000, rolloutSalt: r.salt ?? 'salt1', critical: r.critical ?? false, bundle: { url, sha256: sha256(b), size: b.length }, full: {} };
  }
  return {
    bundles,
    manifest: {
      schema: 1, manifestVersion: o.manifestVersion ?? 1, issued: '2026-10-14T00:00:00.000Z', expires: o.expires ?? '2026-10-28T00:00:00.000Z',
      channels: { stable: o.stable }, minSupported: o.minSupported ?? '0.1.0', blocked: o.blocked ?? [], rollbackFrom: o.rollbackFrom ?? [], releases,
    },
  };
}

export function sign(manifest: unknown, key: TestKey): { bytes: Buffer; sig: string } {
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  return { bytes, sig: signManifestBytes(bytes, key.pem, key.pinned.id) };
}

/** A fake download host: serves whatever is in `files`; records requested URLs. */
export function fakeFetch(files: Map<string, Buffer | string>, base = 'https://downloads.test/') {
  const requests: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    const rel = url.startsWith(base) ? url.slice(base.length) : null;
    const body = rel !== null ? files.get(rel) : undefined;
    if (body === undefined) return new Response('nope', { status: 404 });
    const buf = typeof body === 'string' ? Buffer.from(body) : body;
    return new Response(new Uint8Array(buf), { status: 200 });
  }) as typeof fetch;
  return { impl, requests };
}

/** An installed root with one running version. */
export function makeRoot(version = '0.4.0', ptr: Partial<Pointer> = {}): string {
  const root = mkTmp();
  const dir = join(root, 'versions', version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.mjs'), '//');
  writePointer(root, { version, previous: null, knownGood: version, state: 'stable', bootCount: 0, trialStarted: null, ...ptr });
  return root;
}
