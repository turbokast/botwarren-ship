/** Ship agent entry point: `node src/main.ts` (or the bundled agent.mjs). */
import { loadConfig } from './config.ts';
import { makeLogger, startAgent, type RunningAgent } from './agent.ts';
import { dataPaths, configPath } from './paths.ts';
import { wipeConnection } from './connect.ts';
import { existsSync } from 'node:fs';
import { EXIT_RESTART_FOR_UPDATE } from './update/state.ts';

// First run: the service may be started before this computer is connected. Wait (idle, no network) until `botwarren connect` (or the
// command from botwarren.com/get) writes the config and the secret, then start for real; no restart needed. The same wait happens again
// after the website disconnects this computer: the agent forgets its secret and idles until it is connected again.
const cfgFile = process.env.BOTWARREN_SHIP_CONFIG ?? configPath();
let stopping = false;
let current: RunningAgent | null = null;
let shutdownRef: (sig: string, code?: number) => void = () => {};
const shutdown = (sig: string, exitCode = 0) => {
  if (stopping) return; stopping = true;
  const agent = current;
  if (!agent) process.exit(exitCode);
  process.stdout.write(`${new Date().toISOString()} ${sig === 'update' ? 'restarting into the updated version' : `${sig} received, shutting down`}\n`);
  // one last replication attempt so a just-published event is not stranded
  void Promise.race([agent!.replicator.tick(), new Promise((r) => setTimeout(r, 3000))])
    .finally(() => agent!.stop().finally(() => process.exit(exitCode)));
};
shutdownRef = shutdown;
for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(s, () => shutdownRef(s));

for (;;) {
  if (!existsSync(cfgFile)) {
    process.stdout.write(`${new Date().toISOString()} not connected yet: waiting for \`botwarren connect\` or the command on botwarren.com/get (config ${cfgFile})\n`);
    while (!existsSync(cfgFile)) await new Promise((r) => setTimeout(r, 5000));
    await new Promise((r) => setTimeout(r, 1500)); // let the secret file land
  }
  const cfg = loadConfig();
  const log = makeLogger(dataPaths(cfg.dataDir).logFile);
  let revoked: (() => void) | null = null;
  const revokedP = new Promise<void>((r) => { revoked = r; });
  try {
    current = await startAgent(cfg, { log, onRestartForUpdate: () => shutdownRef('update', EXIT_RESTART_FOR_UPDATE), onRevoked: () => revoked?.() });
  } catch (e) {
    log(`fatal: ${(e as Error).message}`);
    process.exit(1);
  }
  await revokedP;
  // the website disconnected this computer: stop, forget the secret and the ship, wait to be connected again
  const agent = current;
  current = null;
  await agent.stop().catch(() => undefined);
  wipeConnection(cfgFile, cfg.secretFile, 'revoked by the website');
  log('disconnected from the website: the ship secret was removed from this computer. Connect again with `botwarren connect` or a new command from botwarren.com/get.');
}
