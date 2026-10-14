/**
 * Self-containment: the agent, CLI and launcher bundles must import nothing from outside this repository's `src/` (plus
 * node_modules). The small public contract the agent depends on is vendored under `src/vendor/core/`.
 */
import { build } from 'esbuild';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');

describe('self-containment of the ship agent', () => {
  it('bundles only files under src/ and node_modules; the launcher has no dependencies at all', async () => {
    const meta = async (entry: string) => (await build({ entryPoints: [resolve(ROOT, entry)], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, absWorkingDir: ROOT, logLevel: 'silent', outdir: 'x' })).metafile.inputs;
    const outside = (inputs: Record<string, unknown>) => Object.keys(inputs).filter((f) => !f.startsWith('src/') && !f.includes('node_modules'));
    for (const entry of ['src/main.ts', 'src/cli.ts']) expect(outside(await meta(entry)), entry).toEqual([]);
    expect(Object.keys(await meta('src/launcher/main.ts')).filter((f) => !f.startsWith('src/'))).toEqual([]);
  }, 60_000);

  it('no source, test or script imports a package that is not a declared dependency', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const declared = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]);
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = resolve(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!/\.(ts|mjs)$/.test(e.name)) continue;
        for (const m of readFileSync(p, 'utf8').matchAll(/(?:from|import\()\s*'([^'./][^']*)'/g)) {
          const spec = m[1]!;
          if (spec.startsWith('node:')) continue;
          const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
          if (!declared.has(name)) bad.push(`${p}: ${spec}`);
        }
      }
    };
    for (const d of ['src', 'test', 'scripts']) walk(resolve(ROOT, d));
    expect(bad).toEqual([]);
  });
});
