/**
 * Who may update this install, and when. Default is ON and silent for standalone installs; everything below turns it off
 * or restricts it. A machine policy file overrides user config (the VS Code model).
 *
 *   env  BOTWARREN_DISABLE_UPDATES=1      no update traffic and no manual update either
 *   env  BOTWARREN_DISABLE_AUTOUPDATE=1   no background checks; `botwarren update` still works
 *   env  BOTWARREN_UPDATE_URL             alternative download base (mirror / air-gap; same signature chain)
 *   env  BOTWARREN_INSTALL_METHOD         set by Homebrew / Scoop shims: the package manager owns updates
 *   cfg  updates.{enabled,channel,baseUrl,maximumVersion}  (config.json)
 *   file /etc/botwarren/policy.json | %ProgramData%\Botwarren\policy.json   { "updates": { ...same keys... } }
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { readReceiptMethod, type InstallMethod } from './state.ts';
import { platformKey, type Platform } from './manifest.ts';
import { Version } from './manifest.ts';

export const DEFAULT_BASE_URL = 'https://downloads.botwarren.com/';

export const UpdatesConfigSchema = z.object({
  enabled: z.boolean().optional(),
  channel: z.enum(['stable', 'beta']).optional(),
  baseUrl: z.string().url().max(512).optional(),
  maximumVersion: Version.optional(),
}).strict();
export type UpdatesConfig = z.infer<typeof UpdatesConfigSchema>;

export type PolicyReason = 'ok' | 'env_disable_updates' | 'env_disable_autoupdate' | 'config_disabled' | 'managed_install' | 'no_install_root' | 'unsupported_platform' | 'ci';

export interface Policy {
  /** scheduled background checks */
  background: boolean;
  /** `botwarren update` */
  manual: boolean;
  reason: PolicyReason;
  method: InstallMethod;
  channel: 'stable' | 'beta';
  baseUrl: string;
  maximumVersion: string | undefined;
  platform: Platform | null;
}

export interface PolicyInput {
  env: Record<string, string | undefined>;
  config: UpdatesConfig | undefined;
  /** BOTWARREN_HOME of a launcher-managed install, or null */
  root: string | null;
  platform?: string;
  arch?: string;
  execPath?: string;
  /** injectable for tests */
  readPolicyFile?: () => unknown;
  fileExists?: (p: string) => boolean;
}

export function machinePolicyPath(platform: string, env: Record<string, string | undefined>): string {
  return platform === 'win32' ? `${env.ProgramData ?? 'C:\\ProgramData'}\\Botwarren\\policy.json` : '/etc/botwarren/policy.json';
}

export function detectMethod(input: PolicyInput): InstallMethod {
  const e = input.env.BOTWARREN_INSTALL_METHOD;
  if (e && ['standalone', 'brew', 'scoop', 'winget', 'apt', 'npm', 'docker', 'dev'].includes(e)) return e as InstallMethod;
  if (input.root) {
    const r = readReceiptMethod(input.root);
    if (r) return r;
  }
  const exists = input.fileExists ?? existsSync;
  if (exists('/.dockerenv')) return 'docker';
  const p = `${input.root ?? ''} ${input.execPath ?? ''}`;
  if (/[\\/]Caskroom[\\/]|[\\/]Cellar[\\/]|^\/opt\/homebrew\//.test(p)) return 'brew';
  if (/[\\/]scoop[\\/]/i.test(p)) return 'scoop';
  if (/[\\/]WindowsApps[\\/]/.test(p)) return 'winget';
  if (/^\/usr\/lib\//.test(p)) return 'apt';
  if (/[\\/]node_modules[\\/]/.test(p)) return 'npm';
  return input.root ? 'standalone' : 'dev';
}

export function resolvePolicy(input: PolicyInput): Policy {
  const platform = input.platform ?? process.platform;
  const machine = ((): UpdatesConfig => {
    try {
      const raw = input.readPolicyFile ? input.readPolicyFile() : (() => { const p = machinePolicyPath(platform, input.env); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; })();
      const j = (raw as { updates?: unknown } | null)?.updates;
      const p = UpdatesConfigSchema.safeParse(j);
      return p.success ? p.data : {};
    } catch { return {}; }
  })();
  const cfg: UpdatesConfig = { ...(input.config ?? {}), ...machine }; // machine policy wins
  const method = detectMethod(input);
  const pk = platformKey(platform, input.arch);
  const base: Omit<Policy, 'background' | 'manual' | 'reason'> = {
    method, channel: cfg.channel ?? 'stable', platform: pk,
    baseUrl: (input.env.BOTWARREN_UPDATE_URL || cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/*$/, '/'),
    maximumVersion: cfg.maximumVersion,
  };
  const off = (reason: PolicyReason, manual = false): Policy => ({ ...base, background: false, manual, reason });
  const truthy = (v: string | undefined) => v === '1' || v === 'true';
  if (truthy(input.env.BOTWARREN_DISABLE_UPDATES)) return off('env_disable_updates');
  if (!input.root) return off('no_install_root');
  if (!pk) return off('unsupported_platform');
  if (method !== 'standalone') return off('managed_install'); // the package manager owns updates: notice only
  if (cfg.enabled === false) return off('config_disabled', true);
  if (truthy(input.env.BOTWARREN_DISABLE_AUTOUPDATE)) return off('env_disable_autoupdate', true);
  if (truthy(input.env.CI)) return off('ci', true);
  return { ...base, background: true, manual: true, reason: 'ok' };
}
