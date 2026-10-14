/** Server-directed publish cadence: nextIntervalMs / minIntervalMs in the response, Retry-After on 503/429/507, backoff, clamping. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startAgent } from '../src/agent.ts';
import { resolveConfig } from '../src/config.ts';
import { CADENCE_CEILING_MS, CADENCE_FLOOR_MS, DEFAULT_CADENCE, RETRY_AFTER_CEILING_MS, Replicator, parseCadence, parseRetryAfter } from '../src/local/replicator.ts';
import { freePort, tmp } from './helpers.ts';

describe('parseCadence', () => {
  it('reads the server cadence and clamps it to 1 s .. 60 s', () => {
    expect(parseCadence({ nextIntervalMs: 12_345, minIntervalMs: 2000 })).toEqual({ idleMs: 12_345, minMs: 2000, fromServer: true });
    expect(parseCadence({ nextIntervalMs: 10 ** 9, minIntervalMs: 2000 })).toMatchObject({ idleMs: CADENCE_CEILING_MS }); // a hostile server cannot make the ship look offline
    expect(parseCadence({ nextIntervalMs: 5, minIntervalMs: 1 })).toMatchObject({ minMs: CADENCE_FLOOR_MS, idleMs: CADENCE_FLOOR_MS });
    expect(parseCadence({ nextIntervalMs: 500, minIntervalMs: 2000 })).toMatchObject({ idleMs: 2000 }); // never idler-faster than the flush interval
    expect(parseCadence({ nextIntervalMs: 20_000 })).toEqual({ idleMs: 20_000, minMs: DEFAULT_CADENCE.minMs, fromServer: true });
  });
  it('returns null when the body carries no usable cadence', () => {
    for (const b of [null, undefined, 'x', 3, {}, { nextIntervalMs: 'soon' }, { nextIntervalMs: NaN }, { minIntervalMs: Infinity }, []]) expect(parseCadence(b), JSON.stringify(b)).toBeNull();
  });
});

describe('parseRetryAfter', () => {
  const NOW = Date.parse('2026-10-14T12:00:00Z');
  it('accepts seconds and HTTP dates, clamps to 1 s .. 5 min, and ignores nonsense', () => {
    expect(parseRetryAfter('30', NOW)).toBe(30_000);
    expect(parseRetryAfter('0', NOW)).toBe(1000);
    expect(parseRetryAfter('999999', NOW)).toBe(RETRY_AFTER_CEILING_MS);
    expect(parseRetryAfter('Wed, 14 Oct 2026 12:00:45 GMT', NOW)).toBe(45_000);
    expect(parseRetryAfter('Wed, 14 Oct 2026 11:00:00 GMT', NOW)).toBe(1000); // in the past
    for (const v of [null, '', 'soon', '-5', '1e3', '12 seconds']) expect(parseRetryAfter(v, NOW), String(v)).toBeNull();
  });
});

type Reply = { status: number; headers?: Record<string, string>; body: unknown };

async function rig() {
  const data = tmp(); const logs = tmp();
  const secretFile = join(data, 'ship.secret');
  writeFileSync(secretFile, 'x'.repeat(40));
  const cfg = resolveConfig({ shipId: 'demo1', replicaUrl: 'https://demo1.botwarren.com', secretFile, opsPort: await freePort(), dataDir: data, harnessLogDirs: [logs], codexLogDirs: [],
    projects: [{ id: 'demo1', repoPaths: ['/work/game'] }] });
  const agent = await startAgent(cfg, { log: () => undefined, replicate: false });
  let clock = Date.parse('2026-10-14T12:00:00Z');
  let reply: Reply = { status: 200, body: { maxSeq: 0, nextIntervalMs: 20_000, minIntervalMs: 2000 } };
  let posts = 0;
  const fetchImpl = (async () => {
    posts++;
    const r = reply;
    const body = r.body === undefined ? 'oops' : JSON.stringify(typeof r.body === 'object' && r.body && 'maxSeq' in r.body ? { ...r.body, epoch: '0', settings: { showRealNames: false } } : r.body);
    return new Response(body, { status: r.status, headers: r.headers ?? {} });
  }) as typeof fetch;
  const rep = new Replicator({ url: agent.replicator.cfg.url, secret: 'x'.repeat(40), publicDbPath: agent.replicator.cfg.publicDbPath, store: agent.svc.store, fetchImpl, now: () => clock, random: () => 0.5 });
  const publishOne = (n: number) => agent.svc.pub.publish({ v: 1, kind: 'feed', occurredAt: '2026-10-14T10:00:00.000Z', certainty: 'observed', demo: false, source: 'herdr', health: 'healthy' } as never, new Date(Date.parse('2026-10-14T10:00:00.000Z') + n).toISOString());
  return { agent, rep, publishOne, posts: () => posts, advance: (ms: number) => { clock += ms; }, set: (r: Reply) => { reply = r; }, now: () => clock };
}

describe('Replicator cadence (the heartbeat contract)', () => {
  it('idles at the server-directed nextIntervalMs, and flushes waiting events at minIntervalMs', async () => {
    const t = await rig();
    try {
      expect(t.rep.dueNow()).toBe(true); // first publish: at once
      await t.rep.tick();
      expect(t.rep.cadence).toEqual({ idleMs: 20_000, minMs: 2000, fromServer: true });
      t.advance(3000); expect(t.rep.dueNow()).toBe(false); // idle: nothing to say, the heartbeat is 20 s away
      t.advance(10_000); expect(t.rep.dueNow()).toBe(false);
      t.advance(7001); expect(t.rep.dueNow()).toBe(true);
      await t.rep.tick();
      // an event appears: it goes out at the flush interval, not at the heartbeat interval
      t.publishOne(1);
      t.advance(1000); expect(t.rep.dueNow()).toBe(false); // never faster than minIntervalMs
      t.advance(1001); expect(t.rep.dueNow()).toBe(true);
    } finally { await t.agent.stop(); }
  });

  it('keeps the old 2 s cadence against a server that sends no cadence, and returns to it if the server stops sending one', async () => {
    const t = await rig();
    try {
      t.set({ status: 200, body: { maxSeq: 0 } });
      await t.rep.tick();
      expect(t.rep.cadence).toEqual(DEFAULT_CADENCE);
      t.advance(1999); expect(t.rep.dueNow()).toBe(false);
      t.advance(2); expect(t.rep.dueNow()).toBe(true);
      t.set({ status: 200, body: { maxSeq: 0, nextIntervalMs: 25_000, minIntervalMs: 2000 } });
      await t.rep.tick(); expect(t.rep.cadence.idleMs).toBe(25_000);
      t.set({ status: 200, body: { maxSeq: 0 } });
      t.advance(25_001); await t.rep.tick(); expect(t.rep.cadence).toEqual(DEFAULT_CADENCE);
    } finally { await t.agent.stop(); }
  });

  it('honours Retry-After on 503, 429 and 507, adopts the cadence in the error body, and waits at least that long', async () => {
    for (const status of [503, 429, 507]) {
      const t = await rig();
      try {
        await t.rep.tick();
        t.set({ status, headers: { 'retry-after': '120' }, body: { error: 'busy', nextIntervalMs: 30_000, minIntervalMs: 2000 } });
        t.advance(25_000); await t.rep.tick();
        expect(t.rep.lastError).toBe(`replica HTTP ${status}`);
        expect(t.rep.cadence.idleMs).toBe(30_000);
        expect(t.rep.retryAtMs).toBe(t.now() + 120_000);
        t.publishOne(1); // even with an event waiting
        t.advance(119_000); expect(t.rep.dueNow(), `${status}: before Retry-After`).toBe(false);
        t.advance(1001); expect(t.rep.dueNow(), `${status}: after Retry-After`).toBe(true);
        t.set({ status: 200, body: { maxSeq: 0, nextIntervalMs: 12_000, minIntervalMs: 2000 } });
        await t.rep.tick();
        expect(t.rep.lastError).toBeNull(); expect(t.rep.retryAtMs).toBe(0);
      } finally { await t.agent.stop(); }
    }
  });

  it('backs off exponentially (2 s, 4 s, 8 s ... at most 60 s) on failures without Retry-After, and a success resets it', async () => {
    const t = await rig();
    try {
      await t.rep.tick();
      t.set({ status: 500, body: undefined });
      const waits: number[] = [];
      for (let i = 0; i < 8; i++) {
        t.advance(60_001); await t.rep.tick();
        waits.push(t.rep.retryAtMs - t.now());
      }
      expect(waits).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
      t.set({ status: 200, body: { maxSeq: 0, nextIntervalMs: 12_000, minIntervalMs: 2000 } });
      t.advance(60_001); await t.rep.tick();
      expect(t.rep.retryAtMs).toBe(0);
      t.set({ status: 500, body: undefined });
      t.advance(60_001); await t.rep.tick();
      expect(t.rep.retryAtMs - t.now()).toBe(2000);
    } finally { await t.agent.stop(); }
  });

  it('ignores a hostile Retry-After and cadence: capped at 5 minutes and at a 60 s heartbeat', async () => {
    const t = await rig();
    try {
      t.set({ status: 503, headers: { 'retry-after': '99999999' }, body: { nextIntervalMs: 10 ** 12, minIntervalMs: 10 ** 12 } });
      await t.rep.tick();
      expect(t.rep.retryAtMs - t.now()).toBe(RETRY_AFTER_CEILING_MS);
      expect(t.rep.cadence).toMatchObject({ idleMs: CADENCE_CEILING_MS, minMs: CADENCE_CEILING_MS });
    } finally { await t.agent.stop(); }
  });

  it('a changed heartbeat payload (the pause switch) is posted at the flush interval, not at the idle one', async () => {
    const t = await rig();
    try {
      await t.rep.tick();
      t.advance(3000); expect(t.rep.dueNow()).toBe(false);
      t.agent.svc.setRemotePause(true); // writes `paused` into the public meta
      expect(t.rep.dueNow()).toBe(true);
    } finally { await t.agent.stop(); }
  });

  it('start() polls locally and publishes only when due (real timers, floor-level cadence)', async () => {
    const t = await rig();
    try {
      t.set({ status: 200, body: { maxSeq: 0, nextIntervalMs: 1000, minIntervalMs: 1000 } });
      const real = new Replicator({ ...t.rep.cfg, fetchImpl: t.rep.cfg.fetchImpl!, now: Date.now, random: () => 0.5 });
      real.start(10);
      await new Promise((r) => setTimeout(r, 1600));
      real.stop();
      expect(t.posts()).toBeGreaterThanOrEqual(2); // at once, then about every second; an idle ship does not post every 10 ms
      expect(t.posts()).toBeLessThanOrEqual(3);
    } finally { await t.agent.stop(); }
  });
});
