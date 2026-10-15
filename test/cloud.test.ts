import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startAgent } from '../src/agent.ts';
import { applyCloudLook } from '../src/cloud.ts';
import { resolveConfig } from '../src/config.ts';
import { VERSION } from '../src/version.ts';
import { tmp, freePort } from './helpers.ts';

interface Sent { headers: Record<string, string>; meta: { paused: boolean; ship?: { look?: { hull?: string; thrusters?: number } } }; events: { seq: number }[] }

async function boot() {
  const data = tmp(); const logs = tmp();
  const secretFile = join(data, 'ship.secret');
  writeFileSync(secretFile, 'x'.repeat(40));
  const cfg = resolveConfig({ shipId: 'demo1', replicaUrl: 'https://demo1.botwarren.com', secretFile, opsPort: await freePort(), dataDir: data, harnessLogDirs: [logs], codexLogDirs: [],
    projects: [{ id: 'demo1', repoPaths: ['/work/game'] }] });
  let reply: unknown = { showRealNames: false };
  const sent: Sent[] = [];
  const logLines: string[] = [];
  const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
    sent.push({ headers: init?.headers as Record<string, string>, ...(JSON.parse(String(init?.body)) as Omit<Sent, 'headers'>) });
    return new Response(JSON.stringify({ maxSeq: 0, epoch: '0', settings: reply }), { status: 200 });
  }) as typeof fetch;
  const agent = await startAgent(cfg, { log: (m) => logLines.push(m), replicate: false, fetchImpl });
  const settle = () => new Promise((r) => setTimeout(r, 120)); // the agent re-publishes at once after a change
  return { agent, sent, logLines, settle, setReply: (r: unknown) => { reply = r; } };
}

/** one public event, published straight into the agent's public store (as the delayed publisher would) */
const publishOne = (agent: Awaited<ReturnType<typeof boot>>['agent'], n: number) => agent.svc.pub.publish({ v: 1, kind: 'feed', occurredAt: '2026-10-14T10:00:00.000Z', certainty: 'observed', demo: false, source: 'herdr', health: 'healthy' } as never, new Date(Date.parse('2026-10-14T10:00:00.000Z') + n).toISOString());

describe('ship look from the website (settings.look)', () => {
  it('is applied once per change with a "cloud" audit entry, republished at once, and reset by null', async () => {
    const t = await boot();
    try {
      await t.agent.replicator.tick(); await t.settle();
      expect(t.sent.at(-1)!.meta.ship?.look).toBeUndefined(); // never set: the agent leaves its own look alone

      t.setReply({ showRealNames: false, look: { hull: 'long', palette: 'navy-cyan', thrusters: 4 } });
      await t.agent.replicator.tick(); await t.settle();
      expect(t.agent.svc.manifest().look).toMatchObject({ hull: 'long', thrusters: 4 });
      expect(t.sent.at(-1)!.meta.ship?.look).toMatchObject({ hull: 'long', thrusters: 4 }); // already published in the very next request
      const audits = () => (t.agent.svc.store.audits(50) as { actor: string; action: string }[]).filter((a) => a.action.startsWith('ship_look'));
      expect(audits()).toEqual([expect.objectContaining({ actor: 'cloud', action: 'ship_look_saved' })]);

      // same look again and again: no new audit entry, no re-apply
      await t.agent.replicator.tick(); await t.agent.replicator.tick(); await t.settle();
      expect(audits()).toHaveLength(1);

      // a local ops-room edit after that stays until the website look changes
      t.agent.svc.setLook({ hull: 'ring' }, 'ops');
      await t.agent.replicator.tick(); await t.settle();
      expect(t.agent.svc.manifest().look?.hull).toBe('ring');

      t.setReply({ showRealNames: false, look: null }); // owner reset it on the website
      await t.agent.replicator.tick(); await t.settle();
      expect(t.agent.svc.manifest().look).toBeUndefined();
      expect(t.sent.at(-1)!.meta.ship?.look).toBeUndefined();
      expect(audits().map((a) => `${a.actor}:${a.action}`)).toEqual(['cloud:ship_look_reset', 'ops:ship_look_saved', 'cloud:ship_look_saved']);
    } finally { await t.agent.stop(); }
  });

  it('ignores a look that is not a valid ShipLook, or names a project this ship does not have', async () => {
    const t = await boot();
    try {
      for (const look of ['x', 7, { hull: 'banana' }, { hull: 'long', extra: 1 }, { modules: [{ project: 'someone-else', slot: 1 }] }]) {
        t.setReply({ showRealNames: false, look });
        await t.agent.replicator.tick(); await t.settle();
        expect(t.agent.svc.manifest().look, JSON.stringify(look)).toBeUndefined();
      }
      expect(t.logLines.filter((l) => l.includes('ignored a ship look')).length).toBeGreaterThan(0);
      // the same rejected look is not logged on every 2 s tick
      const n = t.logLines.length;
      await t.agent.replicator.tick(); await t.agent.replicator.tick();
      expect(t.logLines.length).toBe(n);
    } finally { await t.agent.stop(); }
  });

  it('applyCloudLook: absent settings or absent look change nothing', () => {
    let calls = 0;
    const svc = { store: { getSetting: () => undefined, setSetting: () => undefined }, setLook: () => { calls++; return null; } } as never;
    expect(applyCloudLook(svc, null)).toBe('none');
    expect(applyCloudLook(svc, { showRealNames: false })).toBe('none');
    expect(calls).toBe(0);
  });
});

describe('ship design (ShipPlan v2) from the website (settings.look with v: 2)', () => {
  it('is left to the website (it overlays the plan on the public manifest): no local change, no audit, no "invalid" log, v1 looks keep working', async () => {
    const t = await boot();
    try {
      t.setReply({ showRealNames: false, look: { v: 2, pal: 'navy-cyan', bow: 'ring' }, lookAt: '2026-10-14T12:05:00.000Z' });
      await t.agent.replicator.tick(); await t.settle();
      expect(t.agent.svc.manifest().plan).toBeUndefined();
      expect(t.logLines.some((l) => l.includes('ship look'))).toBe(false);
      expect((t.agent.svc.store.audits(50) as { action: string }[]).some((a) => a.action.startsWith('ship_'))).toBe(false);
    } finally { await t.agent.stop(); }
  });
});

describe('Pause publishing from the website (settings.paused)', () => {
  it('stops sending events but keeps the heartbeat (paused, not offline), then resumes and flushes', async () => {
    const t = await boot();
    try {
      publishOne(t.agent, 1);
      await t.agent.replicator.tick();
      expect(t.sent.at(-1)!.events).toHaveLength(1);
      expect(t.sent.at(-1)!.meta.paused).toBe(false);

      t.setReply({ showRealNames: false, paused: true });
      await t.agent.replicator.tick(); await t.settle(); // learns it; republishes at once with meta.paused
      expect(t.agent.svc.remotePaused).toBe(true);
      expect(t.logLines.some((l) => l.includes('PAUSED from the website'))).toBe(true);
      const before = t.sent.length;
      publishOne(t.agent, 2); publishOne(t.agent, 3);
      await t.agent.replicator.tick(); await t.agent.replicator.tick();
      expect(t.sent.length).toBe(before + 2); // the heartbeat keeps going: every tick is still a publish request
      for (const s of t.sent.slice(-3)) { expect(s.events).toEqual([]); expect(s.meta.paused).toBe(true); }
      // new events are not even released from the delay queue while paused
      t.agent.svc.ingest([{ schemaVersion: 1, eventId: 'e1', source: 'herdr', sourceInstance: 'x', sourceEventId: 'e1', occurredAt: new Date().toISOString(), observedAt: new Date().toISOString(), type: 'session.observed', sessionKey: 's1', harness: 'claude', status: 'working', projectId: 'demo1', attribution: { method: 'cwd_registry', certainty: 'observed' }, private: {} }]);
      expect(t.agent.svc.publishDue()).toBe(0);

      t.setReply({ showRealNames: false }); // paused no longer set -> resumed
      await t.agent.replicator.tick(); await t.settle();
      expect(t.agent.svc.remotePaused).toBe(false);
      await t.agent.replicator.tick();
      expect(t.sent.at(-1)!.meta.paused).toBe(false);
      expect(t.sent.at(-1)!.events.length).toBeGreaterThan(0); // what was held flows after resume
    } finally { await t.agent.stop(); }
  });

  it('a malformed answer or an old server (no settings) never leaves the ship paused', async () => {
    const t = await boot();
    try {
      t.setReply({ showRealNames: false, paused: true });
      await t.agent.replicator.tick(); await t.settle();
      expect(t.agent.svc.remotePaused).toBe(true);
      t.setReply({ showRealNames: false, paused: 'yes' }); // malformed: the whole settings object is refused -> not paused
      await t.agent.replicator.tick(); await t.settle();
      expect(t.agent.svc.remotePaused).toBe(false);
    } finally { await t.agent.stop(); }
  });
});

describe('installation lane', () => {
  it('sends a random id for THIS installation, stable across restarts of the same data, and never derived from the computer', async () => {
    const t = await boot();
    try {
      await t.agent.replicator.tick();
      const lane = t.sent[0]!.headers['x-botwarren-lane'];
      expect(lane).toMatch(/^[a-f0-9]{16}$/);
      expect(t.agent.svc.store.getSetting('lane_id')).toBe(lane);
      await t.agent.replicator.tick();
      expect(t.sent[1]!.headers['x-botwarren-lane']).toBe(lane);
      expect(JSON.stringify(t.sent[0]!.meta)).not.toContain(lane!);
    } finally { await t.agent.stop(); }
    const u = await boot();
    try { await u.agent.replicator.tick(); expect(u.sent[0]!.headers['x-botwarren-lane']).not.toBe(t.sent[0]!.headers['x-botwarren-lane']); } finally { await u.agent.stop(); } // another installation
  });
  it('after a lane reset the cursor never moves backwards (the history is already there); after a plain reset it still follows the server', async () => {
    const data = tmp(); const logs = tmp();
    const secretFile = join(data, 'ship.secret'); writeFileSync(secretFile, 'x'.repeat(40));
    const cfg = resolveConfig({ shipId: 'demo1', replicaUrl: 'https://demo1.botwarren.com', secretFile, opsPort: 47000 + Math.floor(Math.random() * 1000), dataDir: data, harnessLogDirs: [logs], codexLogDirs: [], projects: [{ id: 'demo1', repoPaths: ['/work/game'] }] });
    let answer: Record<string, unknown> = { maxSeq: 0, laneReset: true, settings: { showRealNames: false } };
    const fetchImpl = (async () => new Response(JSON.stringify(answer), { status: 200 })) as typeof fetch;
    const agent = await startAgent(cfg, { log: () => undefined, replicate: false, fetchImpl });
    try {
      for (let n = 1; n <= 50; n++) agent.svc.pub.publish({ v: 1, kind: 'feed', occurredAt: '2026-10-14T10:00:00.000Z', certainty: 'observed', demo: false, source: 'herdr', health: 'healthy' } as never, new Date(Date.parse('2026-10-14T10:00:00.000Z') + n).toISOString());
      agent.svc.store.setSetting('replica_cursor', '40');
      await agent.replicator.tick();
      expect(agent.replicator.cursor).toBe(40); // lane reset answered 0: do not resend 40 events of history
      answer = { maxSeq: 45, laneReset: true, settings: { showRealNames: false } };
      await agent.replicator.tick();
      expect(agent.replicator.cursor).toBe(45);
      answer = { maxSeq: 3, settings: { showRealNames: false } }; // the remote was wiped and refilled: follow it
      await agent.replicator.tick();
      expect(agent.replicator.cursor).toBe(3);
    } finally { await agent.stop(); }
  });
});

describe('agent identity', () => {
  it('reports its version in a request header (never in the body)', async () => {
    const t = await boot();
    try {
      await t.agent.replicator.tick();
      expect(t.sent[0]!.headers['x-botwarren-agent']).toBe(VERSION);
      expect(VERSION).toBe('0.8.0');
      expect(JSON.stringify(t.sent[0]!.meta)).not.toContain(VERSION);
    } finally { await t.agent.stop(); }
  });
});
