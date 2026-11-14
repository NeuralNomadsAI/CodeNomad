import { getPermissionQueue } from "../stores/instances"
import { getFormQueue } from "../stores/forms"
import { sessions } from "../stores/session-state"
import { getSessionAncestorIdsFromMap } from "../stores/session-tree"

/** Unselected passages use their live coordinator and loaded native descendants. */
export function missionPassageRequests(instanceId: string, root?: string): number {
  if (!root) return 0
  const family = sessions().get(instanceId) ?? new Map()
  const owned = (sessionID?: string) => Boolean(sessionID)
    && (sessionID === root || getSessionAncestorIdsFromMap(family, sessionID!).includes(root))
  return getFormQueue(instanceId).filter(form => owned(form.sessionID)).length
    + getPermissionQueue(instanceId).filter(permission => owned(permission.sessionID)).length
}
