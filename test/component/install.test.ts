/**
 * The install gate for the optional Botwarren Companion component: refuses unsigned, wrong-signer, wrong-domain, expired, rolled-back,
 * wrong-hash, wrong-name and malformed bundles; refuses without recorded consent; refuses when blocked locally; runs NOTHING before every
 * check has passed; the website can only say install/remove.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeZip } from '../../src/update/archive.ts';
import { signManifestBytes } from '../../src/update/verify.ts';
import { signComponentBytes } from '../../src/component/verify.ts';
import { componentPaths, installCompanion, readConsent, readCurrent, recordConsent, removeCompanion, setLocalBlock, isLocallyBlocked, type InstallOptions } from '../../src/component/install.ts';
import { parseDirective } from '../../src/component/directive.ts';
import { startComponentService } from '../../src/component/service.ts';
import { NOW, fakeFetch, makeKey, mkTmp, rmTmp, sha256, type TestKey } from '../update/kit.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });
const BASE = 'https://downloads.test/';
const key = makeKey('comp-1', false, 'component');
const CONSENT = '2026-10-14T11:00:00.000Z';

const bundleOf = (version: string, extra: Record<string, string> = {}, drop: string[] = []): Buffer => {
  const base: Record<string, string> = { 'companion.mjs': `if (process.argv.includes('version')) process.stdout.write('${version}\\n');\n`, VERSION: `${version}\n`, LICENSE: 'Apache-2.0\n', ...extra };
  for (const d of drop) delete base[d];
  return writeZip(Object.entries(base).map(([name, data]) => ({ name, data: Buffer.from(data), mode: 0o644 })));
};

interface Opts { version?: string; bundle?: Buffer; manifest?: Record<string, unknown>; signer?: TestKey; keyId?: string; domain?: 'component' | 'agent'; consent?: boolean; selftest?: boolean; tamperBundle?: (b: Buffer) => Buffer; pinned?: TestKey['pinned'][]; allowDev?: boolean; env?: Record<string, string> }

function setup(o: Opts = {}) {
  const root = mkTmp(); cleanup.push(() => rmTmp(root));
  const version = o.version ?? '0.1.0';
  const bundle = o.bundle ?? bundleOf(version);
  const doc = {
    schema: 1, kind: 'botwarren-component', component: 'companion', epoch: 1, manifestVersion: 3, issued: '2026-10-14T00:00:00.000Z', expires: '2026-12-01T00:00:00.000Z',
    channels: { stable: version }, blocked: [],
    releases: { [version]: { protocol: { min: 1, max: 1 }, bundle: { url: `companion-${version}.zip`, sha256: sha256(bundle), size: bundle.length }, minAgent: '0.6.0' } },
    ...o.manifest,
  };
  const bytes = Buffer.from(JSON.stringify(doc, null, 2));
  const signer = o.signer ?? key;
  const sig = (o.domain === 'agent' ? signManifestBytes : signComponentBytes)(bytes, signer.pem, o.keyId ?? signer.pinned.id);
  const served = o.tamperBundle ? o.tamperBundle(bundle) : bundle;
  const files = new Map<string, Buffer | string>([['companion/manifest.json', bytes], ['companion/manifest.json.sig', sig], [`companion/companion-${version}.zip`, served]]);
  const f = fakeFetch(files);
  const logs: string[] = [];
  let selftests = 0;
  if (o.consent !== false) recordConsent(root, CONSENT, NOW.getTime());
  const opts: InstallOptions = {
    root, baseUrl: BASE, agentVersion: '0.6.0', now: () => NOW.getTime(), fetchImpl: f.impl, keys: o.pinned ?? [key.pinned], log: (m) => logs.push(m),
    ...(o.allowDev ? { allowDevKey: true } : {}), ...(o.env ? { env: o.env } : {}),
    ...(o.selftest === undefined ? {} : { selftest: async () => { selftests++; return o.selftest!; } }),
  };
  return { root, opts, logs, requests: f.requests, selftests: () => selftests, go: () => installCompanion(opts), files };
}

const noRun = (s: ReturnType<typeof setup>): void => {
  expect(s.selftests()).toBe(0);
  expect(existsSync(componentPaths(s.root).versions) ? readdirSync(componentPaths(s.root).versions) : []).toEqual([]);
  expect(readCurrent(s.root)).toBeNull();
};

describe('companion install: the happy path', () => {
  it('verifies, extracts only allowlisted files, runs the self-test last, and leaves a notice, a log line and a current pointer', async () => {
    const s = setup();
    const r = await s.go(); // the REAL default self-test runs the staged companion.mjs under node
    expect(r).toEqual({ status: 'installed', version: '0.1.0', replaced: null });
    expect(readdirSync(componentPaths(s.root).version('0.1.0')).sort()).toEqual(['LICENSE', 'VERSION', 'companion.mjs']);
    const cur = readCurrent(s.root)!;
    expect(cur).toMatchObject({ version: '0.1.0', keyId: 'comp-1', consentAt: CONSENT, manifestVersion: 3 });
    expect(cur.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(componentPaths(s.root).notice, 'utf8')).toContain('because your Botwarren account asked for it');
    expect(s.logs.join('\n')).toMatch(/companion: installed 0\.1\.0 \(signed by comp-1/);
    expect(await s.go()).toEqual({ status: 'current', version: '0.1.0' });
  });
});

describe('companion install: nothing runs unless every check passes', () => {
  it('no recorded consent: nothing is even downloaded', async () => {
    const s = setup({ consent: false });
    expect(await s.go()).toEqual({ status: 'refused', code: 'no_consent' });
    expect(s.requests).toEqual([]);
    noRun(s);
  });

  it('blocked on this computer (file or environment): refused before any download', async () => {
    const s = setup();
    setLocalBlock(s.root, true);
    expect(isLocallyBlocked(s.root, {})).toBe(true);
    expect(await s.go()).toEqual({ status: 'refused', code: 'disabled_locally' });
    setLocalBlock(s.root, false);
    expect(await installCompanion({ ...s.opts, env: { BOTWARREN_DISABLE_COMPONENTS: '1' } })).toEqual({ status: 'refused', code: 'disabled_locally' });
    expect(s.requests).toEqual([]);
    noRun(s);
  });

  it.each([
    ['an unsigned manifest (bad signature file)', () => setup(), (s: ReturnType<typeof setup>) => s.files.set('companion/manifest.json.sig', 'not json'), 'bad_signature_file'],
    ['a manifest changed after signing', () => setup(), (s: ReturnType<typeof setup>) => s.files.set('companion/manifest.json', Buffer.from(String(s.files.get('companion/manifest.json')).replace('0.1.0', '0.1.1'))), 'bad_signature'],
    ['a key the agent does not pin', () => setup({ signer: makeKey('comp-1', false, 'component') }), null, 'bad_signature'],
    ['a key id that is not pinned', () => setup({ keyId: 'someone-else' }), null, 'unknown_key'],
    ['a dev key without the dev switch', () => { const dev = makeKey('dev-x', true, 'component'); return setup({ signer: dev, pinned: [dev.pinned] }); }, null, 'dev_key_refused'],
    ['an AGENT update manifest signature (different domain)', () => setup({ domain: 'agent' }), null, 'bad_signature'],
    ['an expired manifest', () => setup({ manifest: { expires: '2026-10-01T00:00:00.000Z' } }), null, 'expired'],
    ['another trust epoch', () => setup({ manifest: { epoch: 2 } }), null, 'epoch_unknown'],
    ['a manifest for another component (schema)', () => setup({ manifest: { component: 'agent' } }), null, 'malformed'],
    ['unknown fields (a url smuggled into the manifest)', () => setup({ manifest: { downloadFrom: 'https://evil.example/x' } }), null, 'malformed'],
  ] as const)('refuses %s', async (_name, make, mutate, detail) => {
    const s = make();
    if (mutate) mutate(s);
    const r = await s.go();
    expect(r).toEqual({ status: 'refused', code: 'manifest_refused', detail });
    noRun(s);
    expect(s.requests.some((u) => u.endsWith('.zip'))).toBe(false); // the bundle is never even downloaded
  });

  it('a recovery key can never sign a component manifest', async () => {
    const rec = makeKey('recovery-9');
    const s = setup({ signer: rec, pinned: [{ ...rec.pinned, role: 'recovery' }] });
    expect(await s.go()).toEqual({ status: 'refused', code: 'manifest_refused', detail: 'wrong_key_role' });
    noRun(s);
  });

  it('the agent-update RELEASE key can never sign a component manifest, even if it is in the key list (key separation)', async () => {
    const rel = makeKey('kms-2026a');
    const s = setup({ signer: rel, pinned: [rel.pinned] });
    expect(await s.go()).toEqual({ status: 'refused', code: 'manifest_refused', detail: 'wrong_key_role' });
    noRun(s);
  });

  it('with the default key set, a manifest signed under the agent-update key id is an unknown key', async () => {
    const rel = makeKey('kms-2026a');
    const s = setup({ signer: rel });
    const { keys: _pinned, ...withDefaultKeys } = s.opts;
    expect(await installCompanion(withDefaultKeys)).toEqual({ status: 'refused', code: 'manifest_refused', detail: 'unknown_key' });
    noRun(s);
  });

  it('a manifest older than one already accepted is a rollback and is refused', async () => {
    const s = setup({ manifest: { manifestVersion: 3 } });
    writeFileSync(join(mkdirSyncP(join(s.root, 'state')), 'component-companion.json'), JSON.stringify({ highestManifestVersion: 9 }));
    expect(await s.go()).toEqual({ status: 'refused', code: 'manifest_refused', detail: 'rollback' });
    noRun(s);
  });

  it('wrong hash, wrong size: the archive is never opened', async () => {
    const a = setup({ tamperBundle: (b) => { const c = Buffer.from(b); c[c.length - 30] = c[c.length - 30]! ^ 1; return c; } });
    expect((await a.go()).status === 'refused' && (await a.go())).toMatchObject({ code: 'hash_mismatch' });
    noRun(a);
    const b = setup({ tamperBundle: (x) => x.subarray(0, x.length - 10) }); // shorter than the signed size
    expect(await b.go()).toEqual({ status: 'refused', code: 'size_mismatch' });
    noRun(b);
    const c = setup({ tamperBundle: (x) => Buffer.concat([x, Buffer.from('trailing bytes')]) }); // longer than the signed size: the download is cut off
    expect(await c.go()).toEqual({ status: 'refused', code: 'download_failed' });
    noRun(c);
  });

  it.each([
    ['an extra file in the archive', { extra: { 'install.sh': 'rm -rf ~' } }],
    ['a path traversal entry', { extra: { '../evil.mjs': 'x' } }],
    ['a nested path', { extra: { 'bin/companion': 'x' } }],
    ['a missing required file', { drop: ['companion.mjs'] }],
    ['a VERSION that disagrees with the signed manifest', { extra: { VERSION: '9.9.9\n' } }],
  ])('refuses a bundle with %s (hash is right, content is not)', async (_n, spec: { extra?: Record<string, string>; drop?: string[] }) => {
    const bundle = (() => {
      try { return bundleOf('0.1.0', spec.extra ?? {}, spec.drop ?? []); } catch { return null; }
    })();
    if (!bundle) return; // the archive writer itself refuses a traversal name; the reader refuses it too (archive.test.ts)
    const s = setup({ bundle });
    expect(await s.go()).toEqual({ status: 'refused', code: 'bad_bundle' });
    noRun(s);
  });

  it('a self-test that fails removes the staged version and installs nothing', async () => {
    const s = setup({ selftest: false });
    expect(await s.go()).toEqual({ status: 'refused', code: 'selftest_failed' });
    expect(s.selftests()).toBe(1);
    expect(readCurrent(s.root)).toBeNull();
    expect(existsSync(componentPaths(s.root).version('0.1.0'))).toBe(false);
  });

  it('a blocked version, an incompatible protocol, an agent that is too old, a runtime that is too old', async () => {
    const a = setup({ manifest: { blocked: ['0.1.0'] } }); expect(await a.go()).toEqual({ status: 'refused', code: 'version_not_installable' }); noRun(a);
    const b = setup(); const p = JSON.parse(String(b.files.get('companion/manifest.json'))); p.releases['0.1.0'].protocol = { min: 2, max: 2 };
    const c = setup({ manifest: { releases: p.releases } }); expect(await c.go()).toEqual({ status: 'refused', code: 'version_not_installable' }); noRun(c);
    const d = setup(); expect(await installCompanion({ ...d.opts, agentVersion: '0.5.0' })).toEqual({ status: 'refused', code: 'agent_too_old' }); noRun(d);
    const rel = JSON.parse(String(b.files.get('companion/manifest.json'))).releases['0.1.0']; rel.minRuntime = '99.0.0';
    const e = setup({ manifest: { releases: { '0.1.0': rel } } }); expect(await e.go()).toEqual({ status: 'refused', code: 'runtime_too_old' }); noRun(e);
  });

  it('refuses a plain-http or credentialed download base', async () => {
    const s = setup();
    expect(await installCompanion({ ...s.opts, baseUrl: 'http://downloads.test/' })).toEqual({ status: 'refused', code: 'insecure_url' });
    expect(await installCompanion({ ...s.opts, baseUrl: 'https://user:pw@downloads.test/' })).toEqual({ status: 'refused', code: 'insecure_url' });
    noRun(s);
  });
});

const mkdirSyncP = (p: string): string => { mkdirSync(p, { recursive: true }); return p; };

describe('the website can only say install or remove', () => {
  const now = NOW.getTime();
  it('parseDirective is strict: any other field, a url, a bad or implausible time is ignored', () => {
    expect(parseDirective({ want: 'install', consent: CONSENT }, now)).toEqual({ want: 'install', consent: CONSENT });
    expect(parseDirective({ want: 'remove', consent: CONSENT }, now)).toEqual({ want: 'remove', consent: CONSENT });
    for (const bad of [
      { want: 'install', consent: CONSENT, url: 'https://evil.example/x.zip' }, { want: 'install', consent: CONSENT, version: '9.9.9' }, { want: 'install', consent: CONSENT, command: 'sh' },
      { want: 'run', consent: CONSENT }, { want: 'install' }, { consent: CONSENT }, { want: 'install', consent: 'yesterday' }, { want: 'install', consent: '2020-01-01T00:00:00Z' },
      { want: 'install', consent: '2099-01-01T00:00:00Z' }, null, 'install', [], { want: 'install', consent: 5 },
    ]) expect(parseDirective(bad, now), JSON.stringify(bad)).toBeNull();
  });
});

describe('the service: directive in, install, enrol, report; remove; refusals are reported', () => {
  function svc(o: Opts = {}) {
    const s = setup({ ...o, consent: false });
    const calls: { url: string; body: unknown }[] = [];
    const ran: string[][] = [];
    const cloud = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('https://ship.test/internal/companion/')) {
        calls.push({ url: u, body: JSON.parse(String(init?.body)) });
        if (u.endsWith('/ticket')) return new Response(JSON.stringify({ v: 1, relayUrl: 'https://relay.test', ticket: { j: 'x', s: 'y'.repeat(86) }, acct: 'acct-x' }), { status: 200 });
        return new Response('{"ok":true}', { status: 200 });
      }
      return (fakeFetch(s.files).impl)(url, init);
    }) as typeof fetch;
    let daemonStarted = 0; let daemonStopped = 0;
    const service = startComponentService({
      root: s.root, baseUrl: BASE, agentVersion: '0.6.0', cloudUrl: 'https://ship.test/internal/companion', secret: 'ship-secret', log: (m) => s.logs.push(m), fetchImpl: cloud, keys: [key.pinned], now: () => NOW.getTime(),
      run: async (_entry, args, input) => { ran.push([...args, ...(input ? ['<stdin>'] : [])]); return { code: 0, stdout: args[0] === 'init' ? JSON.stringify({ hostId: 'h', hostSig: 'A'.repeat(43) }) : '' }; },
      startDaemon: () => { daemonStarted++; return { stop: () => { daemonStopped++; } }; }, retryMs: 0,
      ...(o.selftest === undefined ? { selftest: async () => true } : { selftest: async () => o.selftest! }),
    });
    return { s, service, calls, ran, daemon: () => ({ started: daemonStarted, stopped: daemonStopped }) };
  }

  it('records consent from the directive, installs the signed component, enrols it for ITS key, starts it, reports installed', async () => {
    const t = svc();
    t.service.onSettings({ companion: { want: 'install', consent: CONSENT } });
    await t.service.idle();
    expect(readConsent(t.s.root)?.consentAt).toBe(CONSENT);
    expect(readCurrent(t.s.root)?.version).toBe('0.1.0');
    expect(t.ran).toEqual([['init', '--json'], ['enroll', '<stdin>']]);
    expect(t.calls.map((c) => c.url.split('/').pop())).toEqual(['ticket', 'report']);
    expect(t.calls[0]!.body).toEqual({ hostSig: 'A'.repeat(43) }); // only the PUBLIC host key
    expect(t.calls[1]!.body).toEqual({ state: 'installed', version: '0.1.0' });
    expect(t.daemon().started).toBe(1);
    expect(t.s.logs.join('\n')).toContain('your account asked for it');
    // repeated settings do nothing more
    t.service.onSettings({ companion: { want: 'install', consent: CONSENT } }); await t.service.idle();
    expect(t.calls).toHaveLength(2);
    t.service.stop();
  });

  it('ignores a directive that carries a url, a version or a command, and never downloads anything for it', async () => {
    const t = svc();
    t.service.onSettings({ companion: { want: 'install', consent: CONSENT, url: 'https://evil.example/x.zip' } });
    t.service.onSettings({ companion: 'install' }); t.service.onSettings({ companion: undefined }); t.service.onSettings(null);
    await t.service.idle();
    expect(t.s.requests).toEqual([]); expect(t.calls).toEqual([]);
    expect(readConsent(t.s.root)).toBeNull();
    t.service.stop();
  });

  it('a refused install (bad hash) is reported as failed with a fixed code and runs nothing', async () => {
    const t = svc({ tamperBundle: (b) => Buffer.concat([b, Buffer.from('x')]) });
    t.service.onSettings({ companion: { want: 'install', consent: CONSENT } }); await t.service.idle();
    expect(readCurrent(t.s.root)).toBeNull();
    expect(t.calls).toEqual([{ url: 'https://ship.test/internal/companion/report', body: { state: 'failed', code: 'size_mismatch' } }]);
    expect(t.ran).toEqual([]); expect(t.daemon().started).toBe(0);
    t.service.stop();
  });

  it('blocked on this computer: the directive is recorded as refused and nothing is installed', async () => {
    const t = svc();
    setLocalBlock(t.s.root, true);
    t.service.onSettings({ companion: { want: 'install', consent: CONSENT } }); await t.service.idle();
    expect(readCurrent(t.s.root)).toBeNull();
    expect(t.s.requests).toEqual([]);
    expect(t.calls[0]!.body).toMatchObject({ state: 'failed', code: 'disabled_locally' });
    t.service.stop();
  });

  it('"remove" runs the companion\'s own uninstall, deletes the files and the consent, stops the daemon and reports removed', async () => {
    const t = svc();
    t.service.onSettings({ companion: { want: 'install', consent: CONSENT } }); await t.service.idle();
    t.calls.length = 0; t.ran.length = 0;
    t.service.onSettings({ companion: { want: 'remove', consent: CONSENT } }); await t.service.idle();
    expect(t.ran).toEqual([['uninstall', '--purge', '--yes']]);
    expect(existsSync(componentPaths(t.s.root).dir)).toBe(false);
    expect(readConsent(t.s.root)).toBeNull();
    expect(t.calls.at(-1)!.body).toEqual({ state: 'removed' });
    expect(t.daemon().stopped).toBeGreaterThanOrEqual(1);
    t.service.stop();
  });

  it('removeCompanion works without the website and without a running companion', async () => {
    const s = setup();
    await s.go();
    const logs: string[] = [];
    await removeCompanion({ root: s.root, log: (m) => logs.push(m), run: async () => false });
    expect(readCurrent(s.root)).toBeNull();
    expect(logs.join(' ')).toContain('removed from this computer');
  });
});
