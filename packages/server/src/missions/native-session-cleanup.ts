import { isSessionNotFoundError } from "@opencode/client"
import type { MissionSessionAdapter, NativeMissionSession } from "./control-types"
import { MISSION_SCHEMA_VERSION, type MissionCleanupReason } from "./model"

export interface MissionCleanupTarget {
  projectID: string
  missionID: string
  coordinatorSessionID: string
  sessionID: string
  location: { directory: string; workspaceID?: string }
}

export async function removeCleanupTarget(sessions: Pick<MissionSessionAdapter, "get" | "list" | "remove">,
  target: MissionCleanupTarget, isActive: () => boolean = () => true,
  onRetained: (reason: MissionCleanupReason) => void = () => {},
  validateAdmission?: () => Promise<void>): Promise<"removed" | "retained"> {
  const retain = (reason: MissionCleanupReason) => { onRetained(reason); return "retained" as const }
  if (!isActive()) throw new Error("Mission cleanup retired")
  let session: NativeMissionSession
  try { session = await sessions.get({ sessionID: target.sessionID }) }
  catch (error) { if (!isSessionNotFoundError(error)) throw error; return "removed" }
  if (!matchesCleanupTarget(session, target)) return retain(retentionReason(session, target))
  const list = sessions.list?.bind(sessions)
  if (!sessions.remove || !list) throw new Error("Native session cleanup is unavailable")
  // Native remove is recursive. Child conversations are outside this opt-in.
  const hasChildren = async () => {
    const children = await list({ parentID: target.sessionID, limit: 1 })
    if (!Array.isArray(children.data)) throw new Error("Incomplete native child inventory")
    if (children.data.length) return true
    if (children.cursor?.next) throw new Error("Incomplete native child inventory")
    return false
  }
  if (await hasChildren()) return retain("children")
  const fresh = await sessions.get({ sessionID: target.sessionID })
  if (!matchesCleanupTarget(fresh, target)) return retain(retentionReason(fresh, target))
  if (validateAdmission) {
    // Desktop admission must be revalidated AFTER target/inventory preparation.
    // That validation itself awaits native/ownership reads: do not let it make
    // the target/recursive-child guards stale. Keep their final observations
    // after it, and the synchronous activity guard at the actual remove call.
    // These bounded reads are not atomic exclusion of independent native writers.
    await validateAdmission()
    if (await hasChildren()) return retain("children")
    const final = await sessions.get({ sessionID: target.sessionID })
    if (!matchesCleanupTarget(final, target)) return retain(retentionReason(final, target))
  }
  if (!isActive()) throw new Error("Mission cleanup retired")
  try { await sessions.remove({ sessionID: target.sessionID }) }
  catch (error) { if (!isSessionNotFoundError(error)) throw error }
  return "removed"
}

function matchesCleanupTarget(session: NativeMissionSession, target: MissionCleanupTarget): boolean {
  const metadata = session.metadata?.["codenomad.mission"]
  return session.id === target.sessionID && !session.parentID && session.projectID === target.projectID
    && session.location.directory === target.location.directory && session.location.workspaceID === target.location.workspaceID
    && metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
    && metadata.version === MISSION_SCHEMA_VERSION && metadata.missionID === target.missionID && metadata.kind === "actor"
}

function retentionReason(session: NativeMissionSession, target: MissionCleanupTarget): MissionCleanupReason {
  return session.location.directory !== target.location.directory || session.location.workspaceID !== target.location.workspaceID ? "moved" : "identity"
}
