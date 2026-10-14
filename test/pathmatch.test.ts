import { describe, expect, it } from 'vitest';
import { isInside, isWindowsPath, normalisePath } from '../src/pathmatch.ts';

describe('pathmatch', () => {
  it('matches Windows paths case-insensitively, regardless of separators and trailing slash', () => {
    expect(isInside('C:\\Users\\DEMO1\\Code\\Game\\src', 'c:/users/demo1/code/game')).toBe(true);
    expect(isInside('c:\\USERS\\demo1\\code\\GAME\\', 'C:\\Users\\DEMO1\\Code\\Game')).toBe(true);
    expect(isInside('C:\\Users\\DEMO1\\Code\\Game', 'C:\\Users\\DEMO1\\Code\\Game\\')).toBe(true);
  });
  it('does not confuse sibling directories sharing a prefix, or parents', () => {
    expect(isInside('C:\\Code\\Game2', 'C:\\Code\\Game')).toBe(false);
    expect(isInside('C:\\Code', 'C:\\Code\\Game')).toBe(false);
    expect(isInside('D:\\Code\\Game', 'C:\\Code\\Game')).toBe(false);
  });
  it('resolves .. segments instead of trusting them', () => {
    expect(isInside('C:\\Code\\Game\\..\\Other', 'C:\\Code\\Game')).toBe(false);
    expect(isInside('C:\\Code\\Game\\sub\\..\\x', 'C:\\Code\\Game')).toBe(true);
  });
  it('handles UNC and extended-length prefixes', () => {
    expect(isInside('\\\\?\\C:\\Code\\Game\\a', 'C:\\Code\\Game')).toBe(true);
    expect(isInside('\\\\SRV\\Share\\Game\\a', '\\\\srv\\share\\game')).toBe(true);
  });
  it('keeps POSIX paths case-sensitive and never mixes styles', () => {
    expect(isInside('/home/a/Repo/src', '/home/a/Repo')).toBe(true);
    expect(isInside('/home/a/repo/src', '/home/a/Repo')).toBe(false);
    expect(isInside('/home/a/Repo', 'C:\\home\\a\\Repo')).toBe(false);
  });
  it('rejects empty, relative and NUL input', () => {
    expect(normalisePath('')).toBeNull();
    expect(normalisePath('relative\\dir')).toBeNull();
    expect(normalisePath('src/x')).toBeNull();
    expect(normalisePath('C:\\a\0b')).toBeNull();
    expect(isWindowsPath('C:\\x')).toBe(true);
    expect(isWindowsPath('/x')).toBe(false);
  });
});
