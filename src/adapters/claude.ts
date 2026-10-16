/**
 * Claude Code + Codex adapters: the existing, tested log readers (SessionScanner, CodexScanner) ported onto the
 * adapter API. The readers keep their bounded, metadata-only behaviour (file names, mtimes, top-level cwd / ids /
 * model family / numeric usage); this module only converts their output into Observations.
 */
import type { CanonicalEventInput } from '../vendor/core/contract.ts';
import { SessionScanner, type MainInfo } from '../sessionscan.ts';
import type { CodeMapHook } from '../readers/subagents.ts';
import { CodexScanner } from '../codex.ts';
import type { Adapter, AdapterContext, AdapterManifest, DetectEnv, Detection, Observation } from './api.ts';
import { ADAPTER_API_VERSION } from './api.ts';

const str = (v: unknown, max = 1024): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

/** Canonical events from the legacy readers -> Observations (the reverse of what the host builds). */
export function eventsToObservations(events: CanonicalEventInput[], tool: 'claude-code' | 'codex'): Observation[] {
  const out: Observation[] = [];
  for (const e of events) {
    if (e.type === 'session.observed') {
      const priv = (e.private ?? {}) as Record<string, unknown>;
      const m = /^(claude|codex):([0-9A-Za-z-]{8,64})$/.exec(e.sessionKey);
      const cwd = str(priv.cwd); const log = str(priv.log, 160);
      const launch = tool === 'codex' ? (/exec/i.test(String(priv.originator ?? '')) || /exec/i.test(String(priv.source ?? '')) ? 'exec' : 'interactive') : undefined;
      out.push({
        kind: 'session', key: e.sessionKey, tool, harness: tool === 'codex' ? 'codex' : 'claude', status: e.status, role: e.role ?? 'main',
        ...(e.parentKey ? { parentKey: e.parentKey } : {}), ...(e.maker ? { maker: e.maker } : {}), ...(e.model ? { model: e.model } : {}), ...(e.effort ? { effort: e.effort } : {}),
        projectId: e.projectId, certainty: 'inferred',
        correlate: m ? [{ type: m[1] === 'claude' ? 'claude-session' : 'codex-session', id: m[2]! }] : [],
        local: { ...(cwd ? { cwd } : {}), ...(log ? { log } : {}), ...(launch ? { launch } : {}) },
      });
    } else if (e.type === 'session.ended') {
      out.push({ kind: 'session.ended', key: e.sessionKey, reason: e.reason });
    } else if (e.type === 'session.activity') {
      out.push({
        kind: 'activity', key: e.sessionKey, act: e.kind, toolCategory: e.toolCategory, at: e.occurredAt,
        ...(e.step ? { step: e.step } : {}), ...(e.context ? { context: e.context } : {}), ...(e.compacted ? { compacted: true } : {}),
        ...(e.kind === 'area' && e.area ? { area: e.area, ...(e.areaAct ? { areaAct: e.areaAct } : {}) } : {}),
      });
    }
  }
  return out;
}

const attributorFor = (ctx: AdapterContext) => ({ attribute: async (cwd: string | null | undefined, now?: number) => ({ projectId: await ctx.attribute(cwd, now ?? Date.now()), method: 'none' as const, via: null }) });

export class ClaudeCodeAdapter implements Adapter {
  readonly manifest: AdapterManifest;
  private scanner: SessionScanner | null = null;
  private readonly dirs: string[];
  private readonly codemap: CodeMapHook | undefined;
  constructor(dirs: string[], codemap?: CodeMapHook) {
    this.dirs = dirs; this.codemap = codemap;
    this.manifest = {
      id: 'claude-code', apiVersion: ADAPTER_API_VERSION, version: '1.0.0', platforms: ['win32', 'darwin', 'linux'],
      reads: [
        { kind: 'dir', target: dirs[0] ?? '~/.claude/projects', keeps: 'session log file names and write times; the project folder (cwd) of the newest lines; tool names, error flags, the model maker and line (the exact model name or version is dropped on this computer), the reasoning effort level and numeric token counts (bucketed). Never message text. Only while you turn on Code map (off by default): the file path of a Read/Edit/Write-style tool call, on this computer, to pick an area number; the path is not kept or sent.' },
      ],
      capabilities: { state: true, toolCategory: true, errors: true, subagents: true, tokens: true, hierarchy: false },
      upstream: { name: 'Claude Code', tested: 'JSONL session logs, 2026-10', verification: 'live' },
      summary: 'Claude Code sessions, sub-agents, tool errors, steps and context fill (from local log metadata).',
    };
  }
  /** live main sessions, for Codex pairing */
  mains(): MainInfo[] { return this.scanner?.mains() ?? []; }
  async detect(env: DetectEnv): Promise<Detection> {
    const dirFound = this.dirs.some((d) => env.exists(d));
    if (dirFound) return { found: true, confidence: 'high' };
    return env.hasCommand('claude') ? { found: true, confidence: 'medium', note: 'claude is installed but has no session logs yet' } : { found: false, confidence: 'high' };
  }
  async poll(ctx: AdapterContext, now: Date): Promise<Observation[]> {
    this.scanner ??= new SessionScanner({ dirs: this.dirs, instance: ctx.instance, attributor: attributorFor(ctx), epoch: ctx.attributionEpoch, ...(this.codemap ? { codemap: this.codemap } : {}) });
    return eventsToObservations(await this.scanner.tick(now), 'claude-code');
  }
}

export class CodexAdapter implements Adapter {
  readonly manifest: AdapterManifest;
  private scanner: CodexScanner | null = null;
  private readonly dirs: string[];
  private readonly mains: () => MainInfo[];
  constructor(dirs: string[], mains: () => MainInfo[]) {
    this.dirs = dirs; this.mains = mains;
    this.manifest = {
      id: 'codex', apiVersion: ADAPTER_API_VERSION, version: '1.0.0', platforms: ['win32', 'darwin', 'linux'],
      reads: [
        { kind: 'dir', target: dirs[0] ?? '~/.codex/sessions', keeps: 'rollout file names and write times; ONLY id, cwd, originator and source of the first line, plus the model (reduced here to maker and line, never the exact name or version) and the reasoning effort level of the newest turn setting line. Never base instructions or messages.' },
      ],
      capabilities: { state: true, toolCategory: false, errors: false, subagents: false, tokens: false, hierarchy: true },
      upstream: { name: 'Codex CLI', tested: 'rollout JSONL, 2026-10', verification: 'live' },
      summary: 'Codex CLI sessions, paired with a Claude session of the same project when both are active.',
    };
  }
  async detect(env: DetectEnv): Promise<Detection> {
    if (this.dirs.length === 0) return { found: false, confidence: 'high', note: 'disabled by empty codexLogDirs' };
    if (this.dirs.some((d) => env.exists(d))) return { found: true, confidence: 'high' };
    return env.hasCommand('codex') ? { found: true, confidence: 'medium', note: 'codex is installed but has no sessions yet' } : { found: false, confidence: 'high' };
  }
  async poll(ctx: AdapterContext, now: Date): Promise<Observation[]> {
    this.scanner ??= new CodexScanner({ dirs: this.dirs, instance: ctx.instance, attributor: attributorFor(ctx), epoch: ctx.attributionEpoch });
    return eventsToObservations(await this.scanner.tick(now, this.mains()), 'codex');
  }
}
