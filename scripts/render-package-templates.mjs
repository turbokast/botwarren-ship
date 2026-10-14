#!/usr/bin/env node
/**
 * Renders the Homebrew formula and the Scoop manifest from a release manifest (NOT published anywhere).
 *
 *   node scripts/render-package-templates.mjs --manifest dist/release/0.5.0/manifest.json [--out dist/release/0.5.0/packages]
 *        [--base-url https://downloads.botwarren.com/] [--license Apache-2.0]
 *
 * Fills @VERSION@, @URL_<PLATFORM>@ and @SHA_<PLATFORM>@ from the manifest's stable release. The licence defaults to
 * "Apache-2.0"; a rendered file that still contains an unfilled @PLACEHOLDER@ is refused.
 * Check the manifest's signature first (scripts/release-sign.mjs --verify): the hashes written here come from it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Manifest } from '../src/update/manifest.ts';
import { DEFAULT_BASE_URL } from '../src/update/policy.ts';

const here = dirname(fileURLToPath(import.meta.url));

export function renderTemplate(text, vars) {
  const out = text.replace(/@([A-Z0-9_]+)@/g, (m, k) => (k in vars ? vars[k] : m));
  const left = out.match(/@[A-Z0-9_]+@/g);
  if (left) throw new Error(`unfilled placeholders: ${[...new Set(left)].join(', ')}`);
  return out;
}

export function templateVars(manifest, { baseUrl = DEFAULT_BASE_URL, license = 'Apache-2.0' } = {}) {
  const m = Manifest.parse(manifest);
  const v = m.channels.stable;
  const rel = m.releases[v];
  if (!rel) throw new Error(`stable ${v} is not in the manifest`);
  const vars = { VERSION: v, LICENSE: license };
  for (const [p, a] of Object.entries(rel.full)) {
    const key = p.toUpperCase().replace('-', '_');
    vars[`URL_${key}`] = new URL(a.url, baseUrl).toString();
    vars[`SHA_${key}`] = a.sha256;
  }
  return vars;
}

export function renderAll({ manifest, baseUrl, license }) {
  const vars = templateVars(manifest, { baseUrl, license });
  const read = (p) => readFileSync(join(here, '..', 'packaging', p), 'utf8');
  return {
    'botwarren.rb': renderTemplate(read('homebrew/botwarren.rb.tmpl'), vars),
    'botwarren.json': renderTemplate(read('scoop/botwarren.json.tmpl'), vars),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const mf = opt('--manifest');
  if (!mf) { console.error('usage: render-package-templates.mjs --manifest <manifest.json> [--out dir] [--base-url url] [--license id]'); process.exit(2); }
  const out = resolve(opt('--out', join(dirname(resolve(mf)), 'packages')));
  const files = renderAll({ manifest: JSON.parse(readFileSync(mf, 'utf8')), baseUrl: opt('--base-url', DEFAULT_BASE_URL), license: opt('--license', 'Apache-2.0') });
  mkdirSync(out, { recursive: true });
  for (const [n, t] of Object.entries(files)) { writeFileSync(join(out, n), t); console.log(`wrote ${join(out, n)}`); }
}
