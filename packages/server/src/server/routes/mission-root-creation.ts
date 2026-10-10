import { z } from "zod"
import { isSessionNotFoundError } from "@opencode/client"
import { isDeepStrictEqual } from "node:util"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { MISSION_SCHEMA_VERSION, type MissionSnapshot } from "../../missions/model"
import { missionIsRunning } from "../../missions/lifecycle-model"
import { stableToken } from "../../missions/journal"
import { matchesExecution } from "../../missions/execution"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import { prepareMissionRootCreationLocation, type MissionCreationManager } from "./mission-creation-admission"
import { MissionCreationHoldError, missionCreationDigest } from "./mission-creation-holds"

const schema = z.object({ kind: z.literal("create-root"), input: z.object({
  missionID: z.string().min(1).max(100), taskKey: z.string().min(1).max(100),
}).strict() }).strict()
type Manager = MissionCreationManager & Pick<WorkspaceManager, "list" | "getSharedServiceConnection">

/** Narrow desktop creation capability. The caller supplies only a journal key:
 * native id/title/location/metadata/execution come from the published managed
 * dispatch intent, never from arbitrary plugin or frontend native API input. */
export async function createManagedMissionRoot(manager: Manager, fence: WorktreeDeletionFence,
  coordinatorID: string, command: unknown, signal: AbortSignal) {
  const { input } = schema.parse(command)
  signal.throwIfAborted()
  const owner = await Promise.any(manager.list().map(async workspace => {
    const connection = await manager.getSharedServiceConnection(workspace.id)
    signal.throwIfAborted()
    if (!connection) throw new Error("Workspace unavailable")
    const coordinator = await connection.client.session.get({ sessionID: coordinatorID }, { signal })
    if (coordinator.id !== coordinatorID || coordinator.parentID
      || !await manager.ownsLocation(workspace.id, coordinator.location, connection.client, signal)) throw new Error("Foreign coordinator")
    return { workspace, connection, coordinator }
  })).catch(() => undefined)
  if (!owner) throw new Error("Missing mission creation owner")
  const { workspace, connection, coordinator } = owner, client = connection.client
  const readContract = async () => {
    const current = await client.session.get({ sessionID: coordinatorID }, { signal })
    if (current.id !== coordinatorID || current.parentID || current.projectID !== coordinator.projectID
      || !sameLocation(current.location, coordinator.location)) throw new Error("Mission coordinator moved")
    const snapshot = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, {
      location: { directory: coordinator.location.directory }, ...locationRequestOptions(coordinator.location), signal,
    }) as MissionSnapshot
    const mission = snapshot.missions.find(item => item.id === input.missionID)
    const task = mission?.tasks.find(item => item.key === input.taskKey)
    const actor = mission?.actors.find(item => item.sessionId === task?.actorSessionId)
    if (snapshot.projectID !== coordinator.projectID || !mission || mission.coordinatorSessionId !== coordinatorID
      || !missionIsRunning(mission) || mission.control?.pending.length || task?.status !== "dispatching"
      || !actor?.managed || actor.kind === "coordinator" || !sameLocation(actor.location, coordinator.location)
      || actor.sessionId !== `ses_${stableToken(`${mission.id}\0task\0${task.id}`, 26)}`) throw new Error("Foreign managed root contract")
    return { actor, task }
  }
  const contract = await readContract()
  const { admission, assertCurrent, effect, location } = await prepareMissionRootCreationLocation({
    manager, fence, workspaceID: workspace.id, connection, projectID: coordinator.projectID,
    locations: [coordinator.location, contract.actor.location], rootLocation: contract.actor.location, signal,
    assertContract: async () => {
      if (!isDeepStrictEqual(await readContract(), contract)) throw new Error("Managed root contract changed")
    }, operation: {
      key: `managed:${coordinator.projectID}:${input.missionID}:${input.taskKey}`, workspaceID: workspace.id,
      projectID: coordinator.projectID, missionID: input.missionID, sessionID: contract.actor.sessionId,
      requestDigest: missionCreationDigest({ coordinatorID, input, contract }),
    },
  })
  try {
    const nativeInput = {
      id: contract.actor.sessionId, title: contract.actor.title || `Mission · ${contract.task.role}: ${contract.task.title}`,
      location,
      metadata: { "codenomad.mission": { version: MISSION_SCHEMA_VERSION, missionID: input.missionID,
        kind: "actor", role: contract.task.role } }, ...contract.task.execution,
    }
    await assertCurrent()
    // A previously proved create whose later prompt failed may be reused. An
    // uncertain registration rejects BEFORE this lookup; even a positive lookup
    // must not consume that hold or manufacture terminal-settlement evidence.
    let session
    try { session = await client.session.get({ sessionID: nativeInput.id }, { signal }) }
    catch (error) {
      if (!isSessionNotFoundError(error)) throw error
      // No abort race after dispatch. Transport rejection parks this SAME permit;
      // it is not a receipt that the already-received remote handler stopped.
      session = await effect(() => client.session.create(nativeInput))
    }
    if (session.id !== nativeInput.id || session.parentID || session.projectID !== coordinator.projectID
      || !sameLocation(session.location, nativeInput.location) || !matchesExecution(contract.task.execution, session)
      || !isDeepStrictEqual(session.metadata?.["codenomad.mission"], nativeInput.metadata["codenomad.mission"])) {
      throw new Error("Native creation returned a foreign root")
    }
    admission.settled()
    // Actor publication precedes this native create. Reconcile that exact durable
    // dispatch intent while admission is STILL held, not at eventual prompt time.
    await assertCurrent()
    return session
  } catch (error) {
    if (admission.uncertain) throw new MissionCreationHoldError("creation-uncertain")
    throw error
  } finally { admission.release() }
}
