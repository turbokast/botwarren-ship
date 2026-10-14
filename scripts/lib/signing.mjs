/**
 * OPTIONAL code-signing stages. They run only when their credentials are present and the host can run the tool;
 * otherwise they are skipped cleanly with a reason (exit 0), unless --require-signing is set (release mode), which makes a
 * skipped stage a failure. Secrets are only ever read from the environment and are never printed (plans show variable NAMES).
 *
 * WINDOWS: Microsoft Artifact Signing (formerly Trusted Signing), Authenticode via signtool + the Azure.CodeSigning dlib.
 *   Runs on a Windows host only.
 *     AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET   service principal with the "Artifact Signing Certificate Profile Signer" role
 *     ARTIFACT_SIGNING_ENDPOINT      e.g. https://weu.codesigning.azure.net
 *     ARTIFACT_SIGNING_ACCOUNT       the Artifact Signing account name
 *     ARTIFACT_SIGNING_PROFILE       the certificate profile name
 *     ARTIFACT_SIGNING_DLIB          path to Azure.CodeSigning.Dlib.dll
 *     SIGNTOOL_PATH                  path to signtool.exe (default: signtool.exe on PATH)
 *     BOTWARREN_SIGN_NODE=1          optional: also re-sign the bundled node.exe with our identity (it is already signed by OpenJS)
 *   Timestamp: http://timestamp.acs.microsoft.com (certificates last 72 hours, so a timestamp is mandatory).
 *   Signed: *.exe, *.dll, install.ps1, uninstall.ps1 and bin/*.ps1 in the staged tree.
 *
 * MACOS: Developer ID codesign (hardened runtime) + notarytool + stapler. Runs on a macOS host only.
 *     APPLE_SIGNING_IDENTITY         e.g. "Developer ID Application: TurboKast Ltd (TEAMID1234)"
 *     notarisation credentials, ONE of:
 *       APPLE_NOTARY_KEYCHAIN_PROFILE                         (xcrun notarytool store-credentials ...)
 *       APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD
 *       APPLE_NOTARY_KEY_PATH + APPLE_NOTARY_KEY_ID + APPLE_NOTARY_ISSUER   (App Store Connect API key, .p8)
 *   Signed: the bundled runtime/node binary (re-signed with entitlements for V8's JIT, so Login Items shows our company
 *   name instead of "Node.js Foundation"). Notarised: a zip of the signed binary. Bare Mach-O files cannot be stapled; stapling
 *   happens only for .pkg/.dmg artifacts (stapleArtifacts). Without macOS hardware, rcodesign is the documented alternative
 *   (docs/ARCHITECTURE.md).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const WIN_ENV = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'ARTIFACT_SIGNING_ENDPOINT', 'ARTIFACT_SIGNING_ACCOUNT', 'ARTIFACT_SIGNING_PROFILE', 'ARTIFACT_SIGNING_DLIB'];
export const MAC_ENV = ['APPLE_SIGNING_IDENTITY'];
export const TIMESTAMP_URL = 'http://timestamp.acs.microsoft.com';

const missing = (env, names) => names.filter((n) => !env[n]);

export function macNotaryAuth(env) {
  if (env.APPLE_NOTARY_KEYCHAIN_PROFILE) return ['--keychain-profile', env.APPLE_NOTARY_KEYCHAIN_PROFILE];
  if (env.APPLE_ID && env.APPLE_TEAM_ID && env.APPLE_APP_SPECIFIC_PASSWORD) return ['--apple-id', env.APPLE_ID, '--team-id', env.APPLE_TEAM_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD];
  if (env.APPLE_NOTARY_KEY_PATH && env.APPLE_NOTARY_KEY_ID && env.APPLE_NOTARY_ISSUER) return ['--key', env.APPLE_NOTARY_KEY_PATH, '--key-id', env.APPLE_NOTARY_KEY_ID, '--issuer', env.APPLE_NOTARY_ISSUER];
  return null;
}

function walk(dir, base = dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, base, out); else out.push(p.slice(base.length + 1).replaceAll('\\', '/'));
  }
  return out;
}

/** Which staged files each platform signs. */
export function signableFiles(files, platform, env = {}) {
  if (platform === 'win') {
    return files.filter((f) => /\.(exe|dll)$/i.test(f) ? (!/^runtime\/.*node\.exe$/i.test(f) || env.BOTWARREN_SIGN_NODE === '1') : /(^|\/)(install|uninstall)\.ps1$|^bin\/.*\.ps1$/i.test(f));
  }
  if (platform === 'mac') return files.filter((f) => f === 'runtime/node/node');
  return [];
}

/**
 * Plan for one staged tree. Returns { status: 'skipped', reason, missing? } or { status: 'planned', steps: [{ label, cmd, args, redact }] }.
 * `host` is process.platform (injectable for tests).
 */
export function planSigning({ platform, files, env, host = process.platform, stageDir, entitlements }) {
  if (platform === 'win') {
    const targets = signableFiles(files, 'win', env);
    if (targets.length === 0) return { status: 'skipped', reason: 'nothing to sign in this archive' };
    const miss = missing(env, WIN_ENV);
    if (miss.length) return { status: 'skipped', reason: 'Artifact Signing credentials not set', missing: miss };
    if (host !== 'win32') return { status: 'skipped', reason: 'Authenticode signing needs a Windows host (signtool.exe)' };
    const meta = join(mkdtempSync(join(tmpdir(), 'bw-sign-')), 'metadata.json');
    return {
      status: 'planned',
      prepare: () => writeFileSync(meta, JSON.stringify({ Endpoint: env.ARTIFACT_SIGNING_ENDPOINT, CodeSigningAccountName: env.ARTIFACT_SIGNING_ACCOUNT, CertificateProfileName: env.ARTIFACT_SIGNING_PROFILE })),
      steps: targets.map((f) => ({ label: `signtool sign ${f}`, cmd: env.SIGNTOOL_PATH || 'signtool.exe', args: ['sign', '/v', '/fd', 'SHA256', '/tr', TIMESTAMP_URL, '/td', 'SHA256', '/dlib', env.ARTIFACT_SIGNING_DLIB, '/dmdf', meta, join(stageDir, f)] })),
    };
  }
  if (platform === 'mac') {
    const targets = signableFiles(files, 'mac', env);
    if (targets.length === 0) return { status: 'skipped', reason: 'nothing to sign in this archive' };
    const miss = missing(env, MAC_ENV);
    if (miss.length) return { status: 'skipped', reason: 'Apple Developer ID credentials not set', missing: miss };
    if (host !== 'darwin') return { status: 'skipped', reason: 'codesign/notarytool need a macOS host (rcodesign is the Linux alternative, see the docs)' };
    const auth = macNotaryAuth(env);
    const steps = [];
    for (const f of targets) {
      const full = join(stageDir, f);
      steps.push({ label: `codesign ${f}`, cmd: 'codesign', args: ['--force', '--options', 'runtime', '--timestamp', '--entitlements', entitlements, '--sign', env.APPLE_SIGNING_IDENTITY, full] });
      steps.push({ label: `codesign --verify ${f}`, cmd: 'codesign', args: ['--verify', '--strict', '--verbose=2', full] });
    }
    if (auth) {
      const zip = join(stageDir, '..', `notarize-${Date.now()}.zip`);
      steps.push({ label: 'ditto (zip for notarisation)', cmd: 'ditto', args: ['-c', '-k', '--keepParent', join(stageDir, targets[0]), zip] });
      steps.push({ label: 'notarytool submit --wait', cmd: 'xcrun', args: ['notarytool', 'submit', zip, '--wait', ...auth], redact: auth });
    }
    return { status: 'planned', steps, notarised: !!auth, note: auth ? undefined : 'signed but NOT notarised: no notary credentials set' };
  }
  return { status: 'skipped', reason: 'no signing for this platform' };
}

/** .pkg / .dmg artifacts can be stapled (bare binaries cannot). */
export function stapleArtifacts(files, dir) { return files.filter((f) => /\.(pkg|dmg)$/i.test(f)).map((f) => ({ label: `stapler staple ${f}`, cmd: 'xcrun', args: ['stapler', 'staple', join(dir, f)] })); }

/** Executes a plan. `run` is injectable. Returns { status, ... }. */
export function executePlan(plan, { run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }), log = console.log, dryRun = false } = {}) {
  if (plan.status !== 'planned') return plan;
  const show = (s) => `${s.cmd} ${s.args.map((a) => (s.redact?.includes(a) ? '***' : a)).join(' ')}`;
  plan.prepare?.();
  for (const s of plan.steps) {
    log(`  ${dryRun ? '[dry-run] ' : ''}${s.label}`);
    if (dryRun) { log(`      ${show(s)}`); continue; }
    const r = run(s.cmd, s.args);
    if (r.status !== 0) throw new Error(`${s.label} failed (exit ${r.status})`);
  }
  return { status: dryRun ? 'dry-run' : 'signed', steps: plan.steps.length, ...(plan.note ? { note: plan.note } : {}) };
}

/** Signs a staged tree for a platform; skips cleanly; `requireSigning` turns a skip into an error. */
export function signStage({ platform, stageDir, env = process.env, host = process.platform, entitlements, requireSigning = false, dryRun = false, run, log = console.log }) {
  const files = walk(stageDir);
  const plan = planSigning({ platform, files, env, host, stageDir, entitlements });
  if (plan.status === 'skipped') {
    const msg = `signing skipped for ${platform}: ${plan.reason}${plan.missing ? ` (missing: ${plan.missing.join(', ')})` : ''}`;
    if (requireSigning && plan.reason !== 'no signing for this platform' && plan.reason !== 'nothing to sign in this archive') throw new Error(msg);
    log(`  ${msg}`);
    return plan;
  }
  return executePlan(plan, { ...(run ? { run } : {}), log, dryRun });
}
