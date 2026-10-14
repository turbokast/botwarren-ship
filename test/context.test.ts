import { describe, expect, it } from 'vitest';
import { CanonicalEvent, type CanonicalEventInput } from '../src/vendor/core/contract.ts';
import { ProjectAttributor } from '../src/attribution.ts';
import { SessionScanner } from '../src/sessionscan.ts';
import { SECRET_CODE, SECRET_PROMPT, SECRET_TOKEN, appendSession, line, tmp, writeSession } from './helpers.ts';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const WIN_CWD = 'C:\\Users\\DEMO1\\Code\\Game';
const projects = [{ id: 'demo1', repoPaths: [WIN_CWD] }];
const scanner = (root: string) => new SessionScanner({ dirs: [root], instance: 'inst', attributor: new ProjectAttributor(projects, async () => null) });
const assistant = (ts: string, used: number, model = 'claude-sonnet-5-5') => line({ cwd: WIN_CWD, type: 'assistant', timestamp: ts, message: { model, role: 'assistant', content: [{ type: 'text', text: `${SECRET_PROMPT} ${SECRET_TOKEN} ${SECRET_CODE}` }], usage: { input_tokens: 4, cache_creation_input_tokens: 2000, cache_read_input_tokens: used, output_tokens: 311 } } });
const contexts = (evs: CanonicalEventInput[]) => evs.filter((e) => e.type === 'session.activity' && (e as { kind?: string }).kind === 'context') as (CanonicalEventInput & { context?: string; compacted?: boolean })[];

describe('ship agent: context fill from the session log (bucket only)', () => {
  it('reports the starting bucket on first sight, then each change, and never a number or any text', async () => {
    const root = tmp();
    const f = writeSession(root, 'c--Users-DEMO1-Code-Game', 'cccc-1', WIN_CWD, new Date(NOW.getTime() - 5_000), assistant('2026-10-14T11:59:00.000Z', 20_000));
    const s = scanner(root);
    const first = await s.tick(NOW);
    expect(contexts(first).map((e) => e.context)).toEqual(['low']);
    appendSession(f, assistant('2026-10-14T11:59:30.000Z', 150_000) + assistant('2026-10-14T11:59:50.000Z', 185_000), new Date(NOW.getTime() + 1_000));
    const out = await s.tick(new Date(NOW.getTime() + 2_000));
    expect(contexts(out).map((e) => e.context)).toEqual(['high', 'full']);
    const json = JSON.stringify([...first, ...out]);
    for (const n of ['20000', '22000', '150000', '152000', '185000', '187000', '311']) expect(json).not.toContain(n);
    expect(json).not.toMatch(new RegExp(`${SECRET_PROMPT}|${SECRET_TOKEN}|xyzzy|usage|tokens`, 'i'));
    for (const e of [...first, ...out]) CanonicalEvent.parse(e);
  });

  it('a compaction marker becomes one compacted context moment', async () => {
    const root = tmp();
    const f = writeSession(root, 'p', 'cccc-2', WIN_CWD, new Date(NOW.getTime() - 5_000), assistant('2026-10-14T11:59:00.000Z', 190_000));
    const s = scanner(root);
    await s.tick(NOW);
    appendSession(f, line({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-14T12:00:01.000Z', content: `Compacted: ${SECRET_PROMPT}`, compactMetadata: { trigger: 'auto', preTokens: 195_000, postTokens: 21_000 } }), new Date(NOW.getTime() + 1_000));
    const out = contexts(await s.tick(new Date(NOW.getTime() + 2_000)));
    expect(out.map((e) => [e.context, e.compacted])).toEqual([['low', true]]);
    expect(JSON.stringify(out)).not.toMatch(/SECRET|195000|21000/);
  });

  it('a non-Claude model or no usage metadata gives no context event', async () => {
    const root = tmp();
    writeSession(root, 'p', 'cccc-3', WIN_CWD, new Date(NOW.getTime() - 5_000), assistant('2026-10-14T11:59:00.000Z', 90_000, 'some-other-model'));
    expect(contexts(await scanner(root).tick(NOW))).toEqual([]);
  });
});
