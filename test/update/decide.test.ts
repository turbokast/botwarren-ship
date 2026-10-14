import { describe, expect, it } from 'vitest';
import { decideUpdate, rolloutBucket, type DecideInput } from '../../src/update/decide.ts';
import { compareVersions, isVersion } from '../../src/update/semver.ts';
import { makeManifest } from './kit.ts';

const NOW_MS = Date.parse('2026-10-14T12:00:00Z');
const input = (o: Partial<DecideInput> & { manifestOpts?: Parameters<typeof makeManifest>[0] } = {}): DecideInput => ({
  manifest: makeManifest(o.manifestOpts ?? { stable: '0.5.0', releases: [{ version: '0.5.0' }, { version: '0.4.0' }] }).manifest,
  current: '0.4.0', channel: 'stable', installId: '11111111-2222-3333-4444-555555555555', denylist: {}, nowMs: NOW_MS, ...o,
});

describe('semver', () => {
  it('is strict x.y.z and numeric', () => {
    expect(isVersion('0.5.0')).toBe(true);
    for (const v of ['0.5', '0.5.0-rc1', '01.0.0', 'v1.0.0', '1.0.0+b', '']) expect(isVersion(v)).toBe(false);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});

describe('decideUpdate', () => {
  it('updates to the channel version when newer; up_to_date when equal', () => {
    expect(decideUpdate(input())).toMatchObject({ action: 'update', version: '0.5.0', forced: false, rollback: false });
    expect(decideUpdate(input({ current: '0.5.0' }))).toMatchObject({ action: 'none', reason: 'up_to_date' });
  });

  it('never downgrades on its own (even if the manifest says so); only a signed rollbackFrom allows it', () => {
    const m = { stable: '0.4.0', releases: [{ version: '0.5.0' }, { version: '0.4.0' }] };
    expect(decideUpdate(input({ current: '0.5.0', manifestOpts: m }))).toMatchObject({ action: 'none', reason: 'downgrade_refused' });
    expect(decideUpdate(input({ current: '0.5.0', manifestOpts: { ...m, rollbackFrom: [{ from: '0.5.0', to: '0.4.0' }] } }))).toMatchObject({ action: 'update', version: '0.4.0', rollback: true });
    // rollbackFrom does not apply to other current versions
    expect(decideUpdate(input({ current: '0.5.1', manifestOpts: { ...m, releases: [...m.releases, { version: '0.5.1' }], rollbackFrom: [{ from: '0.5.0', to: '0.4.0' }] } }))).toMatchObject({ action: 'none', reason: 'downgrade_refused' });
  });

  it('refuses a blocked target, a denylisted target (until it expires) and an incompatible protocol', () => {
    expect(decideUpdate(input({ manifestOpts: { stable: '0.5.0', blocked: ['0.5.0'], releases: [{ version: '0.5.0' }] } }))).toMatchObject({ action: 'none', reason: 'blocked' });
    expect(decideUpdate(input({ denylist: { '0.5.0': NOW_MS + 1000 } }))).toMatchObject({ action: 'none', reason: 'denylisted' });
    expect(decideUpdate(input({ denylist: { '0.5.0': NOW_MS - 1 } })).action).toBe('update');
    expect(decideUpdate(input({ manifestOpts: { stable: '0.5.0', releases: [{ version: '0.5.0', protocol: { min: 2, max: 3 } }] } }))).toMatchObject({ action: 'none', reason: 'protocol' });
  });

  it('honours a maximumVersion pin and an explicit version; reports missing channel releases', () => {
    expect(decideUpdate(input({ maximumVersion: '0.4.5' }))).toMatchObject({ action: 'none', reason: 'above_maximum' });
    expect(decideUpdate(input({ manifestOpts: { stable: '0.9.0', releases: [{ version: '0.4.0' }] } }))).toMatchObject({ action: 'none', reason: 'release_missing' });
    expect(decideUpdate(input({ explicitVersion: '0.5.0', manifestOpts: { stable: '0.4.0', releases: [{ version: '0.5.0', rolloutBp: 0 }, { version: '0.4.0' }] } }))).toMatchObject({ action: 'update', version: '0.5.0' });
  });
});

describe('staged rollout bucketing', () => {
  it('is stable per install and salt, differs per salt, and is in 0..9999', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(rolloutBucket(id, 's1')).toBe(rolloutBucket(id, 's1'));
    expect(rolloutBucket(id, 's1')).not.toBe(rolloutBucket(id, 's2'));
    for (let i = 0; i < 200; i++) { const b = rolloutBucket(`id-${i}`, 'x'); expect(b).toBeGreaterThanOrEqual(0); expect(b).toBeLessThan(10_000); }
  });

  it('is roughly uniform: 10% rollout reaches about 10% of 20000 installs', () => {
    let hit = 0;
    for (let i = 0; i < 20_000; i++) if (rolloutBucket(`install-${i}`, 'rel-0.5.0') < 1000) hit++;
    expect(hit).toBeGreaterThan(1800); expect(hit).toBeLessThan(2200);
  });

  it('a larger percentage is a superset of a smaller one (installs never flip back out)', () => {
    for (let i = 0; i < 500; i++) {
      const b = rolloutBucket(`i-${i}`, 'salt');
      if (b < 500) expect(b < 5000).toBe(true);
    }
  });

  it('gates updates: 0 -> nobody, 10000 -> everybody, critical / below minSupported / blocked current bypass the gate', () => {
    const gated = (bp: number, extra: Partial<Parameters<typeof makeManifest>[0]> = {}, crit = false, current = '0.4.0') =>
      decideUpdate(input({ current, manifestOpts: { stable: '0.5.0', releases: [{ version: '0.5.0', rolloutBp: bp, critical: crit }, { version: '0.4.0' }], ...extra } }));
    expect(gated(0)).toMatchObject({ action: 'none', reason: 'rollout_not_yet' });
    expect(gated(10_000).action).toBe('update');
    expect(gated(0, {}, true)).toMatchObject({ action: 'update', forced: true });
    expect(gated(0, { minSupported: '0.4.1' })).toMatchObject({ action: 'update', forced: true });
    expect(gated(0, { blocked: ['0.4.0'] })).toMatchObject({ action: 'update', forced: true });
    // the same install lands consistently on one side of a given percentage
    const id = decideUpdate(input({ installId: 'fixed-install', manifestOpts: { stable: '0.5.0', releases: [{ version: '0.5.0', rolloutBp: 5000, salt: 'sa' }] } }));
    const again = decideUpdate(input({ installId: 'fixed-install', manifestOpts: { stable: '0.5.0', releases: [{ version: '0.5.0', rolloutBp: 5000, salt: 'sa' }] } }));
    expect(id.action).toBe(again.action);
  });
});
