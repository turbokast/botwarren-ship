import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PolicyError } from '../../src/adapters/api.ts';
import { makeLoopbackHttp, makeScopedFs } from '../../src/adapters/policy.ts';
import { fakeHttp, mkTmp, rmTmp } from './kit.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

describe('loopback http policy', () => {
  it('allows exactly the listed GET paths and refuses everything else before any request is made', async () => {
    const srv = await fakeHttp({ '/ok': { a: 1 }, '/ok/secret': { x: 1 } });
    cleanup.push(srv.close);
    const http = makeLoopbackHttp({ allow: ['/ok'], port: srv.port });
    expect((await http.get('/ok')).status).toBe(200);
    for (const p of ['/ok/secret', '/ok?x=1', '/ok/', '/OK', '//ok', '/ok/../ok', 'http://evil/ok', '']) {
      await expect(http.get(p)).rejects.toBeInstanceOf(PolicyError);
    }
    expect(srv.requests).toEqual([{ method: 'GET', url: '/ok' }]); // nothing else ever hit the wire
  });

  it('refuses non-loopback hosts and bad ports', () => {
    expect(() => makeLoopbackHttp({ allow: ['/a'], port: 80, host: 'example.com' as never })).toThrow(PolicyError);
    expect(() => makeLoopbackHttp({ allow: ['/a'], port: 0 })).toThrow(PolicyError);
    expect(() => makeLoopbackHttp({ allow: ['/a'], port: 70000 })).toThrow(PolicyError);
  });

  it('caps the response size', async () => {
    const srv = await fakeHttp({ '/big': 'x'.repeat(300_000) });
    cleanup.push(srv.close);
    await expect(makeLoopbackHttp({ allow: ['/big'], port: srv.port }).get('/big', { maxBytes: 1000 })).rejects.toThrow();
  });

  it('does not follow redirects', async () => {
    const srv = await fakeHttp({});
    cleanup.push(srv.close);
    srv.server.removeAllListeners('request');
    srv.server.on('request', (_q, res) => { res.writeHead(302, { location: '/elsewhere' }); res.end(); });
    const r = await makeLoopbackHttp({ allow: ['/a'], port: srv.port }).get('/a');
    expect(r.status).toBe(302);
  });
});

describe('scoped fs', () => {
  it('stays inside the declared roots, refuses symlinks, and caps reads', () => {
    const root = mkTmp(); const other = mkTmp();
    cleanup.push(() => { rmTmp(root); rmTmp(other); });
    mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'd', 'a.txt'), 'x'.repeat(2_000_000));
    writeFileSync(join(other, 'secret.txt'), 'TOPSECRET');
    symlinkSync(join(other, 'secret.txt'), join(root, 'd', 'link.txt'));
    const fs = makeScopedFs([root]);
    expect(fs.list(join(root, 'd')).map((e) => e.name).sort()).toEqual(['a.txt', 'link.txt']);
    expect(fs.readHead(join(root, 'd', 'a.txt'), 10_000_000)!.length).toBe(1024 * 1024);
    expect(fs.stat(join(root, 'd', 'link.txt'))).toBeNull();
    expect(fs.readHead(join(root, 'd', 'link.txt'), 100)).toBeNull();
    expect(() => fs.list(other)).toThrow(PolicyError);
    expect(() => fs.readHead(join(other, 'secret.txt'), 10)).toThrow(PolicyError);
    expect(() => fs.stat(join(root, '..', 'x'))).toThrow(PolicyError);
  });
});
