/**
 * launcher.mjs entry point (bundled by scripts/build-release.mjs; no dependencies).
 *
 *   node launcher.mjs run [--foreground]   supervise the agent (service entry point)
 *   node launcher.mjs cli <args...>        run the CLI of the CURRENT version (what the `botwarren` shim calls)
 *   node launcher.mjs uninstall [args]     run the uninstaller that belongs to this install
 *   node launcher.mjs where                print the install root and current version
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, currentHost } from '../paths.ts';
import { paths, readPointer } from '../update/state.ts';
import { acquireLock, startLauncher } from './launcher.ts';

const root = resolve(process.env.BOTWARREN_HOME || join(dirname(fileURLToPath(import.meta.url)), '..'));
const [cmd = 'run', ...rest] = process.argv.slice(2);

function logger(): (m: string) => void {
  const dir = join(root, 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'launcher.log');
  try { if (existsSync(file) && statSync(file).size > 1_000_000) renameSync(file, `${file}.1`); } catch { /* ignore */ }
  return (m) => { try { appendFileSync(file, `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ } };
}

if (cmd === 'where') {
  const p = readPointer(root);
  process.stdout.write(`${root}\n${p ? p.version : 'no version installed'}\n`);
} else if (cmd === 'cli') {
  const p = readPointer(root);
  if (!p) { process.stderr.write('botwarren: no installed version found (run the installer again)\n'); process.exit(3); }
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(paths(root).version(p.version), 'cli.mjs'), ...rest], { stdio: 'inherit', env: { ...process.env, BOTWARREN_HOME: root } });
  process.exit(r.status ?? 1);
} else if (cmd === 'uninstall') {
  const win = process.platform === 'win32';
  const script = join(root, win ? 'uninstall.ps1' : 'uninstall.sh');
  if (!existsSync(script)) { process.stderr.write(`botwarren: ${script} not found\n`); process.exit(3); }
  // the uninstaller removes the directory we run from, so hand over and leave
  const child = win
    ? spawn('powershell.exe', ['-NoProfile', '-File', script, ...rest], { stdio: 'inherit', detached: true })
    : spawn('sh', [script, ...rest], { stdio: 'inherit', detached: true });
  child.on('exit', (c) => process.exit(c ?? 0));
} else if (cmd === 'run') {
  const detached = process.platform === 'win32' && !rest.includes('--child') && !rest.includes('--foreground');
  if (detached) {
    // Task Scheduler runs node.exe in a console window. Hand over to a hidden child and exit at once (a brief flash).
    // UNVERIFIED on real Windows (spike S1); the repeating trigger restarts a dead launcher, the lock keeps it single.
    const probe = acquireLock(root);
    if (!probe) process.exit(0);
    probe();
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', '--child'], { detached: true, windowsHide: true, stdio: 'ignore', env: process.env });
    c.unref();
    process.exit(0);
  }
  const release = acquireLock(root);
  if (!release) process.exit(0); // another launcher is running
  const log = logger();
  const handle = startLauncher({ root, nodePath: process.execPath, configFile: process.env.BOTWARREN_SHIP_CONFIG ?? configPath(currentHost()), log });
  const code = await handle.done;
  release();
  process.exit(code);
} else {
  process.stderr.write('usage: launcher.mjs run | cli <args> | uninstall [args] | where\n');
  process.exit(2);
}
