import { describe, expect, it } from 'vitest';
import { ProjectAttributor } from '../src/attribution.ts';

const projects = [
  { id: 'game', repoPaths: ['C:\\Code\\Game'] },
  { id: 'tools', repoPaths: ['C:\\Code\\Game\\tools', 'D:\\Tools'] },
];
const remotes: Record<string, string | null> = {
  'C:\\Code\\Game': 'github.com/demo1/game',
  'C:\\Code\\Game\\tools': null,
  'D:\\Tools': 'github.com/demo1/tools',
  'E:\\Clones\\game-copy': 'github.com/demo1/game',
};
const remote = async (dir: string) => remotes[dir] ?? null;

describe('ProjectAttributor', () => {
  it('matches by cwd path (case-insensitive Windows) when there is no remote', async () => {
    const a = new ProjectAttributor(projects, async () => null);
    expect(await a.attribute('c:\\code\\GAME\\src')).toEqual({ projectId: 'game', method: 'cwd_registry', via: 'path' });
  });
  it('prefers the most specific repo path', async () => {
    const a = new ProjectAttributor(projects, async () => null);
    expect((await a.attribute('C:\\Code\\Game\\tools\\x')).projectId).toBe('tools');
  });
  it('prefers a git remote match, even from a clone elsewhere', async () => {
    const a = new ProjectAttributor(projects, remote);
    expect(await a.attribute('E:\\Clones\\game-copy')).toEqual({ projectId: 'game', method: 'cwd_registry', via: 'remote' });
  });
  it('leaves unknown cwds unattributed', async () => {
    const a = new ProjectAttributor(projects, remote);
    expect(await a.attribute('C:\\Users\\DEMO1\\Documents\\private-notes')).toEqual({ projectId: null, method: 'none', via: null });
    expect((await a.attribute(null)).projectId).toBeNull();
    expect((await a.attribute('relative/dir')).projectId).toBeNull();
  });
  it('caches git lookups per directory', async () => {
    let n = 0;
    const a = new ProjectAttributor(projects, async (d) => { n++; return remotes[d] ?? null; });
    await a.attribute('E:\\Clones\\game-copy'); const first = n;
    await a.attribute('E:\\Clones\\game-copy'); await a.attribute('E:\\Clones\\game-copy');
    expect(n).toBe(first);
  });
});
