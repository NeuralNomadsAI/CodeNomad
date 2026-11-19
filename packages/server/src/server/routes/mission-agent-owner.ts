import { isSessionNotFoundError } from "@opencode/client"
import { isReservedMissionScheduleSessionID } from "../../missions/mission-schedule-carrier-identity"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"

type Manager = Pick<WorkspaceManager, "list" | "get" | "getSharedServiceConnection" | "ownsLocation">

/** Private bridge caller, re-proven before effects and after reads. */
export async function ownedMissionAgent(manager: Manager, sessionID: string, signal: AbortSignal) {
  if (isReservedMissionScheduleSessionID(sessionID)) throw new Error("Technical carrier cannot control Missions")
  const candidates = await Promise.all(manager.list().map(async workspace => {
    const connection = await manager.getSharedServiceConnection(workspace.id)
    if (!connection) throw new Error("Mission ownership unavailable")
    const session = await connection.client.session.get({ sessionID }, { signal }).catch(error => {
      if (isSessionNotFoundError(error)) return undefined
      throw error
    })
    if (!session) return undefined
    const owned = await manager.ownsLocation(workspace.id, session.location, connection.client, { signal, strict: true })
    return owned && session.id === sessionID ? { connection, workspace, session } : undefined
  }))
  const owners = candidates.filter(value => value !== undefined)
  if (!owners.length || new Set(owners.map(value => value.connection)).size !== 1) throw new Error("Mission owner ambiguous")
  const { connection, workspace, session } = owners[0], client = connection.client
  const current = () => {
    signal.throwIfAborted(); connection.assertCurrent()
    if (manager.get(workspace.id) !== workspace) throw new Error("Mission owner changed")
  }
  const refresh = async () => {
    current()
    const fresh = await client.session.get({ sessionID }, { signal })
    if (fresh.id !== sessionID || fresh.projectID !== session.projectID || !sameLocation(fresh.location, session.location)
      || !await manager.ownsLocation(workspace.id, fresh.location, client, { signal, strict: true }))
      throw new Error("Mission caller changed")
    current()
  }
  await refresh()
  const options = { location: { directory: session.location.directory }, ...locationRequestOptions(session.location), signal }
  const location = await client.location.get({ location: options.location }, { signal })
  await refresh()
  if (location.project.id !== session.projectID) throw new Error("Mission project differs")
  return { connection, workspace, session, client, current, refresh, options, project: location.project }
}
