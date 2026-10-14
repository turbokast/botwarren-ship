/**
 * Owner-approved (2026-10-13) METADATA-ONLY readers. Everything private is reduced to enums
 * locally and the source text is discarded immediately; it is never stored or sent.
 *  - classifyTitle: private task title → coarse WorkCategory
 *  - ClaudeLogTail: new lines of a Claude Code session log → tool_error activity events
 *    (reads only block types, tool names, is_error flags and timestamps)
 */
import { openSync, readSync, closeSync, fstatSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { CanonicalEventInput, ContextFill, StepCategory, ToolCategory, WorkCategory } from '../vendor/core/contract.ts';
import { ContextTracker, fillFor, usedTokens } from './contextfill.ts';

const RULES: [WorkCategory, RegExp][] = [
  ['bugfix', /\b(fix(es|ed|ing)?|bugs?|broken|fail(s|ed|ing|ures?)?|errors?|crash(es|ing)?|regress(ion)?|red|debug(ging)?|hotfix|incident|repair|flaky|outage|triage)\b/i],
  ['ops', /\b(deploy(s|ing|ment)?|release(s)?|ci|pipelines?|infra(structure)?|migrat(e|ion)|ops|monitor(ing)?|backup|quota|compliance|prune|cleanup)\b/i],
  ['docs', /\b(docs?|documentation|readme|specs?|plan(ning)?|research|review|audit|guide|handoff)\b/i],
  ['feature', /\b(add|build|implement|feature|new|redesign|launch|create|integration|support|epic|programme|program|layers?|collector|continuation|resume|execution)\b/i],
];

export function classifyTitle(title: string | null | undefined): WorkCategory {
  if (!title) return 'unknown';
  const t = title.slice(0, 200);
  for (const [cat, re] of RULES) if (re.test(t)) return cat;
  return 'unknown';
}

export function toolCategory(name: string | undefined): ToolCategory {
  switch (name) {
    case 'Bash': case 'BashOutput': case 'KillShell': return 'shell';
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return 'edit';
    case 'Read': case 'Grep': case 'Glob': case 'LS': return 'read';
    case 'WebFetch': case 'WebSearch': return 'web';
    case 'Task': case 'Agent': case 'SendMessage': return 'agent';
    default: return 'other';
  }
}

export function stepFor(blockType: string, toolName?: string): StepCategory | null {
  if (blockType === 'thinking' || blockType === 'redacted_thinking') return 'thinking';
  if (blockType !== 'tool_use') return null;
  switch (toolCategory(toolName)) {
    case 'read': return 'reading';
    case 'edit': return 'editing';
    case 'shell': return 'running';
    case 'web': return 'researching';
    case 'agent': return 'delegating';
    default: return 'other';
  }
}

const STEP_MIN_GAP_MS = 10_000;

interface Tail { path: string; offset: number; partial: string; toolNames: Map<string, string>; lastStep: StepCategory | null; lastStepAt: number; ctx: ContextTracker }

const CTX_SCAN_BYTES = 512 * 1024;

/**
 * Newest numeric usage in the tail of a log (bounded read): tokens of the latest assistant message, the model family string,
 * and whether any message in the window exceeded the standard context window. Numbers and the model string only.
 */
export function readTailUsage(path: string): { used: number; model: string | undefined; sawLong: boolean } | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, CTX_SCAN_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size - len > 0) lines.shift();
    let latest: { used: number; model: string | undefined } | null = null, sawLong = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"usage"')) continue;
      let d: { message?: { usage?: unknown; model?: unknown } };
      try { d = JSON.parse(line); } catch { continue; }
      const used = usedTokens(d.message?.usage);
      if (used === null) continue;
      if (used > 200_000) sawLong = true;
      if (!latest) latest = { used, model: typeof d.message?.model === 'string' ? d.message.model : undefined };
    }
    return latest ? { ...latest, sawLong } : null;
  } catch { return null; } finally { closeSync(fd); }
}

/** Incremental, bounded tail of Claude Code session logs. Starts at EOF (never replays history). */
export class ClaudeLogTail {
  private tails = new Map<string, Tail>();
  private pathCache = new Map<string, string | null>();
  readonly root: string;
  constructor(root = join(homedir(), '.claude', 'projects')) { this.root = root; }

  /** Locate <root>/<any>/<sessionId>.jsonl (session ids are UUIDs; validated to avoid path tricks). */
  locate(sessionId: string): string | null {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
    if (this.pathCache.has(sessionId)) return this.pathCache.get(sessionId)!;
    let found: string | null = null;
    try {
      for (const d of readdirSync(this.root)) {
        const p = join(this.root, d, `${sessionId}.jsonl`);
        if (existsSync(p)) { found = p; break; }
      }
    } catch { found = null; }
    this.pathCache.set(sessionId, found);
    return found;
  }

  /** Path of a session's log file, or null if not (yet) found. Misses are not cached (the file may appear later). */
  pathOf(sessionId: string): string | null {
    const p = this.locate(sessionId);
    if (p === null) this.pathCache.delete(sessionId);
    return p;
  }

  /** Returns metadata-only activity events appended since the previous call. */
  poll(sessionKey: string, sessionId: string, instance: string, now: Date): CanonicalEventInput[] {
    const path = this.locate(sessionId);
    if (!path) return [];
    return this.pollPath(sessionKey, path, instance, now);
  }

  /**
   * Same as `poll`, for a caller that already knows the exact log file (e.g. the ship agent's
   * log-based session adapter, which has no Herdr session id). Starts at EOF on first sight.
   */
  pollPath(sessionKey: string, path: string, instance: string, now: Date): CanonicalEventInput[] {
    let t = this.tails.get(sessionKey);
    let size: number;
    try { size = statSync(path).size; } catch { return []; }
    if (!t) {
      t = { path, offset: size, partial: '', toolNames: new Map(), lastStep: null, lastStepAt: 0, ctx: new ContextTracker() };
      this.tails.set(sessionKey, t);
      // first sight: the newest usage already in the log gives the starting context fill (numbers only)
      const u = readTailUsage(path);
      if (u?.sawLong) t.ctx.markLong();
      const f = u ? t.ctx.usage(u.used, u.model, now.getTime()) : null;
      return f ? [this.contextEvent(sessionKey, instance, f, false, now.toISOString(), now)] : [];
    }
    if (size < t.offset) { t.offset = size; t.partial = ''; return []; } // rotated/truncated
    if (size === t.offset) return [];
    const len = Math.min(size - t.offset, 4 * 1024 * 1024); // bounded read per poll
    const buf = Buffer.alloc(len);
    const fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, len, t.offset); } finally { closeSync(fd); }
    t.offset += len;
    const text = t.partial + buf.toString('utf8');
    const lines = text.split('\n');
    t.partial = (lines.pop() ?? '').slice(-1_000_000);
    const out: CanonicalEventInput[] = [];
    for (const line of lines) {
      if (!line.includes('tool_') && !line.includes('thinking') && !line.includes('"usage"') && !line.includes('compact_boundary')) continue; // cheap prefilter
      let d: { timestamp?: unknown; type?: unknown; subtype?: unknown; compactMetadata?: { postTokens?: unknown }; message?: { content?: unknown; usage?: unknown; model?: unknown } };
      try { d = JSON.parse(line); } catch { continue; }
      const lineAt = typeof d.timestamp === 'string' && !Number.isNaN(Date.parse(d.timestamp)) ? new Date(d.timestamp).toISOString() : now.toISOString();
      // context compaction: Claude Code writes a system line with subtype compact_boundary (top-level fields only; content ignored)
      if (d.type === 'system' && d.subtype === 'compact_boundary') {
        const post = usedTokens({ input_tokens: d.compactMetadata?.postTokens });
        const f = post !== null ? fillFor(post, 'claude-opus', false) : 'low';
        t.ctx.compacted();
        out.push(this.contextEvent(sessionKey, instance, f === 'unknown' ? 'low' : f, true, lineAt, now));
        t.ctx.usage(post, 'claude-opus', Date.parse(lineAt)); // keep the tracker in step (bucket after compaction)
        continue;
      }
      // context fill: numeric token counts of the newest assistant message, bucketed locally
      if (d.message && typeof d.message === 'object' && 'usage' in d.message) {
        const f = t.ctx.usage(usedTokens(d.message.usage), typeof d.message.model === 'string' ? d.message.model : undefined, Date.parse(lineAt));
        if (f) out.push(this.contextEvent(sessionKey, instance, f, false, lineAt, now));
      }
      const content = d.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content as Record<string, unknown>[]) {
        // step: block TYPE and tool NAME only — the block's text/input is never read
        const step = stepFor(String(b?.type ?? ''), typeof b?.name === 'string' ? b.name : undefined);
        if (step) {
          const ts = typeof d.timestamp === 'string' && !Number.isNaN(Date.parse(d.timestamp)) ? Date.parse(d.timestamp) : now.getTime();
          if (step !== t.lastStep && ts - t.lastStepAt >= STEP_MIN_GAP_MS) {
            t.lastStep = step; t.lastStepAt = ts;
            const at = new Date(ts).toISOString();
            out.push({
              schemaVersion: 1, eventId: `stp-${createHash('sha256').update(`${sessionKey}\0${step}\0${at}`).digest('hex').slice(0, 32)}`,
              source: 'herdr', sourceInstance: instance, sourceEventId: `step:${at}`, occurredAt: at, observedAt: now.toISOString(),
              type: 'session.activity', sessionKey, kind: 'step', toolCategory: 'other', step,
            });
          }
        }
        if (b?.type === 'tool_use' && typeof b.id === 'string') {
          t.toolNames.set(b.id, typeof b.name === 'string' ? b.name : 'other');
          if (t.toolNames.size > 500) t.toolNames.delete(t.toolNames.keys().next().value!);
        }
        if (b?.type === 'tool_result' && b.is_error === true) {
          const at = typeof d.timestamp === 'string' && !Number.isNaN(Date.parse(d.timestamp)) ? new Date(d.timestamp).toISOString() : now.toISOString();
          const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
          out.push({
            schemaVersion: 1, eventId: `act-${createHash('sha256').update(`${sessionKey}\0${toolUseId}\0${at}`).digest('hex').slice(0, 32)}`,
            source: 'herdr', sourceInstance: instance, sourceEventId: `act:${toolUseId.slice(0, 64)}`, occurredAt: at, observedAt: now.toISOString(),
            type: 'session.activity', sessionKey, kind: 'tool_error', toolCategory: toolCategory(t.toolNames.get(toolUseId)),
          });
        }
      }
    }
    return out;
  }

  private contextEvent(sessionKey: string, instance: string, context: ContextFill, compacted: boolean, at: string, now: Date): CanonicalEventInput {
    return {
      schemaVersion: 1, eventId: `ctx-${createHash('sha256').update(`${sessionKey}\0${context}\0${compacted}\0${at}`).digest('hex').slice(0, 32)}`,
      source: 'herdr', sourceInstance: instance, sourceEventId: `ctx:${at}`, occurredAt: at, observedAt: now.toISOString(),
      type: 'session.activity', sessionKey, kind: 'context', toolCategory: 'other', context, ...(compacted ? { compacted: true } : {}),
    };
  }

  forget(sessionKey: string): void { this.tails.delete(sessionKey); }
}
