import type { WorkspaceManager } from "../../workspaces/manager"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { CODENOMAD_MISSIONS_RPC, CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import { admitMissionCreationLocations } from "./mission-creation-admission"

export type MissionMapMutationManager = Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceConnection"
  | "ownsLocation" | "getServiceDirectoryForPath" | "getWorktreeIdentityForPath">

export class MissionMapMutationError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 503, message: string) { super(message) }
}

/** Update/control/delete/recovery follow creation's workspace authority: the
 * fenced shared connection, the owned service directory and a worktree-deletion
 * permit held until the awaited operation settles or transferred to its exact
 * scheduled-request hold. Every
 * asynchronous read is followed by a fresh workspace/connection/location check
 * before dispatch. Nothing here retries a mutation or falls back to another route. */
export async function prepareMissionMapMutation(input: {
  manager: MissionMapMutationManager; fence?: WorktreeDeletionFence; workspaceID: string
  directory?: string
  signal: AbortSignal; wait?<T>(operation: Promise<T>): Promise<T>
}) {
  const { manager, workspaceID, signal } = input
  const wait = input.wait ?? (<T>(operation: Promise<T>) => operation)
  signal.throwIfAborted()
  const workspace = manager.get(workspaceID), base = manager.getServiceLocation(workspaceID)
  if (!workspace || !base) throw new MissionMapMutationError(404, "Workspace unavailable")
  if (!input.fence) throw new MissionMapMutationError(503, "Mission plugin unavailable")
  let connection: ServiceConnection | undefined
  try { connection = await wait(manager.getSharedServiceConnection(workspaceID)) }
  catch { throw new MissionMapMutationError(503, "Mission plugin unavailable") }
  if (!connection) throw new MissionMapMutationError(503, "Mission plugin unavailable")
  const client = connection.client
  const unchanged = () => {
    signal.throwIfAborted(); connection.assertCurrent()
    const current = manager.getServiceLocation(workspaceID)
    if (manager.get(workspaceID) !== workspace || !current || !sameLocation(current, base)) {
      throw new MissionMapMutationError(409, "Mission workspace changed")
    }
  }
  if (input.directory !== undefined && (!input.directory || input.directory.length > 4096 || input.directory.includes("\0"))) {
    throw new MissionMapMutationError(403, "Mission directory is invalid")
  }
  const requested = input.directory ? { directory: input.directory } : base
  if (!await wait(manager.ownsLocation(workspaceID, requested, client, signal))) {
    throw new MissionMapMutationError(403, "Mission directory does not belong to workspace")
  }
  const directory = await wait(manager.getServiceDirectoryForPath(workspaceID, requested.directory))
  if (!directory) throw new MissionMapMutationError(503, "Mission plugin unavailable")
  const location = { directory }, options = { location, ...locationRequestOptions(location) }
  try {
    const resolved = await wait(client.location.get({ location }, { ...locationRequestOptions(location), signal }))
    if (!sameLocation(location, resolved) || !await wait(manager.ownsLocation(workspaceID, resolved, client, signal))) {
      throw new MissionMapMutationError(403, "Native mission location differs from owned directory")
    }
    const inventory = await wait(client.plugin.list({ location }, { ...locationRequestOptions(location), signal }))
    if (!inventory.data.some(entry => entry.id === CODENOMAD_MISSIONS_RPC_ID && entry.state.status === "active")) {
      throw new MissionMapMutationError(503, "Mission plugin unavailable")
    }
  } catch (error) {
    if (error instanceof MissionMapMutationError) throw error
    throw new MissionMapMutationError(503, "Mission plugin unavailable")
  }
  unchanged()
  let admission: Awaited<ReturnType<typeof admitMissionCreationLocations>>
  try { admission = await admitMissionCreationLocations(manager, input.fence, workspaceID, connection, [location], signal) }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "worktree-deleting") throw new MissionMapMutationError(409, "Worktree deletion is in progress")
    throw new MissionMapMutationError(409, "Mission workspace changed")
  }
  const missions = client.rpc(CODENOMAD_MISSIONS_RPC)
  let claimed = false
  let retained = false
  return {
    client,
    connection,
    workspace,
    base,
    location,
    current: unchanged,
    async refresh() { await admission.assertCurrent(); unchanged() },
    /** Transfer this exact permit to a synchronous scheduled-request hold.
     * A failed registration leaves ordinary run/finally ownership unchanged. */
    retain(register: (release: () => void) => undefined) {
      if (!claimed || retained) throw new Error("Mission permit retention unavailable")
      register(admission.release)
      retained = true
    },
    /** One owned operation. Multi-phase callers refresh authority before each
     * RPC; the permit stays held until completion and mutations are never raced. */
    async run<T>(call: (rpc: typeof missions, rpcOptions: typeof options) => Promise<T>): Promise<T> {
      if (claimed) throw new Error("Mission mutation already dispatched")
      claimed = true
      try {
        try { await admission.assertCurrent(); unchanged() }
        catch { throw new MissionMapMutationError(409, "Mission workspace changed") }
        return await call(missions, options)
      } finally { if (!retained) admission.release() }
    },
  }
}
