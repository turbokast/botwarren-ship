/**
 * The ONLY thing the website can tell the agent about the companion: the word "install" or "remove" and the time of the user's consent.
 * Strict: any other field (a URL, a version, a command, a file name) makes the whole directive invalid and it is ignored. Whatever is
 * installed is decided by this install's own configuration and the signed manifest, never by the website.
 */
export interface Directive { want: 'install' | 'remove'; consent: string }

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/;

export function parseDirective(raw: unknown, nowMs: number = Date.now()): Directive | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !keys.includes('want') || !keys.includes('consent')) return null;
  const d = raw as { want?: unknown; consent?: unknown };
  if (d.want !== 'install' && d.want !== 'remove') return null;
  if (typeof d.consent !== 'string' || d.consent.length > 40 || !ISO.test(d.consent)) return null;
  const t = Date.parse(d.consent);
  if (!Number.isFinite(t) || t < Date.parse('2026-01-01T00:00:00Z') || t > nowMs + 86_400_000) return null;
  return { want: d.want, consent: d.consent };
}
