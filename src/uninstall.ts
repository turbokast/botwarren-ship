/**
 * `botwarren uninstall [--yes] [--keep-config] [--keep-data]`: remove the agent from this computer, cleanly.
 *
 * First a best-effort goodbye to the website (so the ship shows "uninstalled" instead of "offline" and its secret stops working at once),
 * then the installed uninstall script does the actual removal (service, command, program files, and unless kept: config, secret, data).
 * Works the same from the website's "Disconnect this computer" page: the website shows this one command.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configPath, currentHost, defaultSecretFile, type Host } from './paths.ts';
import { agentReportUrl, buildAgentReport, postAgentReport } from './cloudlink.ts';
import { publishUrl } from './config.ts';
import { VERSION } from './version.ts';

export interface UninstallDeps {
  host?: Host;
  env?: Record<string, string | undefined>;
  out?: (s: string) => void;
  err?: (s: string) => void;
  fetchImpl?: typeof fetch;
  /** runs the platform's uninstall script; resolves with its exit code */
  runScript?: (file: string, args: string[], host: Host) => Promise<number>;
}

const defaultRun = (file: string, args: string[], host: Host): Promise<number> => new Promise((done) => {
  const [cmd, argv] = host.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-File', file, ...args]] : ['sh', [file, ...args]];
  try {
    const child = spawn(cmd as string, argv as string[], { stdio: 'inherit', windowsHide: false });
    child.on('error', () => done(1));
    child.on('exit', (code) => done(code ?? 1));
  } catch { done(1); }
});

export async function runUninstall(argv: string[], deps: UninstallDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => { process.stdout.write(s); });
  const err = deps.err ?? ((s: string) => { process.stderr.write(s); });
  const host = deps.host ?? currentHost();
  const env = deps.env ?? process.env;
  const win = host.platform === 'win32';
  const flags: string[] = [];
  for (const a of argv) {
    if (a === '--yes' || a === '-y') flags.push(win ? '-Yes' : '--yes');
    else if (a === '--keep-config') flags.push(win ? '-KeepConfig' : '--keep-config');
    else if (a === '--keep-data') flags.push(win ? '-KeepData' : '--keep-data');
    else if (a === '--no-cloud') { /* handled below */ }
    else { err(`unknown option ${a}\nusage: botwarren uninstall [--yes] [--keep-config] [--keep-data] [--no-cloud]\n`); return 2; }
  }
  const home = env.BOTWARREN_HOME ?? '';
  const script = home ? join(home, win ? 'uninstall.ps1' : 'uninstall.sh') : '';
  if (!script || !existsSync(script)) {
    err(`The uninstall script was not found${home ? ` in ${home}` : ' (this copy was not installed by the installer)'}. If you installed with Homebrew or Scoop, use \`brew uninstall botwarren\` or \`scoop uninstall botwarren\`.\n`);
    return 1;
  }

  // tell the website this computer is going away (best effort: no config, no network, an older website: all fine)
  if (!argv.includes('--no-cloud')) {
    try {
      const cfgFile = env.BOTWARREN_SHIP_CONFIG ?? configPath(host);
      if (existsSync(cfgFile)) {
        const cfg = JSON.parse(readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')) as { replicaUrl?: string; secretFile?: string };
        const secretFile = cfg.secretFile ?? defaultSecretFile(host);
        if (cfg.replicaUrl && existsSync(secretFile)) {
          const report = { ...buildAgentReport({ host, statuses: [], detections: [], projects: [] }), bye: true };
          const r = await postAgentReport({ url: agentReportUrl(publishUrl(cfg.replicaUrl)), secret: readFileSync(secretFile, 'utf8').trim(), version: VERSION, lane: '00000000', report, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
          out(r === 'ok' ? 'Told botwarren.com this computer is being removed.\n' : 'Could not reach botwarren.com; remove this computer there from your account page if it still shows.\n');
        }
      }
    } catch { /* best effort */ }
  }
  return (deps.runScript ?? defaultRun)(script, flags, host);
}
