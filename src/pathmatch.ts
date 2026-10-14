/**
 * Cross-platform path comparison. The shape of the path decides the rules, not the host OS:
 * a Windows-style cwd found in a log is compared case-insensitively with backslash separators
 * even when this code runs on Linux (tests) and a POSIX cwd stays case-sensitive.
 */
import { posix, win32 } from 'node:path';

const WIN_DRIVE = /^[a-zA-Z]:([\\/]|$)/;
const WIN_UNC = /^\\\\/;
const WIN_EXT_PREFIX = /^\\\\\?\\(UNC\\)?/;

export function isWindowsPath(p: string): boolean {
  return WIN_DRIVE.test(p) || WIN_UNC.test(p) || p.startsWith('//?/');
}

/** Canonical comparable form. Returns null for empty / relative / NUL-containing input. */
export function normalisePath(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 1024 || input.includes('\0')) return null;
  let s = input.trim();
  if (isWindowsPath(s)) {
    s = s.replace(/^\/\/\?\//, '\\\\?\\');
    s = s.replace(WIN_EXT_PREFIX, (_m, unc: string | undefined) => (unc ? '\\\\' : ''));
    s = win32.normalize(s).replace(/\//g, '\\');
    if (!WIN_DRIVE.test(s) && !WIN_UNC.test(s)) return null;
    s = s.length > 3 ? s.replace(/\\+$/, '') : s; // keep the root "c:\"
    return s.toLowerCase();
  }
  if (!s.startsWith('/')) return null; // relative paths cannot be attributed
  s = posix.normalize(s);
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/** True when `child` equals `parent` or lies below it (separator-aware, so `c:\repo2` is not inside `c:\repo`). */
export function isInside(childRaw: string, parentRaw: string): boolean {
  const c = normalisePath(childRaw);
  const p = normalisePath(parentRaw);
  if (c === null || p === null) return false;
  if (isWindowsPath(childRaw) !== isWindowsPath(parentRaw)) return false;
  const sep = c.startsWith('/') ? '/' : '\\';
  if (c === p) return true;
  const prefix = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(prefix);
}

/** Length of the normalised parent, used to prefer the most specific (longest) containing repo. */
export function pathDepth(p: string): number { return normalisePath(p)?.length ?? 0; }
