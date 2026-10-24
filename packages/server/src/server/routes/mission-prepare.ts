import { z } from "zod"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import type { MissionMap, MissionSnapshot } from "../../missions/model"
import { MissionControlError } from "../../missions/control-error"
import { readMissionMutationError } from "../../missions/rpc-errors"
import { missionProfilesInputSchema } from "../../missions/playbook-profiles"
import { missionTaskModeInputSchema } from "../../missions/task-execution-mode"
import { MISSION_TITLE_MAX } from "../../missions/mission-title"
import { locationRequestOptions } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { prepareMissionCreation, type MissionCreationPipelineManager } from "./mission-creation-pipeline"
import { MissionCreationHoldError } from "./mission-creation-holds"

const commandSchema = z.object({ kind: z.literal("prepare"), input: z.object({
  missionID: z.string().min(1).max(100), requestID: z.string().min(1).max(128),
  objective: z.string().min(1).max(20_000), title: z.string().min(1).max(MISSION_TITLE_MAX).optional(),
  notes: z.string().max(20_000).optional(), template: z.enum(["custom", "wayfinder", "debug", "delivery", "compare"]),
  profiles: missionProfilesInputSchema, taskMode: missionTaskModeInputSchema.optional(),
}).strict() }).strict()

type Manager = MissionCreationPipelineManager & Pick<WorkspaceManager, "list">

/** A running coordinator's paused hand-off: the same prepared creation pipeline,
 * fences and holds as the UI editor, at the coordinator's own Location. Never Play. */
export async function prepareCoordinatorMission(manager: Manager, fence: WorktreeDeletionFence, coordinatorID: string, command: unknown,
  signal: AbortSignal): Promise<{ mission: MissionMap }> {
  const { input } = commandSchema.parse(command)
  const owner = await Promise.any(manager.list().map(async workspace => {
    const connection = await manager.getSharedServiceConnection(workspace.id)
    if (!connection) throw new Error("Workspace unavailable")
    const coordinator = await connection.client.session.get({ sessionID: coordinatorID }, { signal })
    if (coordinator.id !== coordinatorID || coordinator.parentID
      || !await manager.ownsLocation(workspace.id, coordinator.location, connection.client)) throw new Error("Foreign coordinator")
    return { connection, workspace, coordinator }
  })).catch(() => undefined)
  if (!owner) throw new Error("Missing mission owner")
  const { connection, workspace, coordinator } = owner
  const snapshot = await connection.client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, {
    location: { directory: coordinator.location.directory }, ...locationRequestOptions(coordinator.location), signal,
  }) as MissionSnapshot
  const source = snapshot.missions.find(mission => mission.id === input.missionID)
  if (!source || snapshot.projectID !== coordinator.projectID || source.coordinatorSessionId !== coordinatorID || source.status !== "active") {
    throw new MissionControlError("Only an active mission's coordinator may prepare a hand-off", "prepare-refused")
  }
  let creation: Awaited<ReturnType<typeof prepareMissionCreation>> | undefined
  try {
    creation = await prepareMissionCreation({ manager, fence, workspaceID: workspace.id, signal,
      expectedProjectID: coordinator.projectID, preparedBy: { missionID: source.id, coordinatorSessionID: coordinatorID },
      request: { requestId: input.requestID, objective: input.objective, template: input.template, directory: coordinator.location.directory,
        ...(input.title === undefined ? {} : { title: input.title }), ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.profiles === undefined ? {} : { profiles: input.profiles }), ...(input.taskMode === undefined ? {} : { taskMode: input.taskMode }) } })
    return await creation.execute()
  } catch (error) {
    if (!creation?.dispatched && error instanceof Error && error.message.startsWith("compare-models-"))
      throw new MissionControlError(error.message, "prepare-refused")
    // An earlier uncertain attempt with this identity stays held: never claim nothing exists.
    if (error instanceof MissionCreationHoldError) {
      if (error.code === "creation-conflict") throw new MissionControlError("This requestID already prepared a different mission", "prepare-conflict")
      if (error.code === "creation-uncertain") throw new MissionControlError("The prepared mission's outcome is uncertain; retry with the same requestID", "prepare-uncertain")
    }
    // Only a refusal before the native create proves nothing was created.
    const code = readMissionMutationError(error)?.code
    if (!creation?.dispatched || code === "mission-limit") throw new MissionControlError("The mission could not be prepared; nothing was created", "prepare-refused")
    if (code === "request-conflict") {
      throw new MissionControlError("This requestID already prepared a different mission", "prepare-conflict")
    }
    throw new MissionControlError("The prepared mission's outcome is uncertain; retry with the same requestID", "prepare-uncertain")
  } finally { creation?.dispose() }
}
