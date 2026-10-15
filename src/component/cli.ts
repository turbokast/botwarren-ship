/**
 * `botwarren companion status | remove | block | unblock`: the LOCAL controls for the optional Botwarren Companion component.
 * The component is installed only from the website's consent directive (service.ts); these commands let the person on this computer
 * look at it, remove it, or refuse it for good, without the website.
 */
import { clearConsent, componentPaths, isLocallyBlocked, readConsent, readCurrent, removeCompanion, setLocalBlock } from './install.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ShipConfig } from '../config.ts';

const out = (s: string): void => { process.stdout.write(s + '\n'); };

export function componentRoot(cfg: Pick<ShipConfig, 'dataDir'>, env: Record<string, string | undefined> = process.env): string {
  return env.BOTWARREN_HOME || join(cfg.dataDir, 'home');
}

export async function runCompanion(cfg: Pick<ShipConfig, 'dataDir'>, args: string[]): Promise<number> {
  const root = componentRoot(cfg);
  switch (args[0]) {
    case undefined: case 'status': {
      const cur = readCurrent(root); const consent = readConsent(root);
      out('Botwarren Companion (optional, separate from this metadata-only agent)');
      out(`  installed: ${cur ? `yes, version ${cur.version} (signed by ${cur.keyId}, installed ${cur.installedAt})` : 'no'}`);
      out(`  consent recorded: ${consent ? consent.consentAt : 'no'}`);
      out(`  blocked on this computer: ${isLocallyBlocked(root) ? 'yes' : 'no'}`);
      if (cur && existsSync(componentPaths(root).notice)) out(`  notice: ${componentPaths(root).notice}`);
      out('  commands: botwarren companion remove | block | unblock');
      return 0;
    }
    case 'remove': {
      await removeCompanion({ root, log: out });
      out('Removed. If your account still offers it, turn it off at https://botwarren.com/account so it is not installed again.');
      return 0;
    }
    case 'block': {
      setLocalBlock(root, true); clearConsent(root);
      await removeCompanion({ root, log: out });
      out('Blocked: this computer will never install the companion, whatever the website says. Undo with: botwarren companion unblock');
      return 0;
    }
    case 'unblock': setLocalBlock(root, false); out('Unblocked. The companion installs only if your account asks for it and you agreed on the website.'); return 0;
    default: process.stderr.write('usage: botwarren companion [status | remove | block | unblock]\n'); return 2;
  }
}

