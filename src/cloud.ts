/**
 * Owner settings that come back from the website in the publish response (`settings`). The cloud only ever answers an
 * authenticated publish with THIS ship's own settings; the agent still validates everything it applies.
 *
 *  - `paused`: the "Pause publishing" switch. While true no new public events are published or sent; the publish request
 *    itself (the heartbeat) keeps going so the ship shows "paused", not "offline". Silence or any other answer = not paused.
 *  - `look`: the ship look saved in the hosted Ship Builder. Absent = never used there: the local look is left alone.
 *    A look is applied once per change (audited as "cloud"); `null` = the owner reset it. Local ops-room edits made after
 *    that stay until the website look changes again. Anything that is not a valid ShipLook is ignored.
 */
import { ShipLook, type ReplicaSettings } from './vendor/core/contract.ts';
import type { PrivateService } from './local/service.ts';

const APPLIED = 'cloud_look_applied';

/** Applies `settings.look` if it changed since last time. Returns what happened (for the log and tests). */
export function applyCloudLook(svc: Pick<PrivateService, 'store' | 'setLook'>, settings: ReplicaSettings | null): 'none' | 'unchanged' | 'applied' | 'reset' | 'rejected' {
  if (!settings || settings.look === undefined) return 'none';
  const key = settings.look === null ? 'null' : JSON.stringify(settings.look);
  if (svc.store.getSetting(APPLIED) === key) return 'unchanged';
  let look: ShipLook | null = null;
  if (settings.look !== null) {
    const parsed = ShipLook.safeParse(settings.look);
    if (!parsed.success) return 'rejected';
    look = parsed.data;
  }
  try { svc.setLook(look, 'cloud'); } catch { return 'rejected'; } // e.g. a module for a project this ship does not have
  svc.store.setSetting(APPLIED, key);
  return look === null ? 'reset' : 'applied';
}
