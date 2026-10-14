/** `botwarren adapters [explain <id> | enable <id> | disable <id> | auto <id>]` */
import { configPath, currentHost, type Host } from '../paths.ts';
import type { ShipConfig } from '../config.ts';
import { AdapterId } from './api.ts';
import { setAdapterEnabled } from './config.ts';
import { buildAdapters, formatExplain, formatReport, reportAdapters } from './registry.ts';

export interface AdaptersCliDeps { host?: Host; out?: (s: string) => void; err?: (s: string) => void; configFile?: string }

export async function runAdapters(cfg: ShipConfig, args: string[], deps: AdaptersCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const err = deps.err ?? ((s: string) => process.stderr.write(s));
  const host = deps.host ?? currentHost();
  const configFile = deps.configFile ?? process.env.BOTWARREN_SHIP_CONFIG ?? configPath(host);
  const [sub, id] = args;
  const projects = cfg.projects.map((p) => ({ id: p.id, repoPaths: p.repoPaths }));
  if (!sub || sub === 'list') {
    out(formatReport(await reportAdapters(buildAdapters(cfg, host), host, projects)));
    return 0;
  }
  const parsed = AdapterId.safeParse(id);
  if (!parsed.success) { err(`unknown adapter "${id ?? ''}" (known: ${AdapterId.options.join(', ')})\n`); return 2; }
  if (sub === 'explain') {
    const rows = await reportAdapters(buildAdapters(cfg, host), host, projects);
    out(formatExplain(rows.find((r) => r.id === parsed.data)!));
    return 0;
  }
  if (sub === 'enable' || sub === 'disable' || sub === 'auto') {
    try { setAdapterEnabled(configFile, parsed.data, sub === 'enable' ? true : sub === 'disable' ? false : 'auto'); } catch (e) { err(`${(e as Error).message}\n`); return 1; }
    out(`${parsed.data}: ${sub === 'auto' ? 'auto (on while detected)' : sub === 'enable' ? 'enabled' : 'disabled'}. Restart the ship agent to apply (or wait for the next update/restart).\n`);
    return 0;
  }
  err('usage: botwarren adapters [list | explain <id> | enable <id> | disable <id> | auto <id>]\n');
  return 2;
}
