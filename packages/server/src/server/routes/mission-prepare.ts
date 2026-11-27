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
import { automaticMissionStartID, recoveredPreparation, type PreparationResult } from "../../missions/preparation-result"
import { prepareMissionMapMutation } from "./mission-map-mutation"
import { missionPreparationOptionsSchema, normalizedPreparationOptions } from "../../missions/preparation-input"
import { prepareScheduledCoordinatorMission, type ScheduledPreparationDeps } from "./mission-prepare-scheduled"
import type { ScheduledMissionManager } from "./mission-scheduled-admission"
import type { SessionPermissionModes } from "../../permissions/session-mode"

const commandSchema = z.object({ kind: z.literal("prepare"), input: z.object({
  missionID: z.string().min(1).max(100).optional(), requestID: z.string().min(1).max(128),
  objective: z.string().min(1).max(20_000), title: z.string().min(1).max(MISSION_TITLE_MAX).optional(),
  notes: z.string().max(20_000).optional(), template: missionCreationTemplateSchema,
  profiles: missionProfilesInputSchema, taskMode: missionTaskModeInputSchema.optional(),
  creationDefaults: z.unknown().optional(),
  startOnCreation: z.boolean().optional(),
  observeOnly: z.literal(true).optional(),
  ...missionPreparationOptionsSchema.shape,
}).strict() }).strict()

type Manager = MissionCreationPipelineManager & Pick<WorkspaceManager, "list">
  & Partial<Pick<WorkspaceManager, "getServiceWslDistro" | "getServicePathStyle">>

/** Fresh creation alone may continue the explicit first-Play intention.
 * Native lifecycle consumes it durably before any effect. */
export async function prepareCoordinatorMission(manager: Manager, fence: WorktreeDeletionFence, coordinatorID: string, command: unknown,
  signal: AbortSignal, scheduled: ScheduledPreparationDeps = {}, permissionModes?: SessionPermissionModes): Promise<PreparationResult> {
  const { input } = commandSchema.parse(command)
  const options = normalizedPreparationOptions(input)
  if (options.kind === "one-time" && options.coordinatorSessionID) throw refusal("prepare-refused")
  let creation: Awaited<ReturnType<typeof prepareMissionCreation>> | undefined
  try {
    if (hasMissionPreparationHold(fence, input.requestID)) throw refusal("prepare-uncertain")
    const owners = await Promise.allSettled(manager.list().map(async workspace => {
      const connection = await manager.getSharedServiceConnection(workspace.id)
      if (!connection) throw new Error("Workspace unavailable")
      const coordinator = await connection.client.session.get({ sessionID: coordinatorID }, { signal })
      if (coordinator.id !== coordinatorID
        || !await manager.ownsLocation(workspace.id, coordinator.location, connection.client)) throw new Error("Foreign coordinator")
      return { connection, workspace, coordinator }
    }))
    const owned = owners.flatMap(result => result.status === "fulfilled" ? [result.value] : [])
    if (new Set(owned.map(owner => owner.connection)).size !== 1) throw refusal("prepare-refused")
    const owner = owned[0]
    const { connection, workspace, coordinator } = owner
    const snapshot = await connection.client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, {
      location: { directory: coordinator.location.directory }, ...locationRequestOptions(coordinator.location), signal,
    }) as MissionSnapshot
    const get = (sessionID: string) => connection.client.session.get({ sessionID }, { signal })
    const source = await missionPreparationSource(snapshot, coordinator, get)
    if (source?.id !== input.missionID && !(input.observeOnly && options.kind === "schedule")) {
      throw refusal("prepare-refused")
    }
    if (options.kind === "schedule") {
      if (!manager.getServiceWslDistro) throw refusal("prepare-refused")
      return prepareScheduledCoordinatorMission({ manager: manager as ScheduledMissionManager, fence, workspaceID: workspace.id,
        authorSessionID: coordinatorID, input: { ...input, creationDefaults: input.creationDefaults === undefined
          ? undefined : parseMissionCreationDefaults(input.template, input.creationDefaults) }, signal, ...scheduled })
    }
    creation = await prepareMissionCreation({ manager, fence, workspaceID: workspace.id, signal, permissionModes,
      expectedProjectID: coordinator.projectID, preparedBy: { ...(source ? { missionID: source.id } : {}), coordinatorSessionID: coordinatorID },
      startOnCreation: input.startOnCreation === true,
      ...(options.watchedConversationIDs.length ? { preparationOptions: { watchedConversationIDs: options.watchedConversationIDs } } : {}),
      ...(input.creationDefaults === undefined ? {} : { creationDefaults: parseMissionCreationDefaults(input.template, input.creationDefaults) }),
      request: { requestId: input.requestID, objective: input.objective, template: input.template, directory: coordinator.location.directory,
        ...(input.title === undefined ? {} : { title: input.title }), ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.profiles === undefined ? {} : { profiles: input.profiles }), ...(input.taskMode === undefined ? {} : { taskMode: input.taskMode }),
        ...(options.coordinatorGoal ? { coordinatorGoal: true } : {}) } })
    const created = await creation.execute(async () => {
      const fresh = await connection.client.session.get({ sessionID: coordinatorID }, { signal })
      const freshSnapshot = await connection.client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, {
        location: { directory: coordinator.location.directory }, ...locationRequestOptions(coordinator.location), signal,
      }) as MissionSnapshot
      if (fresh.id !== coordinatorID || !sameLocation(fresh.location, coordinator.location)
        || (await missionPreparationSource(freshSnapshot, fresh, get))?.id !== source?.id) throw refusal("prepare-refused")
      connection.assertCurrent()
       return () => { signal.throwIfAborted(); connection.assertCurrent() }
     })
    const target = { kind: "one-time" as const, mission: created.mission }
    if (created.acknowledgement === "recovered") return recoveredPreparation(created.mission)
    if (!input.startOnCreation) return { outcome: "prepared", acknowledgement: "fresh", target }
    const requestID = automaticMissionStartID(input.requestID)
    try {
      const document = created.mission.document
      if (!document || document.firstPlay || document.automaticStart?.requestID !== requestID || document.automaticStart.attempted)
        throw new Error("Original creation start evidence unavailable")
      const mutation = await prepareMissionMapMutation({ manager, fence, workspaceID: workspace.id,
        directory: coordinator.location.directory, signal })
      const result = await mutation.run(async (rpc, options) => rpc.lifecycle({ missionID: created.mission.id,
        requestID, action: "start", expectedRevision: created.mission.revision,
        automaticStart: { creationRequestID: input.requestID, authorSessionID: coordinatorID,
          expectedDocumentRevision: document.revision },
      }, options)) as { mission: MissionMap }
      if (result.mission?.id !== created.mission.id || result.mission.document?.firstPlay?.requestID !== requestID
        || result.mission.document.firstPlay.admittedAt === null) throw new Error("Automatic start acknowledgement unavailable")
      return { outcome: "activated", acknowledgement: "fresh", target: { kind: "one-time", mission: result.mission } }
    } catch (error) {
      const code = readMissionMutationError(error)?.code
      if (code && ["revision-conflict", "control-conflict", "prepare-refused"].includes(code))
        return { outcome: "refused", phase: "start", code, target }
      return { outcome: "uncertain", phase: "start", requestID, missionID: created.mission.id, target }
    }
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
