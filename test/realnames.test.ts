import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startAgent } from '../src/agent.ts';
import { resolveConfig } from '../src/config.ts';
import { buildManifest, prettifyFolderName, publishedName, realNameCandidate, wantsRealNames, type NamedProject } from '../src/names.ts';
import { tmp, freePort } from './helpers.ts';

const proj = (over: Partial<NamedProject> = {}): NamedProject => ({ id: 'demo1', publicName: 'DEMO1 Project', realName: null, repoPaths: ['C:\\Users\\DEMO1\\Code\\Dragon-Game'], ...over });

describe('real project names: what counts as the real name', () => {
  it('prettifies the folder name of the first repo path (Windows and POSIX, trailing separators, .git)', () => {
    expect(prettifyFolderName('C:\\Users\\DEMO1\\Code\\Dragon-Game')).toBe('Dragon Game');
    expect(prettifyFolderName('/home/demo1/code/my_cool-game/')).toBe('My Cool Game');
    expect(prettifyFolderName('/srv/git/ship-log.git')).toBe('Ship Log');
    expect(prettifyFolderName('/work/TurboKast')).toBe('TurboKast'); // mixed case is left alone
    expect(prettifyFolderName('/')).toBeNull();
  });
  it('a configured realName wins over the folder name', () => {
    expect(realNameCandidate({ realName: 'Moth Lantern', repoPaths: ['/a/b'] })).toBe('Moth Lantern');
    expect(realNameCandidate({ realName: null, repoPaths: ['/a/blue-fox'] })).toBe('Blue Fox');
  });
  it('config: realName is optional, trimmed and kept; absent = null', () => {
    const base = { shipId: 'demo1', replicaUrl: 'https://demo1.botwarren.com', secretFile: '/x' };
    expect(resolveConfig({ ...base, projects: [{ id: 'demo1', repoPaths: ['/a'] }] }).projects[0]!.realName).toBeNull();
    expect(resolveConfig({ ...base, projects: [{ id: 'demo1', realName: '  Moth Lantern ', repoPaths: ['/a'] }] }).projects[0]!.realName).toBe('Moth Lantern');
  });
});

describe('real project names: published manifest', () => {
  it('setting on -> real names; off -> safe names', () => {
    const p = proj();
    expect(publishedName(p, true)).toBe('Dragon Game');
    expect(publishedName(p, false)).toBe('DEMO1 Project');
    expect(buildManifest({ shipId: 'demo1', projects: [p] }, true).projects).toEqual([{ id: 'demo1', name: 'Dragon Game', building: 'Workshop' }]);
    expect(buildManifest({ shipId: 'demo1', projects: [p] }, false).projects[0]!.name).toBe('DEMO1 Project');
  });
  it('an owner-chosen publicName is the safe name', () => {
    expect(publishedName(proj({ publicName: 'Space Game' }), false)).toBe('Space Game');
  });
  it('a real name that fails DisplayText falls back to the safe name, per project, never raw', () => {
    const bad = ['Caf\u00e9 \u00dcber', 'Secret_Project', 'x'.repeat(41), '-leading', 'Name <b>', 'A/B'];
    for (const realName of bad) {
      expect(publishedName(proj({ realName }), true)).toBe('DEMO1 Project');
      expect(JSON.stringify(buildManifest({ shipId: 'demo1', projects: [proj({ realName })] }, true))).not.toContain(realName);
    }
    const m = buildManifest({ shipId: 'demo1', projects: [proj({ id: 'aa', realName: 'Good Name' }), proj({ id: 'bb', realName: 'Bad_Name' })] }, true);
    expect(m.projects.map((p) => p.name)).toEqual(['Good Name', 'DEMO1 Project']);
    // a folder name that cannot be shown (non-ASCII) also falls back
    expect(publishedName(proj({ repoPaths: ['/work/Caf\u00e9'] }), true)).toBe('DEMO1 Project');
  });
  it('anything but an explicit true from the server means safe names', () => {
    expect(wantsRealNames({ showRealNames: true })).toBe(true);
    expect(wantsRealNames({ showRealNames: false })).toBe(false);
    expect(wantsRealNames(null)).toBe(false);
  });
});

describe('real project names: agent follows the server setting', () => {
  it('safe at start, real once the server says so, safe again the moment it is turned off or the server goes silent', async () => {
    const data = tmp(); const logs = tmp();
    const secretFile = join(data, 'ship.secret');
    writeFileSync(secretFile, 'x'.repeat(40));
    const cfg = resolveConfig({ shipId: 'demo1', replicaUrl: 'https://demo1.botwarren.com', secretFile, opsPort: await freePort(), dataDir: data, harnessLogDirs: [logs], codexLogDirs: [],
      projects: [{ id: 'demo1', realName: 'Dragon Game', repoPaths: ['C:\\Users\\DEMO1\\Code\\Game'] }] });
    let reply: unknown = undefined; // what the server answers in `settings`
    const sent: string[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { meta: { ship?: { projects: { name: string }[] } } };
      sent.push(body.meta.ship!.projects[0]!.name);
      return new Response(JSON.stringify({ maxSeq: 0, epoch: '0', ...(reply === undefined ? {} : { settings: reply }) }), { status: 200 });
    }) as typeof fetch;
    const agent = await startAgent(cfg, { log: () => {}, replicate: false, fetchImpl });
    const settle = () => new Promise((r) => setTimeout(r, 120)); // the agent re-publishes at once after a change
    try {
      await agent.replicator.tick(); await settle();
      expect(sent).toEqual(['DEMO1 Project']); // server silent -> safe

      reply = { showRealNames: true };
      await agent.replicator.tick(); await settle();
      expect(sent.at(-2)).toBe('DEMO1 Project'); // the request that learned the setting still carried safe names
      expect(sent.at(-1)).toBe('Dragon Game'); // and the very next one carries the real name
      expect(agent.svc.manifest().projects[0]!.name).toBe('Dragon Game');

      reply = { showRealNames: false };
      await agent.replicator.tick(); await settle();
      expect(sent.at(-1)).toBe('DEMO1 Project'); // switched back immediately
      expect(agent.svc.manifest().projects[0]!.name).toBe('DEMO1 Project');

      reply = { showRealNames: true }; await agent.replicator.tick(); await settle();
      expect(sent.at(-1)).toBe('Dragon Game');
      reply = undefined; // old server / no settings key
      await agent.replicator.tick(); await settle();
      expect(sent.at(-1)).toBe('DEMO1 Project');
      reply = { showRealNames: 'yes' }; // malformed -> safe
      await agent.replicator.tick(); await settle();
      expect(sent.at(-1)).toBe('DEMO1 Project');
    } finally { await agent.stop(); }
  });
});
