#!/usr/bin/env node
/** `botwarren` CLI: run (build wrapper), status, ops, pause, resume, login. Talks only to the local ship agent. */
import { readFileSync, existsSync } from 'node:fs';
import { loadConfig, type ShipConfig } from './config.ts';
import { dataPaths } from './paths.ts';
import { ProjectAttributor } from './attribution.ts';
import { makePoster, runWrapped } from './runner.ts';
import { hostname } from 'node:os';
import { sha } from './events.ts';
import { runLogin } from './login.ts';
import { runAdapters } from './adapters/cli.ts';
import { runUpdate, runVerifyRelease } from './update/cli.ts';
import { VERSION } from './version.ts';

const USAGE = `botwarren - Botwarren ship agent CLI

  botwarren run [--release] [--project <id>] -- <command...>   run a build/test/release script and report it
  botwarren status                                             is the ship agent running? what is it publishing?
  botwarren ops [--show-token]                                 where your private local ops room is
  botwarren pause | resume                                     emergency stop / resume of public publishing
  botwarren login [--no-open]                                  sign in to botwarren.com as owner of your ship (e.g. to make it private)
  botwarren adapters [explain|enable|disable <id>]             which tools Botwarren can see, and what each reads
  botwarren update [status|--dry-run|--version X]              check for / apply a signed update (automatic by default)
  botwarren --version                                          show the ship agent version
`;

const token = (path: string): string | null => { try { return readFileSync(path, 'utf8').trim() || null; } catch { return null; } };

async function api(cfg: ShipConfig, method: 'GET' | 'POST', route: string, body?: unknown): Promise<unknown> {
  const t = token(dataPaths(cfg.dataDir).opsToken);
  if (!t) throw new Error('ops token not found - has the ship agent ever started?');
  const res = await fetch(`http://127.0.0.1:${cfg.opsPort}/ops/api/${route}`, {
    method, headers: { authorization: `Bearer ${t}`, 'x-botwarren-ops': '1', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`agent answered HTTP ${res.status}`);
  return res.json();
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { process.stdout.write(USAGE); return 0; }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') { process.stdout.write(`botwarren ship agent ${VERSION}\n`); return 0; }
  // these work before the ship is configured (installers call them first)
  if (cmd === 'verify-release') return runVerifyRelease(rest);
  if (cmd === 'update') return runUpdate(rest);
  const cfg = loadConfig();
  switch (cmd) {
    case 'run': {
      const sep = rest.indexOf('--');
      const flags = sep >= 0 ? rest.slice(0, sep) : [];
      const command = sep >= 0 ? rest.slice(sep + 1) : [];
      if (command.length === 0) { process.stderr.write('usage: botwarren run [--release] [--project <id>] -- <command...>\n'); return 2; }
      let project: string | null = null;
      let release = false;
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === '--release') release = true;
        else if (flags[i] === '--project') project = flags[++i] ?? null;
        else { process.stderr.write(`unknown option ${flags[i]}\n`); return 2; }
      }
      if (project && !cfg.projects.some((p) => p.id === project)) { process.stderr.write(`unknown project "${project}" (configured: ${cfg.projects.map((p) => p.id).join(', ')})\n`); return 2; }
      project ??= (await new ProjectAttributor(cfg.projects).attribute(process.cwd())).projectId;
      project ??= cfg.projects.length === 1 ? cfg.projects[0]!.id : null;
      const instance = sha(hostname()).slice(0, 12);
      const t = token(dataPaths(cfg.dataDir).ingestToken);
      if (!project || !t) {
        process.stderr.write(`[botwarren] ${!project ? 'cannot tell which project this belongs to (use --project <id>)' : 'ingest token missing'} - running without reporting\n`);
        return runWrapped({ argv: command, release, projectId: project ?? cfg.projects[0]!.id, instance, post: async () => true });
      }
      // let the child handle Ctrl-C; we still report its outcome afterwards
      const noop = () => {};
      process.on('SIGINT', noop);
      try { return await runWrapped({ argv: command, release, projectId: project, instance, post: makePoster({ port: cfg.opsPort, token: t }) }); }
      finally { process.off('SIGINT', noop); }
    }
    case 'status': {
      try {
        const s = (await api(cfg, 'GET', 'state')) as { killSwitch: boolean; delaySeconds: number; publicProjects: string[]; sessions: { status: string; projectId: string | null }[]; outbox: unknown[] };
        const live = s.sessions.filter((x) => x.status !== 'ended');
        process.stdout.write(`Ship agent ${VERSION} running. Publishing ${s.killSwitch ? 'PAUSED (emergency stop on)' : 'on'}, delay ${s.delaySeconds}s.\nSessions seen: ${live.length} (published-eligible ${live.filter((x) => x.projectId).length}); waiting to publish: ${s.outbox.length}\n`);
        return 0;
      } catch (e) { process.stderr.write(`Ship agent not reachable on 127.0.0.1:${cfg.opsPort}: ${(e as Error).message}\n`); return 1; }
    }
    case 'ops': {
      process.stdout.write(`Your private ops room (this computer only): http://127.0.0.1:${cfg.opsPort}/ops\n`);
      const p = dataPaths(cfg.dataDir).opsToken;
      if (rest.includes('--show-token') && existsSync(p)) process.stdout.write(`Sign-in token: ${token(p)}\n`);
      else process.stdout.write(`Sign-in token is in the file: ${p}  (or run: botwarren ops --show-token)\n`);
      return 0;
    }
    case 'pause': case 'resume': {
      try {
        await api(cfg, 'POST', 'kill', { on: cmd === 'pause' });
        process.stdout.write(cmd === 'pause' ? 'Publishing paused. Nothing new will leave your machine.\n' : 'Publishing resumed.\n');
        return 0;
      } catch (e) { process.stderr.write(`failed: ${(e as Error).message}\n`); return 1; }
    }
    case 'login': return runLogin(cfg, rest);
    case 'adapters': return runAdapters(cfg, rest);
    default: process.stderr.write(USAGE); return 2;
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((e: Error) => { process.stderr.write(`[botwarren] ${e.message}\n`); return 1; });
