/** Zod-validated ship agent configuration (JSON on disk). The ship SECRET never lives in this file. */
import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { ProjectId, defaultProjectName } from './vendor/core/contract.ts';
import { AdaptersConfigSchema, type AdaptersConfig } from './adapters/config.ts';
import { UpdatesConfigSchema, type UpdatesConfig } from './update/policy.ts';
import { configPath, currentHost, defaultCodexDirs, defaultDataDir, defaultHarnessDirs, defaultSecretFile, type Host } from './paths.ts';

const ShipId = z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/);

const ProjectConfig = z.object({
  id: ProjectId,
  /** Safe name shown publicly by default. Default "<SHIP> Project". */
  publicName: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9 '&.-]*$/, "letters, digits, spaces and ' & . - only (must start with a letter or digit)").optional(),
  /** Owner's real project name, published ONLY while "Show real project names" is on. Default: the repo folder name, prettified (see names.ts). */
  realName: z.string().trim().min(1).max(200).optional(),
  /** Local git checkouts. Attribution = session cwd inside one of these, or the same git remote. */
  repoPaths: z.array(z.string().min(1).max(1024)).min(1).max(16),
}).strict();

const ReplicaUrl = z.string().url().refine((u) => {
  const x = new URL(u);
  return x.protocol === 'https:' || (x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname));
}, 'replicaUrl must be https (http only for localhost)');

export const ShipConfigSchema = z.object({
  shipId: ShipId,
  /** Base URL (https://<ship>.botwarren.com) or the full .../internal/publish URL. */
  replicaUrl: ReplicaUrl,
  /** File holding the ship secret (separate, user-only ACL). */
  secretFile: z.string().min(1).optional(),
  delaySeconds: z.number().int().min(30).max(120).default(90),
  /**
   * Written by `botwarren pair`: until this moment (about 15 minutes after pairing) the agent publishes with the 30 s minimum
   * delay so the first crew member shows up fast, then it returns to `delaySeconds`. Absent = never.
   */
  onboardingUntil: z.string().datetime().optional(),
  projects: z.array(ProjectConfig).min(1).max(8),
  harnessLogDirs: z.array(z.string().min(1)).min(1).optional(),
  /** Codex session log roots (default ~/.codex/sessions). Empty list disables Codex pairing. */
  codexLogDirs: z.array(z.string().min(1)).max(4).optional(),
  opsPort: z.number().int().min(1024).max(65535).default(4411),
  demo: z.boolean().default(false),
  /** Where private.db / public.db / tokens / logs live. */
  dataDir: z.string().min(1).optional(),
  /** Per-tool adapter switches: { "ninox": { "enabled": true, "port": 8081 } }. See `botwarren adapters`. */
  adapters: AdaptersConfigSchema.optional(),
  /** Silent updates: { "enabled": false } opts out; see docs/ARCHITECTURE.md */
  updates: UpdatesConfigSchema.optional(),
}).strict().superRefine((c, ctx) => {
  const ids = c.projects.map((p) => p.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate project id', path: ['projects'] });
});

export interface ShipConfig {
  shipId: string;
  replicaUrl: string;
  secretFile: string;
  delaySeconds: number;
  /** epoch ms until which the short onboarding delay applies (null = not onboarding) */
  onboardingUntil: number | null;
  projects: { id: string; publicName: string; realName: string | null; repoPaths: string[] }[];
  harnessLogDirs: string[];
  codexLogDirs: string[];
  opsPort: number;
  demo: boolean;
  dataDir: string;
  adapters?: AdaptersConfig | undefined;
  updates?: UpdatesConfig | undefined;
}

/** "<SHIP> Project", e.g. demo1 -> "DEMO1 Project". */
export const defaultPublicName = defaultProjectName;

export function resolveConfig(raw: unknown, host: Host = currentHost()): ShipConfig {
  const c = ShipConfigSchema.parse(raw);
  return {
    shipId: c.shipId,
    replicaUrl: c.replicaUrl,
    secretFile: c.secretFile ?? defaultSecretFile(host),
    delaySeconds: c.delaySeconds,
    onboardingUntil: c.onboardingUntil ? Date.parse(c.onboardingUntil) : null,
    projects: c.projects.map((p) => ({ id: p.id, publicName: p.publicName ?? defaultPublicName(c.shipId), realName: p.realName ?? null, repoPaths: p.repoPaths })),
    harnessLogDirs: c.harnessLogDirs ?? defaultHarnessDirs(host),
    codexLogDirs: c.codexLogDirs ?? defaultCodexDirs(host),
    opsPort: c.opsPort,
    demo: c.demo,
    dataDir: c.dataDir ?? defaultDataDir(host),
    adapters: c.adapters,
    updates: c.updates,
  };
}

export function loadConfig(path: string = process.env.BOTWARREN_SHIP_CONFIG ?? configPath(), host: Host = currentHost()): ShipConfig {
  if (!existsSync(path)) throw new Error(`Botwarren ship config not found at ${path}. Run \`botwarren pair\` to connect this computer to your ship (see the README).`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); } // PowerShell may write a BOM
  catch (e) { throw new Error(`Config ${path} is not valid JSON: ${(e as Error).message}`, { cause: e }); }
  return resolveConfig(raw, host);
}

/** The publish endpoint: accepts the base URL or the full path. */
export function publishUrl(replicaUrl: string): string {
  const u = new URL(replicaUrl);
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/internal/publish';
  return u.toString();
}
