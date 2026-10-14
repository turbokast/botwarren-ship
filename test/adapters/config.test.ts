import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdaptersConfigSchema, setAdapterEnabled, settingsFor } from '../../src/adapters/config.ts';
import { runAdapters } from '../../src/adapters/cli.ts';
import { resolveConfig } from '../../src/config.ts';
import { linuxHost, mkTmp, rmTmp } from './kit.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });
const base = { shipId: 'demo1', replicaUrl: 'https://demo1.botwarren.com', projects: [{ id: 'demo1', repoPaths: ['/work/game'] }] };

describe('adapter settings in config.json', () => {
  it('defaults: Claude and Codex on, the rest auto; explicit settings win; unknown adapters/keys are rejected', () => {
    expect(settingsFor(undefined, 'claude-code').enabled).toBe(true);
    expect(settingsFor(undefined, 'codex').enabled).toBe(true);
    for (const id of ['herdr', 'ninox', 'opencode', 'gemini-cli'] as const) expect(settingsFor(undefined, id).enabled).toBe('auto');
    expect(settingsFor({ ninox: { enabled: false, port: 9000 } }, 'ninox')).toMatchObject({ enabled: false, port: 9000 });
    expect(() => AdaptersConfigSchema.parse({ cursor: { enabled: true } })).toThrow();
    expect(() => AdaptersConfigSchema.parse({ ninox: { enabled: true, token: 'x' } })).toThrow();
    expect(() => AdaptersConfigSchema.parse({ ninox: { host: '0.0.0.0' } })).toThrow(); // loopback only
    const cfg = resolveConfig({ ...base, adapters: { herdr: { enabled: false } } }, linuxHost('/h'));
    expect(cfg.adapters).toEqual({ herdr: { enabled: false } });
    expect(resolveConfig(base, linuxHost('/h')).adapters).toBeUndefined();
  });

  it('setAdapterEnabled edits only the adapters key, atomically, keeping mode 0600 and every other key', () => {
    const d = mkTmp(); cleanup.push(() => rmTmp(d));
    const f = join(d, 'config.json');
    writeFileSync(f, JSON.stringify({ ...base, delaySeconds: 60 }), { mode: 0o600 });
    setAdapterEnabled(f, 'ninox', true);
    setAdapterEnabled(f, 'ninox', false);
    setAdapterEnabled(f, 'gemini-cli', 'auto');
    const j = JSON.parse(readFileSync(f, 'utf8'));
    expect(j.delaySeconds).toBe(60);
    expect(j.adapters).toEqual({ ninox: { enabled: false }, 'gemini-cli': { enabled: 'auto' } });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(() => setAdapterEnabled(f, 'cursor' as never, true)).toThrow(/unknown adapter/);
    expect(() => resolveConfig(j, linuxHost('/h'))).not.toThrow();
  });
});

describe('botwarren adapters', () => {
  it('lists, explains (what each adapter reads), and enable/disable writes the config', async () => {
    const d = mkTmp(); cleanup.push(() => rmTmp(d));
    const home = join(d, 'home');
    const f = join(d, 'config.json');
    writeFileSync(f, JSON.stringify(base));
    const host = linuxHost(home);
    const cfg = resolveConfig(base, host);
    let out = ''; let err = '';
    const io = { host, configFile: f, out: (s: string) => { out += s; }, err: (s: string) => { err += s; } };
    expect(await runAdapters(cfg, [], io)).toBe(0);
    for (const id of ['claude-code', 'codex', 'herdr', 'ninox', 'opencode', 'gemini-cli']) expect(out).toContain(id);
    expect(out).toContain('not detected');
    out = '';
    expect(await runAdapters(cfg, ['explain', 'ninox'], io)).toBe(0);
    expect(out).toContain('GET /api/v1/sessions');
    expect(out).toContain('keeps:');
    expect(await runAdapters(cfg, ['disable', 'herdr'], io)).toBe(0);
    expect(JSON.parse(readFileSync(f, 'utf8')).adapters.herdr.enabled).toBe(false);
    expect(await runAdapters(cfg, ['enable', 'nope'], io)).toBe(2);
    expect(err).toContain('unknown adapter');
  });
});
