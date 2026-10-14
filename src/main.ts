/** Ship agent entry point: `node src/main.ts` (or the bundled agent.mjs). */
import { loadConfig } from './config.ts';
import { makeLogger, startAgent } from './agent.ts';
import { dataPaths, configPath } from './paths.ts';
import { existsSync } from 'node:fs';
import { EXIT_RESTART_FOR_UPDATE } from './update/state.ts';

// First run: the service may be started before this computer is paired. Wait (idle, no network) until `botwarren pair`
// writes the config and the secret, then start for real; no restart needed.
const cfgFile = process.env.BOTWARREN_SHIP_CONFIG ?? configPath();
if (!existsSync(cfgFile)) {
  process.stdout.write(`${new Date().toISOString()} not paired yet: waiting for \`botwarren pair\` (config ${cfgFile})\n`);
  while (!existsSync(cfgFile)) await new Promise((r) => setTimeout(r, 5000));
  await new Promise((r) => setTimeout(r, 1500)); // let the secret file land
}
const cfg = loadConfig();
const log = makeLogger(dataPaths(cfg.dataDir).logFile);
try {
  let shutdownRef: (sig: string, code?: number) => void = () => {};
  const agent = await startAgent(cfg, { log, onRestartForUpdate: () => shutdownRef('update', EXIT_RESTART_FOR_UPDATE) });
  let stopping = false;
  const shutdown = (sig: string, exitCode = 0) => {
    if (stopping) return; stopping = true;
    log(sig === 'update' ? 'restarting into the updated version' : `${sig} received, shutting down`);
    // one last replication attempt so a just-published event is not stranded
    void Promise.race([agent.replicator.tick(), new Promise((r) => setTimeout(r, 3000))])
      .finally(() => agent.stop().finally(() => process.exit(exitCode)));
  };
  shutdownRef = shutdown;
  for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(s, () => shutdown(s));
} catch (e) {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
}
