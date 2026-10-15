/**
 * The `botwarren-companion` command next to the `botwarren` command.
 *
 * The companion's own command line is `botwarren-companion`, but the agent installs it as a file under its own data directory, not on the PATH.
 * `botwarren companion pair|devices|...` (cli.ts) passes through to it, and this small shim makes the older spelling `botwarren-companion pair`
 * work too: a two-line launcher in the same per-user bin directory the installers use for `botwarren` (no administrator rights).
 *
 * What the shim can do: run `botwarren companion <the same arguments>`. Nothing else: it names no version, no path to the component and no URL,
 * so it never needs to change when the component is updated, and it adds nothing to what runs (the passthrough runs the component the install
 * gate verified, and only the allowlisted subcommands).
 *
 * Safety rules, each tested: it is only written next to an existing `botwarren` command (a package-manager install has none to sit next to);
 * a file with that name that this agent did not write is never overwritten or removed; it is removed with the component.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export const SHIM_MARKER = 'botwarren-companion shim (ship agent)';

export interface ShimEnv { env?: Record<string, string | undefined>; os?: NodeJS.Platform; home?: string }

/** the per-user bin directory the installers put `botwarren` in (install.sh: ~/.local/bin; install.ps1: %LOCALAPPDATA%\Botwarren\bin) */
export function shimDir(o: ShimEnv = {}): string {
  const env = o.env ?? process.env;
  if (env.BOTWARREN_BIN_DIR) return env.BOTWARREN_BIN_DIR;
  const os = o.os ?? platform();
  const home = o.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  // install.ps1 puts it in <install dir>\bin, and a launcher-managed install runs the agent with BOTWARREN_HOME set to that install dir
  if (os === 'win32') return env.BOTWARREN_HOME ? join(env.BOTWARREN_HOME, 'bin') : join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Botwarren', 'bin');
  return join(home, '.local', 'bin');
}

const isWin = (o: ShimEnv): boolean => (o.os ?? platform()) === 'win32';
const shimFile = (o: ShimEnv): string => join(shimDir(o), isWin(o) ? 'botwarren-companion.cmd' : 'botwarren-companion');
const botwarrenFile = (o: ShimEnv): string => join(shimDir(o), isWin(o) ? 'botwarren.cmd' : 'botwarren');

export const shimText = (win: boolean): string => win
  ? `@echo off\r\nrem ${SHIM_MARKER}: runs "botwarren companion ..."\r\ncall "%~dp0botwarren.cmd" companion %*\r\nexit /b %ERRORLEVEL%\r\n`
  : `#!/usr/bin/env sh\n# ${SHIM_MARKER}: runs "botwarren companion ..."; written and removed by the Botwarren ship agent\nexec "$(dirname "$0")/botwarren" companion "$@"\n`;

export type ShimResult = 'written' | 'present' | 'no_botwarren_command' | 'foreign_file' | 'failed';

export function ensureShim(o: ShimEnv = {}): ShimResult {
  const file = shimFile(o);
  try {
    if (!existsSync(botwarrenFile(o))) return 'no_botwarren_command';
    const want = shimText(isWin(o));
    if (existsSync(file)) {
      const have = readFileSync(file, 'utf8');
      if (!have.includes(SHIM_MARKER)) return 'foreign_file';
      if (have === want) return 'present';
    }
    mkdirSync(shimDir(o), { recursive: true });
    writeFileSync(file, want, { mode: 0o755 });
    if (!isWin(o)) chmodSync(file, 0o755);
    return 'written';
  } catch { return 'failed'; }
}

/** removes the shim only if this agent wrote it */
export function removeShim(o: ShimEnv = {}): boolean {
  const file = shimFile(o);
  try {
    if (!existsSync(file) || !readFileSync(file, 'utf8').includes(SHIM_MARKER)) return false;
    rmSync(file, { force: true });
    return true;
  } catch { return false; }
}
