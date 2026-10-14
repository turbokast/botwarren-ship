/** The release notes come from CHANGELOG.md (scripts/changelog-notes.mjs): a release without a dated, non-empty entry must fail closed. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS modules without types
import { extractNotes } from '../../scripts/changelog-notes.mjs';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'changelog-notes.mjs');
const SAMPLE = `# Changelog

## [Unreleased]

### Added

- something not yet released

## [0.5.1] - 2026-11-01

### Fixed

- a bug

## [0.5.0] - 2026-10-14

### Added

- the first public release

### Security

- release archives are attested

## [0.4.0]

### Added

- an undated entry

## [0.3.0] - 2026-09-01

### Added

[Unreleased]: https://example.org/compare/v0.5.1...HEAD
[0.5.1]: https://example.org/compare/v0.5.0...v0.5.1
`;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('changelog-notes', () => {
  it('returns exactly the section of the requested version', () => {
    const { date, body } = extractNotes(SAMPLE, '0.5.0') as { date: string; body: string };
    expect(date).toBe('2026-10-14');
    expect(body).toContain('the first public release');
    expect(body).toContain('release archives are attested');
    expect(body).not.toContain('a bug');
    expect(body).not.toContain('undated');
  });

  it('stops at the link reference definitions at the bottom of the file', () => {
    const { body } = extractNotes(SAMPLE.replace('## [0.3.0] - 2026-09-01\n\n### Added\n', '## [0.3.0] - 2026-09-01\n\n### Added\n\n- last entry\n'), '0.3.0') as { body: string };
    expect(body).toContain('last entry');
    expect(body).not.toContain('example.org');
  });

  it('fails closed: unknown version, missing date, empty section, not a version', () => {
    expect(() => extractNotes(SAMPLE, '9.9.9')).toThrow(/no section/);
    expect(() => extractNotes(SAMPLE, '0.4.0')).toThrow(/no release date/);
    expect(() => extractNotes(SAMPLE, '0.3.0')).toThrow(/empty/);
    expect(() => extractNotes(SAMPLE, 'latest; rm -rf')).toThrow(/not a version/);
  });

  it('the command line prints the notes with a verification footer, and exits 1 for a missing entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bw-cl-'));
    dirs.push(dir);
    const file = join(dir, 'CHANGELOG.md');
    writeFileSync(file, SAMPLE);
    const ok = spawnSync(process.execPath, [SCRIPT, '0.5.0', '--changelog', file], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('the first public release');
    expect(ok.stdout).toContain('#verify-a-release');
    const out = join(dir, 'notes.md');
    expect(spawnSync(process.execPath, [SCRIPT, '0.5.1', '--changelog', file, '--out', out], { encoding: 'utf8' }).status).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('a bug');
    const bad = spawnSync(process.execPath, [SCRIPT, '1.0.0', '--changelog', file], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('no section');
  });
});
