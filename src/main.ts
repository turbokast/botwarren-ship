/** Ship agent entry point: `node src/main.ts` (or the bundled agent.mjs). */
import { loadConfig } from './config.ts';
import { makeLogger, startAgent } from './agent.ts';
import { dataPaths } from './paths.ts';
import { EXIT_RESTART_FOR_UPDATE } from './update/state.ts';

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
