import { isSessionNotFoundError } from "@opencode/client"
import type { MissionSessionAdapter, NativeMissionSession } from "./control-types"
import { MISSION_SCHEMA_VERSION } from "./model"

export interface MissionCleanupTarget {
  projectID: string
  missionID: string
  coordinatorSessionID: string
  sessionID: string
  location: { directory: string; workspaceID?: string }
}

export async function removeCleanupTarget(sessions: Pick<MissionSessionAdapter, "get" | "list" | "remove">,
  target: MissionCleanupTarget, isActive: () => boolean = () => true): Promise<"removed" | "retained"> {
  if (!isActive()) throw new Error("Mission cleanup retired")
  let session: NativeMissionSession
  try { session = await sessions.get({ sessionID: target.sessionID }) }
  catch (error) { if (!isSessionNotFoundError(error)) throw error; return "removed" }
  if (!matchesCleanupTarget(session, target)) return "retained"
  if (!sessions.remove || !sessions.list) throw new Error("Native session cleanup is unavailable")
  // Native remove is recursive. Child conversations are outside this opt-in.
  const children = await sessions.list({ parentID: target.sessionID, limit: 1 })
  if (children.data.length) return "retained"
  const fresh = await sessions.get({ sessionID: target.sessionID })
  if (!matchesCleanupTarget(fresh, target)) return "retained"
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
