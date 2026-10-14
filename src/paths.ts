/**
 * OS-appropriate locations for the ship agent. Everything takes `platform`/`env`/`home` so tests can
 * exercise the Windows layout from Linux (we cannot run Windows in CI here).
 */
import { join, posix, win32 } from 'node:path';
import { homedir, platform as osPlatform } from 'node:os';

export interface Host { platform: NodeJS.Platform; env: Record<string, string | undefined>; home: string }

export function currentHost(): Host { return { platform: osPlatform(), env: process.env, home: homedir() }; }

const p = (h: Host) => (h.platform === 'win32' ? win32 : posix);

/** %APPDATA%\Botwarren (Windows) or ~/.config/botwarren-ship (elsewhere; XDG respected). */
export function configDir(h: Host = currentHost()): string {
  if (h.platform === 'win32') return win32.join(h.env.APPDATA ?? win32.join(h.home, 'AppData', 'Roaming'), 'Botwarren');
  return posix.join(h.env.XDG_CONFIG_HOME || posix.join(h.home, '.config'), 'botwarren-ship');
}
export function configPath(h: Host = currentHost()): string { return p(h).join(configDir(h), 'config.json'); }
export function defaultSecretFile(h: Host = currentHost()): string {
  return p(h).join(configDir(h), 'ship.secret');
}

/** %LOCALAPPDATA%\Botwarren\data (Windows) or ~/.local/share/botwarren-ship (elsewhere). */
export function defaultDataDir(h: Host = currentHost()): string {
  if (h.platform === 'win32') return win32.join(h.env.LOCALAPPDATA ?? win32.join(h.home, 'AppData', 'Local'), 'Botwarren', 'data');
  return posix.join(h.env.XDG_DATA_HOME || posix.join(h.home, '.local', 'share'), 'botwarren-ship');
}

/** Claude Code keeps session logs under <home>/.claude/projects on every OS (%USERPROFILE% on Windows). */
export function defaultHarnessDirs(h: Host = currentHost()): string[] {
  const home = h.platform === 'win32' ? (h.env.USERPROFILE ?? h.home) : h.home;
  return [p(h).join(home, '.claude', 'projects')];
}

/** Codex CLI keeps rollout logs under <home>/.codex/sessions/YYYY/MM/DD/ on every OS. */
export function defaultCodexDirs(h: Host = currentHost()): string[] {
  const home = h.platform === 'win32' ? (h.env.USERPROFILE ?? h.home) : h.home;
  return [p(h).join(home, '.codex', 'sessions')];
}

export const dataPaths = (dataDir: string) => ({
  privateDb: join(dataDir, 'private', 'private.db'),
  publicDb: join(dataDir, 'public', 'public.db'),
  ingestToken: join(dataDir, 'private', 'ingest.token'),
  opsToken: join(dataDir, 'private', 'ops.token'),
  logFile: join(dataDir, 'logs', 'agent.log'),
});
