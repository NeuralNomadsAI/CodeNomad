import { z } from "zod"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import type { MissionMap, MissionSnapshot } from "../../missions/model"
import { MissionControlError } from "../../missions/control-error"
import { isMissionCreateNoEffectError, readMissionMutationError } from "../../missions/rpc-errors"
import { missionProfilesInputSchema } from "../../missions/playbook-profiles"
import { missionTaskModeInputSchema } from "../../missions/task-execution-mode"
import { MISSION_TITLE_MAX } from "../../missions/mission-title"
import { locationRequestOptions } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { prepareMissionCreation, type MissionCreationPipelineManager } from "./mission-creation-pipeline"
import { hasMissionPreparationHold, MissionCreationHoldError } from "./mission-creation-holds"
import { missionCreationTemplateSchema, parseMissionCreationDefaults } from "../../missions/creation-defaults"
import { missionRecoveryError, missionRecoveryRejection } from "../../missions/recovery-error"

const commandSchema = z.object({ kind: z.literal("prepare"), input: z.object({
  missionID: z.string().min(1).max(100), requestID: z.string().min(1).max(128),
  objective: z.string().min(1).max(20_000), title: z.string().min(1).max(MISSION_TITLE_MAX).optional(),
  notes: z.string().max(20_000).optional(), template: missionCreationTemplateSchema,
  profiles: missionProfilesInputSchema, taskMode: missionTaskModeInputSchema.optional(),
  creationDefaults: z.unknown().optional(),
}).strict() }).strict()

type Manager = MissionCreationPipelineManager & Pick<WorkspaceManager, "list">

function refusal(code: "prepare-refused" | "prepare-no-effect" | "prepare-conflict" | "prepare-uncertain"): MissionControlError {
  const error = missionRecoveryError(code)!
  return new MissionControlError(error.message, error.code)
}

/** A running coordinator's paused hand-off: the same prepared creation pipeline,
 * fences and holds as the UI editor, at the coordinator's own Location. Never Play. */
export async function prepareCoordinatorMission(manager: Manager, fence: WorktreeDeletionFence, coordinatorID: string, command: unknown,
  signal: AbortSignal): Promise<{ mission: MissionMap }> {
  const { input } = commandSchema.parse(command)
  let creation: Awaited<ReturnType<typeof prepareMissionCreation>> | undefined
  try {
    if (hasMissionPreparationHold(fence, input.requestID)) throw refusal("prepare-uncertain")
    const owner = await Promise.any(manager.list().map(async workspace => {
      const connection = await manager.getSharedServiceConnection(workspace.id)
      if (!connection) throw new Error("Workspace unavailable")
      const coordinator = await connection.client.session.get({ sessionID: coordinatorID }, { signal })
      if (coordinator.id !== coordinatorID || coordinator.parentID
        || !await manager.ownsLocation(workspace.id, coordinator.location, connection.client)) throw new Error("Foreign coordinator")
      return { connection, workspace, coordinator }
    })).catch(() => undefined)
    if (!owner) throw refusal("prepare-refused")
    const { connection, workspace, coordinator } = owner
    const snapshot = await connection.client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, {
      location: { directory: coordinator.location.directory }, ...locationRequestOptions(coordinator.location), signal,
    }) as MissionSnapshot
    const source = snapshot.missions.find(mission => mission.id === input.missionID)
    if (!source || snapshot.projectID !== coordinator.projectID || source.coordinatorSessionId !== coordinatorID || source.status !== "active") {
      throw refusal("prepare-refused")
    }
    creation = await prepareMissionCreation({ manager, fence, workspaceID: workspace.id, signal,
      expectedProjectID: coordinator.projectID, preparedBy: { missionID: source.id, coordinatorSessionID: coordinatorID },
      ...(input.creationDefaults === undefined ? {} : { creationDefaults: parseMissionCreationDefaults(input.template, input.creationDefaults) }),
      request: { requestId: input.requestID, objective: input.objective, template: input.template, directory: coordinator.location.directory,
        ...(input.title === undefined ? {} : { title: input.title }), ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.profiles === undefined ? {} : { profiles: input.profiles }), ...(input.taskMode === undefined ? {} : { taskMode: input.taskMode }) } })
    return await creation.execute()
  } catch (error) {
    if (creation && isMissionCreateNoEffectError(error, input.requestID, creation.missionID))
      throw refusal("prepare-no-effect")
    if (hasMissionPreparationHold(fence, input.requestID)) throw refusal("prepare-uncertain")
    if (missionRecoveryRejection(error)) throw error
    if (!creation?.dispatched && error instanceof Error && error.message.startsWith("compare-models-"))
      throw new MissionControlError(error.message, error.message)
    // An earlier uncertain attempt with this identity stays held: never claim nothing exists.
    if (error instanceof MissionCreationHoldError) {
      if (error.code === "creation-conflict") throw refusal("prepare-conflict")
      if (error.code === "creation-uncertain") throw refusal("prepare-uncertain")
    }
    // Only a refusal before the native create proves nothing was created.
    const code = readMissionMutationError(error)?.code
    if (!creation?.dispatched) throw refusal("prepare-refused")
    if (code === "request-conflict") {
      throw refusal("prepare-conflict")
    }
    throw refusal("prepare-uncertain")
  } finally { creation?.dispose() }
}
