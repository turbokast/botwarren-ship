#!/usr/bin/env node
/** `botwarren` CLI: run (build wrapper), status, ops, pause, resume, login. Talks only to the local ship agent. */
import { readFileSync, existsSync } from 'node:fs';
import { loadConfig, type ShipConfig } from './config.ts';
import { currentHost, dataPaths } from './paths.ts';
import { ProjectAttributor, gitRemote } from './attribution.ts';
import { ProjectDiscovery, discoveryFile } from './discovery.ts';
import { makePoster, runWrapped } from './runner.ts';
import { hostname } from 'node:os';
import { sha } from './events.ts';
import { runLogin } from './login.ts';
import { DISCONNECTED_NOTE, runPair } from './pair.ts';
import { dirname, join } from 'node:path';
import { runConnect } from './connect.ts';
import { runUninstall } from './uninstall.ts';
import { configPath } from './paths.ts';
import { runAdapters } from './adapters/cli.ts';
import { runUpdate, runVerifyRelease } from './update/cli.ts';
import { VERSION } from './version.ts';
import { runCompanion } from './component/cli.ts';

const USAGE = `botwarren - Botwarren ship agent CLI

  botwarren run [--release] [--project <id>] -- <command...>   run a build/test/release script and report it
  botwarren status                                             is the ship agent running? what is it publishing?
  botwarren ops [--show-token]                                 where your private local ops room is
  botwarren pause | resume                                     emergency stop / resume of public publishing
  botwarren connect [--no-open]                                connect this computer to your ship (the command on botwarren.com/get does this for you;
                                                               without one it shows a short code and opens your browser)
  botwarren uninstall [--yes] [--keep-config]                  remove the agent from this computer (and tell botwarren.com)
  botwarren pair [--repo <folder>] [--no-open]                 same as connect without a claim command (older name; --repo adds a project folder by hand)
  botwarren login [--no-open]                                  sign in to botwarren.com as owner of your ship (older installs; not needed with an account)
  botwarren adapters [explain|enable|disable <id>]             which tools Botwarren can see, and what each reads
  botwarren codemap                                            Code map (off unless you turn it on): which area number is which folder, on this computer only
  botwarren update [status|--dry-run|--version X]              check for / apply a signed update (automatic by default)
  botwarren companion [pair|devices|status|log|claude ...|remove|block|unblock]
                                                               the optional Botwarren Companion (remote approvals): pair a phone, see its status,
                                                               remove it, or refuse it (also available as the command botwarren-companion)
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
  const setUp = existsSync(process.env.BOTWARREN_SHIP_CONFIG ?? configPath());
  // first run: nothing is set up yet, so a bare `botwarren` in a terminal starts pairing instead of printing help
  if (!cmd && !setUp && process.stdin.isTTY === true) { process.stdout.write('Welcome! This computer is not connected to a ship yet, so let\u2019s do that now.\n\n'); return runConnect([]); }
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { process.stdout.write(USAGE); return 0; }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') { process.stdout.write(`botwarren ship agent ${VERSION}\n`); return 0; }
  if (cmd === 'pair') return runPair(rest);
  if (cmd === 'connect') return runConnect(rest);
  if (cmd === 'uninstall') return runUninstall(rest);
  // these work before the ship is configured (installers call them first)
  if (cmd === 'verify-release') return runVerifyRelease(rest);
  if (cmd === 'update') return runUpdate(rest);
  if (!setUp && ['run', 'status', 'ops', 'pause', 'resume', 'login', 'codemap'].includes(cmd)) {
    const note = existsSync(join(dirname(process.env.BOTWARREN_SHIP_CONFIG ?? configPath()), DISCONNECTED_NOTE));
    process.stderr.write(note ? 'This computer was disconnected from the website. Connect it again with a new command from https://botwarren.com/get (or run: botwarren connect).\n' : 'This computer is not connected to a ship yet. Get your command at https://botwarren.com/get (or run: botwarren connect).\n');
    return 1;
  }
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
      // hand-configured projects plus the ones noticed from sessions that the owner chose to show on the website
      const known = [...cfg.projects, ...new ProjectDiscovery({ file: discoveryFile(cfg.dataDir), home: currentHost().home, gitRemote }).shown().map((d) => ({ id: d.id, repoPaths: [d.root] }))];
      if (project && !known.some((p) => p.id === project)) { process.stderr.write(`unknown project "${project}" (known: ${known.map((p) => p.id).join(', ')})\n`); return 2; }
      project ??= (await new ProjectAttributor(known).attribute(process.cwd())).projectId;
      project ??= known.length === 1 ? known[0]!.id : null;
      const instance = sha(hostname()).slice(0, 12);
      const t = token(dataPaths(cfg.dataDir).ingestToken);
      if (!project || !t) {
        process.stderr.write(`[botwarren] ${!project ? 'cannot tell which project this belongs to (use --project <id>)' : 'ingest token missing'} - running without reporting\n`);
        return runWrapped({ argv: command, release, projectId: project ?? cfg.projects[0]?.id ?? cfg.shipId, instance, post: async () => true });
      }
      // let the child handle Ctrl-C; we still report its outcome afterwards
      const noop = () => {};
      process.on('SIGINT', noop);
      try { return await runWrapped({ argv: command, release, projectId: project, instance, post: makePoster({ port: cfg.opsPort, token: t }) }); }
      finally { process.off('SIGINT', noop); }
    }
    case 'status': {
      try {
        const s = (await api(cfg, 'GET', 'state')) as { killSwitch: boolean; remotePaused?: boolean; delaySeconds: number; publicProjects: string[]; sessions: { status: string; projectId: string | null }[]; outbox: unknown[]; cloud?: { shipId?: string; site?: string; lastOkAt?: string | null; lastError?: string | null; unauthorized?: number; projectsNoticed?: number; projectsShown?: number; reportedAt?: string | null; tools?: { id: string; state: string }[] } };
        const live = s.sessions.filter((x) => x.status !== 'ended');
        const c = s.cloud;
        const ago = (iso?: string | null) => { if (!iso) return 'never'; const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return sec < 90 ? `${sec}s ago` : `${Math.round(sec / 60)} min ago`; };
        process.stdout.write(`Ship agent ${VERSION} running. Publishing ${s.killSwitch ? (s.remotePaused ? 'PAUSED from the website' : 'PAUSED (emergency stop on)') : 'on'}, delay ${s.delaySeconds}s.\nSessions seen: ${live.length} (published-eligible ${live.filter((x) => x.projectId).length}); waiting to publish: ${s.outbox.length}\n`);
        if (c) {
          const refused = (c.unauthorized ?? 0) > 0;
          process.stdout.write(`Website: ${refused ? 'REFUSING this computer (it was disconnected or replaced; connect again at https://botwarren.com/get)' : c.lastOkAt ? `connected to ship "${c.shipId}", last answered ${ago(c.lastOkAt)}` : `not answered yet${c.lastError ? ` (${c.lastError})` : ''}`}.\n`);
          process.stdout.write(`Projects: ${c.projectsShown ?? 0} shown, ${c.projectsNoticed ?? 0} noticed from your sessions (choose at https://botwarren.com/account).\n`);
          if (c.tools?.length) process.stdout.write(`Tools: ${c.tools.map((t) => `${t.id} ${t.state}`).join(', ')}.\n`);
        }
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
    case 'codemap': {
      try {
        const r = (await api(cfg, 'GET', 'codemap')) as { on: boolean; projects: { project: string; areas: { i: number; kind: string; stale: string; files: number; folders: string[] }[] }[] };
        if (!r.on) {
          process.stdout.write('Code map is OFF (the default). While it is off, the agent never reads a file path.\nTurn it on in your ship settings at https://botwarren.com/account (or set "codeMap": "on" in config.json).\n');
          return 0;
        }
        process.stdout.write('Code map is ON. This list is shown on THIS computer only: only the area number, its kind and how recently it changed ever leave it.\n');
        if (!r.projects.length) process.stdout.write('No project has been mapped yet (it needs a project with git history; the first map takes a minute).\n');
        for (const p of r.projects) {
          process.stdout.write(`\nProject ${p.project}\n`);
          for (const a of p.areas) process.stdout.write(`  Area ${a.i}  ${a.kind.padEnd(8)} ${a.stale.padEnd(8)} ${String(a.files).padStart(5)} files  ${a.folders.slice(0, 4).join(', ')}${a.folders.length > 4 ? ` +${a.folders.length - 4} more` : ''}\n`);
        }
        process.stdout.write('\nName areas (optional) on botwarren.com/account; a name only shows publicly while "Show real project names" is on.\n');
        return 0;
      } catch (e) { process.stderr.write(`Ship agent not reachable on 127.0.0.1:${cfg.opsPort}: ${(e as Error).message}\n`); return 1; }
    }
    case 'login': return runLogin(cfg, rest);
    case 'adapters': return runAdapters(cfg, rest);
    case 'companion': return runCompanion(cfg, rest);
    default: process.stderr.write(USAGE); return 2;
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((e: Error) => { process.stderr.write(`[botwarren] ${e.message}\n`); return 1; });
