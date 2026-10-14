import { describe, expect, it } from 'vitest';
import { publishUrl, resolveConfig } from '../src/config.ts';
import { configPath, defaultDataDir, defaultHarnessDirs, defaultSecretFile } from '../src/paths.ts';

const win = { platform: 'win32' as const, home: 'C:\\Users\\DEMO1', env: { APPDATA: 'C:\\Users\\DEMO1\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\DEMO1\\AppData\\Local', USERPROFILE: 'C:\\Users\\DEMO1' } };
const nix = { platform: 'linux' as const, home: '/home/demo1', env: {} };
const base = { shipId: 'demo1', replicaUrl: 'https://demo1.botwarren.com', projects: [{ id: 'demo1', repoPaths: ['C:\\Code\\Game'] }] };

describe('config', () => {
  it('uses the Windows layout', () => {
    expect(configPath(win)).toBe('C:\\Users\\DEMO1\\AppData\\Roaming\\Botwarren\\config.json');
    expect(defaultSecretFile(win)).toBe('C:\\Users\\DEMO1\\AppData\\Roaming\\Botwarren\\ship.secret');
    expect(defaultDataDir(win)).toBe('C:\\Users\\DEMO1\\AppData\\Local\\Botwarren\\data');
    expect(defaultHarnessDirs(win)).toEqual(['C:\\Users\\DEMO1\\.claude\\projects']);
  });
  it('uses the Linux/mac layout', () => {
    expect(configPath(nix)).toBe('/home/demo1/.config/botwarren-ship/config.json');
    expect(defaultHarnessDirs(nix)).toEqual(['/home/demo1/.claude/projects']);
  });
  it('applies defaults, including the "<SHIP> Project" public name', () => {
    const c = resolveConfig(base, win);
    expect(c.delaySeconds).toBe(90);
    expect(c.opsPort).toBe(4411);
    expect(c.demo).toBe(false);
    expect(c.projects[0]!.publicName).toBe('DEMO1 Project');
    expect(c.codexLogDirs).toEqual(['C:\\Users\\DEMO1\\.codex\\sessions']);
    expect(resolveConfig({ ...base, codexLogDirs: [] }, win).codexLogDirs).toEqual([]);
  });
  it('validates ids, delay range, urls and duplicates', () => {
    expect(() => resolveConfig({ ...base, delaySeconds: 10 }, win)).toThrow();
    expect(() => resolveConfig({ ...base, delaySeconds: 500 }, win)).toThrow();
    expect(() => resolveConfig({ ...base, shipId: 'DEMO1' }, win)).toThrow();
    expect(() => resolveConfig({ ...base, replicaUrl: 'http://example.com' }, win)).toThrow();
    expect(() => resolveConfig({ ...base, replicaUrl: 'http://127.0.0.1:4400' }, win)).not.toThrow();
    expect(() => resolveConfig({ ...base, projects: [{ id: 'Bad_Id', repoPaths: ['C:\\x'] }] }, win)).toThrow();
    expect(() => resolveConfig({ ...base, projects: [{ id: 'aa', repoPaths: [] }] }, win)).toThrow();
    expect(() => resolveConfig({ ...base, projects: [base.projects[0], base.projects[0]] }, win)).toThrow();
    expect(() => resolveConfig({ ...base, secret: 'nope' }, win)).toThrow(); // strict: no stray keys (and no inline secret)
  });
  it('builds the publish URL from a base or full URL', () => {
    expect(publishUrl('https://demo1.botwarren.com')).toBe('https://demo1.botwarren.com/internal/publish');
    expect(publishUrl('https://demo1.botwarren.com/internal/publish')).toBe('https://demo1.botwarren.com/internal/publish');
  });
});
