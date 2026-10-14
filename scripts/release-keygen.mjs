#!/usr/bin/env node
/**
 * Generates an Ed25519 release signing key (PKCS#8 PEM, mode 0600) and prints the PUBLIC half for src/update/keys.ts.
 *
 *   node scripts/release-keygen.mjs [--out ~/.config/botwarren/release-dev.key] [--id dev-1]
 *
 * This is for the DEV key used by tests and rehearsals. The PRODUCTION key is generated inside a cloud KMS (see
 * docs/RELEASING.md) and is never written to a file by this project.
 * Refuses to overwrite an existing file and refuses any path inside the repository: a private key must never be committed.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const out = resolve(opt('--out', join(homedir(), '.config', 'botwarren', 'release-dev.key')));
const id = opt('--id', 'dev-1');

if (out === repoRoot || out.startsWith(repoRoot + sep)) { console.error(`refusing: ${out} is inside the repository. Choose a path outside it.`); process.exit(2); }
if (existsSync(out)) { console.error(`refusing to overwrite ${out}`); process.exit(2); }

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
console.log(`private key written to ${out} (mode 600). Back it up somewhere safe; NEVER commit it.`);
console.log('public key line for apps/shipagent/src/update/keys.ts:');
console.log(`  { id: '${id}', spki: '${spki}', dev: true },`);
