/**
 * Per-user adapter settings (config.json `adapters`), detection environment and `config.json` editing for
 * `botwarren adapters enable|disable`.
 *
 *   "adapters": { "ninox": { "enabled": true, "port": 8081 }, "gemini-cli": { "enabled": false } }
 *
 * `enabled`: true = always poll, false = never, "auto" (default for tools that are not Claude Code / Codex) = poll only
 * while the tool is detected on this computer. Nothing is read from a tool whose adapter is disabled.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, posix, win32 } from 'node:path';
import { z } from 'zod';
import { AdapterId, type AdapterSettings, type DetectEnv, type ProjectRef } from './api.ts';
import { makeScopedFs, probeLoopback } from './policy.ts';
import type { Host } from '../paths.ts';

const Setting = z.object({
  enabled: z.union([z.boolean(), z.literal('auto')]).optional(),
  /** loopback port of tools that expose a local HTTP API (Ninox, OpenCode) */
  port: z.number().int().min(1024).max(65535).optional(),
  host: z.enum(['127.0.0.1', '::1']).optional(),
}).strict();

export const AdaptersConfigSchema = z.object({
  'claude-code': Setting, codex: Setting, herdr: Setting, ninox: Setting, opencode: Setting, 'gemini-cli': Setting,
}).partial().strict();
export type AdaptersConfig = z.infer<typeof AdaptersConfigSchema>;

export const ADAPTER_IDS = AdapterId.options;

const DEFAULT_ENABLED: Record<AdapterId, boolean | 'auto'> = {
  'claude-code': true, codex: true, herdr: 'auto', ninox: 'auto', opencode: 'auto', 'gemini-cli': 'auto',
};

export function settingsFor(cfg: AdaptersConfig | undefined, id: AdapterId): AdapterSettings {
  const s = cfg?.[id];
  return { enabled: s?.enabled ?? DEFAULT_ENABLED[id], port: s?.port, host: s?.host };
}

export function makeDetectEnv(host: Host, settings: AdapterSettings, projects: ProjectRef[]): DetectEnv {
  const w = host.platform === 'win32';
  return {
    host, settings, projects,
    exists: (p) => { try { return existsSync(p); } catch { return false; } },
    hasCommand: (cmd) => {
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(cmd)) return false;
      const dirs = (host.env.PATH ?? host.env.Path ?? '').split(w ? ';' : delimiter).filter(Boolean);
      const exts = w ? (host.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean).map((e) => e.toLowerCase()).concat(['']) : [''];
      const j = w ? win32.join : posix.join;
      return dirs.some((d) => exts.some((e) => { try { return existsSync(j(d, cmd + e)); } catch { return false; } }));
    },
    probe: (allow, port, path, hostName) => probeLoopback(allow, port, path, hostName),
    fs: (roots) => makeScopedFs(roots),
  };
}

/**
 * Sets `adapters.<id>.enabled` in the config file. Read-modify-write of the raw JSON (every other key is preserved),
 * validated against the adapters schema first, written atomically with the same file mode as before (0600).
 */
export function setAdapterEnabled(configFile: string, id: AdapterId, enabled: boolean | 'auto'): void {
  if (!ADAPTER_IDS.includes(id)) throw new Error(`unknown adapter "${id}" (known: ${ADAPTER_IDS.join(', ')})`);
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>; } catch { throw new Error('could not read the config file'); }
  const adapters = AdaptersConfigSchema.parse((raw.adapters as unknown) ?? {});
  adapters[id] = { ...(adapters[id] ?? {}), enabled };
  raw.adapters = adapters;
  const tmp = `${configFile}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, configFile);
}

