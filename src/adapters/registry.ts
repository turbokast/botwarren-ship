/** Builds the adapter list for a config: which adapters exist, their settings, and the `botwarren adapters` report. */
import type { Host } from '../paths.ts';
import { ClaudeCodeAdapter, CodexAdapter } from './claude.ts';
import { HerdrAdapter } from './herdr.ts';
import { NinoxAdapter, ninoxConfigPath, resolveNinoxPort } from './ninox.ts';
import { OPENCODE_DEFAULT_PORT, OpenCodeAdapter } from './opencode.ts';
import { GeminiCliAdapter } from './gemini.ts';
import type { Adapter, AdapterSettings, Detection } from './api.ts';
import { makeDetectEnv, settingsFor, type AdaptersConfig } from './config.ts';
import { makeScopedFs } from './policy.ts';
import type { CodeMapHook } from '../readers/subagents.ts';

export interface AdapterEntry { adapter: Adapter; settings: AdapterSettings }

export interface AdapterConfigInput { harnessLogDirs: string[]; codexLogDirs: string[]; adapters?: AdaptersConfig | undefined }

/** All known adapters with resolved settings (ports filled in). Disabled ones are included; the host skips them. */
export function buildAdapters(cfg: AdapterConfigInput, host: Host, codemap?: CodeMapHook): AdapterEntry[] {
  const claude = new ClaudeCodeAdapter(cfg.harnessLogDirs, codemap);
  const codex = new CodexAdapter(cfg.codexLogDirs, () => claude.mains());
  const ninoxSettings = settingsFor(cfg.adapters, 'ninox');
  const ninoxCfg = ninoxConfigPath(host);
  const ninoxPort = resolveNinoxPort(host, ninoxSettings, (p, n) => makeScopedFs([ninoxCfg]).readHead(p, n));
  const ocSettings = settingsFor(cfg.adapters, 'opencode');
  return [
    { adapter: claude, settings: settingsFor(cfg.adapters, 'claude-code') },
    { adapter: codex, settings: settingsFor(cfg.adapters, 'codex') },
    { adapter: new HerdrAdapter(host), settings: settingsFor(cfg.adapters, 'herdr') },
    { adapter: new NinoxAdapter(host), settings: { ...ninoxSettings, port: ninoxPort } },
    { adapter: new OpenCodeAdapter(), settings: { ...ocSettings, port: ocSettings.port ?? OPENCODE_DEFAULT_PORT } },
    { adapter: new GeminiCliAdapter(host), settings: settingsFor(cfg.adapters, 'gemini-cli') },
  ];
}

export interface AdapterReport {
  id: string; summary: string; enabled: boolean | 'auto'; platformSupported: boolean; detection: Detection;
  verification: string; reads: { kind: string; target: string; keeps: string }[]; active: boolean;
}

/** What `botwarren adapters` prints: runs detection only (read-only probes), never starts a poll. */
export async function reportAdapters(entries: AdapterEntry[], host: Host, projects: { id: string; repoPaths: string[] }[]): Promise<AdapterReport[]> {
  const out: AdapterReport[] = [];
  for (const { adapter, settings } of entries) {
    const m = adapter.manifest;
    const platformSupported = m.platforms.includes(host.platform);
    let detection: Detection;
    try { detection = platformSupported ? await adapter.detect(makeDetectEnv(host, settings, projects)) : { found: false, confidence: 'high', note: `not available on ${host.platform}` }; }
    catch { detection = { found: false, confidence: 'low', note: 'detection failed' }; }
    const active = settings.enabled === true ? platformSupported : settings.enabled === 'auto' ? platformSupported && detection.found : false;
    out.push({ id: m.id, summary: m.summary, enabled: settings.enabled, platformSupported, detection, verification: `${m.upstream.name} ${m.upstream.tested} (${m.upstream.verification})`, reads: m.reads, active });
  }
  return out;
}

export function formatReport(rows: AdapterReport[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    const mark = r.active ? '[on] ' : '[off]';
    const det = !r.platformSupported ? 'not available on this OS' : r.detection.found ? `detected (${r.detection.confidence})` : 'not detected';
    const setting = r.enabled === 'auto' ? 'auto' : r.enabled ? 'enabled' : 'disabled';
    lines.push(`${mark} ${r.id.padEnd(12)} ${det.padEnd(26)} setting: ${setting}${r.detection.note ? `  - ${r.detection.note}` : ''}`);
  }
  lines.push('', 'Details: botwarren adapters explain <id>     Turn one on/off: botwarren adapters enable|disable <id>', 'Adapters only read metadata (ids, states, folders). Nothing a tool prints, prompts or edits is read or sent.');
  return lines.join('\n') + '\n';
}

export function formatExplain(r: AdapterReport): string {
  const l = [`${r.id}: ${r.summary}`, `  status: ${r.active ? 'active' : 'not active'}   setting: ${r.enabled}   verification: ${r.verification}`, '  What this adapter reads:'];
  for (const x of r.reads) l.push(`    - [${x.kind}] ${x.target}`, `        keeps: ${x.keeps}`);
  return l.join('\n') + '\n';
}
