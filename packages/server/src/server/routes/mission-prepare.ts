import { z } from "zod"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import type { MissionMap, MissionSnapshot } from "../../missions/model"
import { isMissionCreateNoEffectError, readMissionMutationError } from "../../missions/rpc-errors"
import { missionProfilesInputSchema } from "../../missions/playbook-profiles"
import { missionTaskModeInputSchema } from "../../missions/task-execution-mode"
import { MISSION_TITLE_MAX } from "../../missions/mission-title"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { prepareMissionCreation, type MissionCreationPipelineManager } from "./mission-creation-pipeline"
import { hasMissionPreparationHold, MissionCreationHoldError } from "./mission-creation-holds"
import { missionCreationTemplateSchema, parseMissionCreationDefaults } from "../../missions/creation-defaults"
import { missionRecoveryControlError as refusal, missionRecoveryRejection } from "../../missions/recovery-error"
import { missionPreparationSource } from "../../missions/coordinator-actions"

const commandSchema = z.object({ kind: z.literal("prepare"), input: z.object({
  missionID: z.string().min(1).max(100).optional(), requestID: z.string().min(1).max(128),
  objective: z.string().min(1).max(20_000), title: z.string().min(1).max(MISSION_TITLE_MAX).optional(),
  notes: z.string().max(20_000).optional(), template: missionCreationTemplateSchema,
  profiles: missionProfilesInputSchema, taskMode: missionTaskModeInputSchema.optional(),
  creationDefaults: z.unknown().optional(),
}).strict() }).strict()

type Manager = MissionCreationPipelineManager & Pick<WorkspaceManager, "list">

/** An owned ordinary root or active coordinator's paused hand-off, at its own
 * Location, using the editor's creation pipeline, fences and holds. Never Play. */
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
    const source = missionPreparationSource(snapshot, coordinator)
    if (source?.id !== input.missionID) {
      throw refusal("prepare-refused")
    }
    creation = await prepareMissionCreation({ manager, fence, workspaceID: workspace.id, signal,
      expectedProjectID: coordinator.projectID, preparedBy: { ...(source ? { missionID: source.id } : {}), coordinatorSessionID: coordinatorID },
      ...(input.creationDefaults === undefined ? {} : { creationDefaults: parseMissionCreationDefaults(input.template, input.creationDefaults) }),
      request: { requestId: input.requestID, objective: input.objective, template: input.template, directory: coordinator.location.directory,
        ...(input.title === undefined ? {} : { title: input.title }), ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.profiles === undefined ? {} : { profiles: input.profiles }), ...(input.taskMode === undefined ? {} : { taskMode: input.taskMode }) } })
    return await creation.execute(async () => {
      const fresh = await connection.client.session.get({ sessionID: coordinatorID }, { signal })
      const freshSnapshot = await connection.client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, {
        location: { directory: coordinator.location.directory }, ...locationRequestOptions(coordinator.location), signal,
      }) as MissionSnapshot
      if (fresh.id !== coordinatorID || !sameLocation(fresh.location, coordinator.location)
        || missionPreparationSource(freshSnapshot, fresh)?.id !== source?.id) throw refusal("prepare-refused")
      connection.assertCurrent()
      return () => { signal.throwIfAborted(); connection.assertCurrent() }
    })
  } catch (error) {
    if (creation && isMissionCreateNoEffectError(error, input.requestID, creation.missionID))
      throw refusal("prepare-no-effect")
    if (hasMissionPreparationHold(fence, input.requestID)) throw refusal("prepare-uncertain")
    if (missionRecoveryRejection(error)) throw error
    if (!creation?.dispatched && error instanceof Error) {
      if (error.message === "compare-models-required") throw refusal("compare-models-required")
      if (error.message === "compare-models-identical") throw refusal("compare-models-identical")
    }
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
