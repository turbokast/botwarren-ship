/**
 * `botwarren companion ...`: the LOCAL controls and the everyday commands of the optional Botwarren Companion.
 *
 *   status | remove | block | unblock        the install gate's own (install.ts): look at it, remove it, or refuse it for good
 *   pair | devices | pause | resume | confirm | log | claude ... | version
 *                                            passed through to the installed companion, so `botwarren companion pair` works wherever `botwarren`
 *                                            does (Linux, macOS, Windows) without anything on the PATH. `botwarren-companion <same>` is the same
 *                                            thing through the shim (shim.ts).
 *
 * The component is installed only from the website's consent directive (service.ts). The passthrough runs only the component the gate verified,
 * only these allowlisted subcommands (never `daemon`, `init`, `enroll`, `hook` or `channel`, which the agent and Claude Code run themselves, and
 * never `uninstall`, which would leave the gate's files and consent behind: use `botwarren companion remove`), and never while this computer
 * blocks it.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { clearConsent, componentPaths, entryPath, isLocallyBlocked, readConsent, readCurrent, removeCompanion, setLocalBlock } from './install.ts';
import { ensureShim, removeShim, type ShimEnv } from './shim.ts';
import type { ShipConfig } from '../config.ts';

const out = (s: string): void => { process.stdout.write(s + '\n'); };
const err = (s: string): void => { process.stderr.write(s + '\n'); };

/** the companion subcommands a person types; everything else the companion has is run by the agent or by Claude Code, not by hand */
export const PASSTHROUGH: readonly string[] = ['pair', 'devices', 'pause', 'resume', 'confirm', 'log', 'claude', 'version'];

export function componentRoot(cfg: Pick<ShipConfig, 'dataDir'>, env: Record<string, string | undefined> = process.env): string {
  return env.BOTWARREN_HOME || join(cfg.dataDir, 'home');
}

export interface CompanionCliOptions {
  env?: Record<string, string | undefined>;
  /** tests: where the shim goes (default: the per-user bin directory of the installers) */
  shim?: ShimEnv;
  /** runs the installed companion with the terminal attached; resolves to its exit code. Tests may replace it. */
  exec?: (entry: string, args: string[], env: Record<string, string | undefined>) => Promise<number>;
}

function execAttached(entry: string, args: string[], env: Record<string, string | undefined>): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...args], { stdio: 'inherit', windowsHide: true, env: env as NodeJS.ProcessEnv });
    p.on('error', () => resolve(1));
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

export async function runCompanion(cfg: Pick<ShipConfig, 'dataDir'>, args: string[], o: CompanionCliOptions = {}): Promise<number> {
  const env = o.env ?? process.env;
  const root = componentRoot(cfg, env);
  const sub = args[0];
  const exec = o.exec ?? execAttached;
  switch (sub) {
    case undefined: case 'status': {
      const cur = readCurrent(root); const consent = readConsent(root);
      out('Botwarren Companion (optional, separate from this metadata-only agent)');
      out(`  installed: ${cur ? `yes, version ${cur.version} (signed by ${cur.keyId}, installed ${cur.installedAt})` : 'no'}`);
      out(`  consent recorded: ${consent ? consent.consentAt : 'no'}`);
      out(`  blocked on this computer: ${isLocallyBlocked(root, env) ? 'yes' : 'no'}`);
      if (cur && existsSync(componentPaths(root).notice)) out(`  notice: ${componentPaths(root).notice}`);
      out('  commands: botwarren companion pair | devices | pause | resume | confirm | log | claude ...   (then: remove | block | unblock)');
      if (cur && !isLocallyBlocked(root, env)) { out(''); return exec(entryPath(root, cur.version), ['status'], env as Record<string, string | undefined>); }
      return 0;
    }
    case 'remove': {
      await removeCompanion({ root, log: out });
      removeShim(o.shim ?? { env });
      out('Removed. If your account still offers it, turn it off at https://botwarren.com/account so it is not installed again.');
      return 0;
    }
    case 'block': {
      setLocalBlock(root, true); clearConsent(root);
      await removeCompanion({ root, log: out });
      removeShim(o.shim ?? { env });
      out('Blocked: this computer will never install the companion, whatever the website says. Undo with: botwarren companion unblock');
      return 0;
    }
    case 'unblock': setLocalBlock(root, false); out('Unblocked. The companion installs only if your account asks for it and you agreed on the website.'); return 0;
    case 'help': case '--help': case '-h': usage(process.stdout); return 0;
    default: {
      if (!PASSTHROUGH.includes(sub)) {
        err(sub === 'uninstall' ? 'To remove the companion use: botwarren companion remove (it revokes your devices, removes the Claude Code hooks, deletes the keys and the files).' : `unknown companion command "${sub}"`);
        usage(process.stderr);
        return 2;
      }
      if (isLocallyBlocked(root, env)) { err('The companion is blocked on this computer (botwarren companion unblock, or unset BOTWARREN_DISABLE_COMPONENTS).'); return 1; }
      const cur = readCurrent(root);
      if (!cur) {
        err('The Botwarren Companion is not installed on this computer.');
        err(readConsent(root) ? 'Your account asked for it: your ship agent installs it within a few minutes (botwarren companion status shows the progress).' : 'It is off until you turn it on at https://botwarren.com/account (only accounts the Botwarren team enabled can).');
        return 1;
      }
      ensureShim(o.shim ?? { env }); // repairs the `botwarren-companion` command if it went missing; never overwrites a file this agent did not write
      return exec(entryPath(root, cur.version), args, env as Record<string, string | undefined>);
    }
  }
}

function usage(stream: NodeJS.WriteStream): void {
  stream.write('usage: botwarren companion <command>\n  status | remove | block | unblock       the install on this computer\n  pair | devices | pause | resume | confirm | log | claude ... | version   the companion itself (botwarren-companion does the same)\n');
}
