/**
 * `botwarren update [--dry-run] [--version X] [--channel stable|beta]`, `botwarren update status`,
 * `botwarren verify-release --manifest <file> --sig <file> [--archive-sha256 <h> --platform <p>] [--allow-dev]`
 * (the last one is what the installers call BEFORE activating a download; it needs no config).
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { VERSION } from '../version.ts';
import { PINNED_PUBLIC_KEYS } from './keys.ts';
import { Platform, platformKey } from './manifest.ts';
import { resolvePolicy, type Policy, type UpdatesConfig } from './policy.ts';
import { readPointer, readResult, readUpdateState } from './state.ts';
import { Updater, type Outcome } from './updater.ts';
import { verifyManifest } from './verify.ts';
import type { PinnedKey } from './keys.ts';

export interface UpdateCliDeps { out?: (s: string) => void; err?: (s: string) => void; env?: Record<string, string | undefined>; updater?: Updater; keys?: readonly PinnedKey[] }

export function currentPolicy(env: Record<string, string | undefined> = process.env, cfg?: UpdatesConfig): Policy {
  return resolvePolicy({ env, config: cfg, root: env.BOTWARREN_HOME || null, execPath: process.execPath });
}

export function describeOutcome(o: Outcome): string {
  switch (o.status) {
    case 'up_to_date': return `Already up to date (${o.version}).`;
    case 'skipped': return `No update applied (${o.reason}${o.version ? `, ${o.version}` : ''}).`;
    case 'would_update': return `Would update to ${o.version}${o.rollback ? ' (signed rollback)' : ''}${o.forced ? ' (required)' : ''}. Nothing was changed.`;
    case 'staged': return `Updated to ${o.version}. It starts the next time the agent restarts (automatically when idle).`;
    case 'error': return `Update failed (${o.code}). Nothing was changed.`;
  }
}

export async function runUpdate(args: string[], deps: UpdateCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const err = deps.err ?? ((s: string) => process.stderr.write(s));
  const env = deps.env ?? process.env;
  let cfg: UpdatesConfig | undefined;
  try { cfg = loadConfig().updates; } catch { cfg = undefined; } // updating must work before pairing
  let channel: 'stable' | 'beta' | undefined; let version: string | undefined; let dry = false; let status = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'status') status = true;
    else if (a === '--dry-run') dry = true;
    else if (a === '--version') version = args[++i];
    else if (a === '--channel') { const c = args[++i]; if (c !== 'stable' && c !== 'beta') { err('--channel must be stable or beta\n'); return 2; } channel = c; }
    else { err(`unknown option ${a}\nusage: botwarren update [status] [--dry-run] [--version X] [--channel stable|beta]\n`); return 2; }
  }
  const policy = currentPolicy(env, cfg);
  const root = env.BOTWARREN_HOME ?? null;
  if (status) {
    const ptr = root ? readPointer(root) : null;
    const st = root ? readUpdateState(root) : null;
    const last = root ? readResult(root) : null;
    out([
      `Ship agent ${VERSION}${ptr ? ` (${ptr.state})` : ''}, install method: ${policy.method}`,
      `Automatic updates: ${policy.background ? `on (${policy.channel} channel, from ${new URL(policy.baseUrl).origin})` : `off (${policy.reason})`}`,
      ...(st && st.lastCheckMs ? [`Last check: ${new Date(st.lastCheckMs).toISOString()}`] : []),
      ...(last ? [`Last update result: ${last.code} (${last.from} -> ${last.to})`] : []),
      'Turn off: set BOTWARREN_DISABLE_AUTOUPDATE=1, or "updates": {"enabled": false} in config.json.', '',
    ].join('\n'));
    return 0;
  }
  if (!policy.manual) {
    out(policy.reason === 'managed_install' ? `Botwarren was installed with ${policy.method}: update it with that tool, not with this command.\n` : `Updates are not available here (${policy.reason}).\n`);
    return policy.reason === 'managed_install' ? 0 : 1;
  }
  const updater = deps.updater ?? new Updater({
    root: root!, baseUrl: policy.baseUrl, currentVersion: VERSION, channel: channel ?? policy.channel, platform: policy.platform!, maximumVersion: policy.maximumVersion,
    allowDevKey: env.BOTWARREN_UPDATE_ALLOW_DEV_KEY === '1', log: (m) => err(`${m}\n`),
  });
  const res = await updater.check({ dryRun: dry, ...(version ? { explicitVersion: version } : {}) });
  (res.status === 'error' ? err : out)(describeOutcome(res) + '\n');
  return res.status === 'error' ? 1 : 0;
}

export async function runVerifyRelease(args: string[], deps: UpdateCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const err = deps.err ?? ((s: string) => process.stderr.write(s));
  const opt = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const mf = opt('--manifest'); const sf = opt('--sig');
  if (!mf || !sf) { err('usage: botwarren verify-release --manifest <file> --sig <file> [--archive-sha256 <hash> --platform <p>] [--allow-dev]\n'); return 2; }
  let bytes: Buffer; let sig: string;
  try { bytes = readFileSync(mf); sig = readFileSync(sf, 'utf8'); } catch { err('cannot read the manifest or signature file\n'); return 2; }
  const allowDev = args.includes('--allow-dev') || (deps.env ?? process.env).BOTWARREN_UPDATE_ALLOW_DEV_KEY === '1';
  const v = verifyManifest(bytes, sig, { keys: deps.keys ?? PINNED_PUBLIC_KEYS, now: new Date(), allowDev, highestSeen: 0 });
  if (!v.ok) { err(`release verification FAILED (${v.code})\n`); return 1; }
  const sha = opt('--archive-sha256'); const plat = opt('--platform');
  if (sha || plat) {
    const p = Platform.safeParse(plat);
    const ver = opt('--version') ?? v.manifest.channels.stable;
    const art = p.success ? v.manifest.releases[ver]?.full[p.data] : undefined;
    if (!sha || !p.success || !art || art.sha256 !== sha.toLowerCase()) { err('release verification FAILED (archive hash is not the one in the signed manifest)\n'); return 1; }
  }
  out(`release verified (signed by ${v.keyId}, manifest ${v.manifest.manifestVersion}, stable ${v.manifest.channels.stable}, platform ${platformKey() ?? 'unsupported'})\n`);
  return 0;
}
