/**
 * Public project names. A ship publishes SAFE generic names ("<SHIP> Project", or the owner's explicit `publicName`)
 * unless the owner switched on "Show real project names" on the website. The decision comes from the server
 * (response of POST /internal/publish: settings.showRealNames); this agent never decides to publish real names itself.
 *
 * "Real name" of a project, in order:
 *   1. `realName` in the config (the owner's own project name), else
 *   2. the folder name of the first repo path, prettified: `_` and `-` runs become spaces; if the folder name has
 *      no capital letters each word gets one ("my-cool_game" -> "My Cool Game"); names that already mix case
 *      ("TurboKast") are left alone; a trailing ".git" is dropped.
 * The result must pass core's public DisplayText (letters, digits, spaces and ' & . - only, 1-40 chars, starts with
 * a letter or digit). If it does not, that project keeps its safe name. Raw, unvalidated text is never published.
 */
import { DisplayText, type ReplicaSettings } from './vendor/core/contract.ts';

export function prettifyFolderName(repoPath: string): string | null {
  const last = repoPath.split(/[\\/]+/).filter(Boolean).at(-1) ?? '';
  const base = last.replace(/\.git$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return null;
  return /[A-Z]/.test(base) ? base : base.replace(/(^|\s)([a-z])/g, (_m, sp: string, c: string) => sp + c.toUpperCase());
}

export interface NamedProject { id: string; publicName: string; realName: string | null; repoPaths: string[] }

/** The owner-facing real name candidate for a project (not yet validated). */
export function realNameCandidate(p: Pick<NamedProject, 'realName' | 'repoPaths'>): string | null {
  const configured = p.realName?.trim();
  if (configured) return configured;
  const repo = p.repoPaths[0];
  return repo ? prettifyFolderName(repo) : null;
}

/** Name to publish for one project. */
export function publishedName(p: NamedProject, showRealNames: boolean): string {
  if (!showRealNames) return p.publicName;
  const real = DisplayText.safeParse(realNameCandidate(p));
  return real.success ? real.data : p.publicName;
}

/** The public manifest (name + projects) for the current setting. */
export function buildManifest(cfg: { shipId: string; projects: NamedProject[] }, showRealNames: boolean): { name: string; projects: { id: string; name: string; building: string }[] } {
  return {
    name: cfg.shipId.toUpperCase().slice(0, 40),
    projects: cfg.projects.map((p) => ({ id: p.id, name: publishedName(p, showRealNames), building: 'Workshop' })),
  };
}

/** Anything but an explicit `showRealNames: true` from the server means safe names. */
export const wantsRealNames = (s: ReplicaSettings | null): boolean => s?.showRealNames === true;
