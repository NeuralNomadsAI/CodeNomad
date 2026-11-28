import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { CODENOMAD_MISSIONS_RPC, CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import type { MissionMap } from "../../missions/model"
import { stableToken } from "../../missions/journal"
import { isMissionCoordinatorSession } from "../../missions/session-identity"
import { isMissionCreateNoEffectError } from "../../missions/rpc-errors"
import { compareModelError, freezeCompareProfiles, missionProfilesInputSchema, sameMissionProfiles, validateMissionProfiles } from "../../missions/playbook-profiles"
import { missionTaskModeInputSchema } from "../../missions/task-execution-mode"
import { MISSION_TITLE_MAX, MISSION_TITLE_PATTERN } from "../../missions/mission-title"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import { admitMissionCreationLocations } from "./mission-creation-admission"
import { MissionCreationHoldError, missionCreationDigest } from "./mission-creation-holds"
import type { MissionCreationMetadata } from "../../missions/creation-defaults"
import { nativeDocumentID } from "../../missions/launch-policy"
import type { MissionPanelMap } from "../../missions/mission-panel-map"
import type { MissionPreparationOptions } from "../../missions/preparation-input"
import type { SessionPermissionModes } from "../../permissions/session-mode"
import { sessionPermissionTarget } from "./session-permission-mode"

export const missionCreationRequestSchema = z.object({
  objective: z.string().trim().min(1).max(20_000), title: z.string().trim().min(1).max(MISSION_TITLE_MAX).regex(MISSION_TITLE_PATTERN).optional(), notes: z.string().max(20_000).optional(),
  template: z.enum(["custom", "wayfinder", "debug", "delivery", "compare"]), coordinatorSessionId: z.string().trim().min(1).max(240).optional(),
  directory: z.string().trim().min(1).max(4_096).optional(), requestId: z.string().trim().min(1).max(128),
  profiles: missionProfilesInputSchema, taskMode: missionTaskModeInputSchema.optional(),
  coordinatorGoal: z.boolean().optional(),
  watchedConversationIDs: z.array(nativeDocumentID).max(32).refine(ids => new Set(ids).size === ids.length).optional(),
}).strict()

export type MissionCreationPipelineManager = Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceConnection"
  | "ownsLocation" | "getServiceDirectoryForPath" | "getWorktreeIdentityForPath">
  & Partial<Pick<WorkspaceManager, "getServiceWslDistro">>

export class MissionCreationPreparationError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 503, message: string) { super(message) }
}

/** One preparation and one prepared-map RPC. Both ordinary HTTP creation and
 * unactivated recurrence preparation use this implementation, not injected
 * creation callbacks. The native RPC retains catalog/execution/journal policy.
 * No Play, environment write or model message is part of prepared creation. */
export async function prepareMissionCreation(input: {
  manager: MissionCreationPipelineManager; fence?: WorktreeDeletionFence; workspaceID: string
  request: unknown; signal: AbortSignal; wait?<T>(operation: Promise<T>): Promise<T>
  /** Trusted expected project for protected composition, never HTTP input. */
  expectedProjectID?: string
  /** Trusted author session and optional source mission from the authenticated plugin bridge. */
  preparedBy?: { missionID?: string; coordinatorSessionID: string }
  creationDefaults?: MissionCreationMetadata
  startOnCreation?: boolean
  preparationOptions?: MissionPreparationOptions
  permissionModes?: SessionPermissionModes
}) {
  const { manager, workspaceID, signal } = input
  const wait = input.wait ?? (<T>(operation: Promise<T>) => operation)
  signal.throwIfAborted()
  const parsed = missionCreationRequestSchema.safeParse(input.request)
  if (!parsed.success) throw new MissionCreationPreparationError(400, "Invalid mission creation request")
  const request = parsed.data
  const compareError = request.template === "compare" && compareModelError(request.profiles)
  if (compareError) throw new MissionCreationPreparationError(400, compareError)
  if (!input.creationDefaults) request.profiles = freezeCompareProfiles(request.template, request.profiles)
  try { validateMissionProfiles(request.template, request.profiles) }
  catch { throw new MissionCreationPreparationError(400, "Invalid mission creation request") }
  if (!input.fence) throw new MissionCreationPreparationError(503, "Mission creation unavailable")
  if (!manager.get(workspaceID)) throw new MissionCreationPreparationError(404, "Workspace unavailable")
  const base = manager.getServiceLocation(workspaceID)
  if (!base) throw new MissionCreationPreparationError(404, "Workspace unavailable")
  const connection = await wait(manager.getSharedServiceConnection(workspaceID))
  if (!connection) throw new MissionCreationPreparationError(503, "Mission plugin unavailable")
  const client = connection.client
  let location = request.directory ? { directory: request.directory } : base
  if (!await wait(manager.ownsLocation(workspaceID, location, client, { signal }))) {
    throw new MissionCreationPreparationError(403, "Mission directory does not belong to workspace")
  }
  const directory = await wait(manager.getServiceDirectoryForPath(workspaceID, location.directory))
  if (!directory) throw new MissionCreationPreparationError(503, "Mission plugin unavailable")
  location = { directory }
  const resolved = await wait(client.location.get({ location }, { ...locationRequestOptions(location), signal }))
  if (!sameLocation(location, resolved) || !await wait(manager.ownsLocation(workspaceID, resolved, client, { signal }))) {
    throw new MissionCreationPreparationError(403, "Native mission location differs from owned directory")
  }
  const baseResolved = await wait(client.location.get({ location: { directory: base.directory } }, { ...locationRequestOptions(base), signal }))
  const projectID = resolved.project.id
  if (projectID !== baseResolved.project.id || input.expectedProjectID !== undefined && projectID !== input.expectedProjectID) {
    throw new MissionCreationPreparationError(403, "Mission directory belongs to another project")
  }
  const inventory = await wait(client.plugin.list({ location }, { ...locationRequestOptions(location), signal }))
  if (!inventory.data.some(entry => entry.id === CODENOMAD_MISSIONS_RPC_ID && entry.state.status === "active")) {
    throw new MissionCreationPreparationError(503, "Mission plugin unavailable")
  }
  let supportsRootPermissions = false
  try {
    const capability = await wait(client.rpc(CODENOMAD_MISSIONS_RPC).documentCapabilities({}, { location, ...locationRequestOptions(location), signal }))
    const parsed = z.object({ version: z.literal(1), automaticStart: z.literal(true).optional(), rootPermissions: z.literal(true).optional(),
      agentSchedulePreparation: z.literal(true).optional(), agentScheduleControl: z.literal(true).optional() }).strict().parse(capability)
    if (input.startOnCreation !== undefined && parsed.automaticStart !== true) throw new Error("Automatic start capability unavailable")
    // The caller will verify the created session as well. An older plugin must
    // refuse before it could create a root without the requested permissions.
    supportsRootPermissions = parsed.rootPermissions === true
  } catch { throw new MissionCreationPreparationError(503, "Unified Mission documents unavailable") }
  signal.throwIfAborted(); connection.assertCurrent()
  const locations = [location]
  if (request.coordinatorSessionId) {
    const coordinator = await wait(client.session.get({ sessionID: request.coordinatorSessionId }, { signal }))
    if (coordinator.id !== request.coordinatorSessionId || coordinator.parentID || coordinator.projectID !== projectID
      || !await wait(manager.ownsLocation(workspaceID, coordinator.location, client, { signal }))) {
      throw new MissionCreationPreparationError(403, "Coordinator session does not belong to workspace project")
    }
    locations.push(coordinator.location)
  }
  const missionID = `msn_${stableToken(`${projectID}\0${request.requestId}`, 24)}`
  // An attached coordinator is exact; a created one carries the plugin's creation time.
  const sessionID = request.coordinatorSessionId
  const isCoordinator = (id: string) => sessionID === undefined ? isMissionCoordinatorSession(id, missionID) : id === sessionID
  // Reserved identity seam only: prepared creation emits NO native message.
  // Same derivation as the durable recurrence passage, never a fresh retry ID.
  const creationMessageID = `msg_${stableToken(request.requestId, 28)}`
  const distro = manager.getServiceWslDistro?.(workspaceID)
  const permissions = request.coordinatorSessionId ? undefined : await wait(input.permissionModes?.newRootRules({
    client, location, distro, signal,
  }) ?? Promise.resolve(undefined))
  if (permissions && !supportsRootPermissions) throw new MissionCreationPreparationError(503, "Mission root permissions unavailable")
  const nativeInput = {
    prepared: true, requestID: request.requestId, objective: request.objective,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.notes === undefined ? {} : { notes: request.notes }), template: request.template, taskMode: request.taskMode ?? "native",
    ...(request.coordinatorGoal ? { coordinatorGoal: true } : {}),
    ...(request.profiles === undefined ? {} : { profiles: request.profiles }),
    ...(request.watchedConversationIDs === undefined ? {} : { watchedConversationIDs: request.watchedConversationIDs }),
    ...(input.creationDefaults === undefined ? {} : { creationDefaults: input.creationDefaults }),
    ...(request.coordinatorSessionId ? { coordinatorSessionID: request.coordinatorSessionId } : {}),
    expectedCoordinatorLocation: locations.at(-1)!,
    ...(input.preparedBy === undefined ? {} : { preparedBy: { ...input.preparedBy } }),
    ...(input.startOnCreation === undefined ? {} : { startOnCreation: input.startOnCreation }),
    ...(input.preparationOptions === undefined ? {} : { preparationOptions: input.preparationOptions }),
    ...(permissions ? { permissions } : {}),
  }
  const admission = await admitMissionCreationLocations(manager, input.fence, workspaceID, connection, locations, signal, {
    key: `human:${projectID}:${missionID}`, workspaceID, projectID, missionID, sessionID, requestDigest: missionCreationDigest(nativeInput),
  })
  let disposed = false
  let executing = false
  let dispatched = false
  let rejected = false
  const release = () => { if (!disposed) { disposed = true; admission.release() } }
  const dispose = () => { if (!executing) release() }
  const assertCurrent = async () => {
    if (disposed) throw new Error("Mission creation preparation was released")
    await admission.assertCurrent()
  }
  const confirmPermissions = async (id: string, recovering = false) => {
    if (!permissions) return
    const signal = AbortSignal.timeout(10_000)
    const session = await client.session.get({ sessionID: id }, { signal })
    if (session.id !== id || session.projectID !== projectID || !sameLocation(session.location, location)) {
      throw new MissionCreationHoldError("creation-uncertain")
    }
    await admission.assertReceiptCurrent()
    const modes = input.permissionModes!
    if (!recovering) {
      modes.confirmNewRoot(session, distro, permissions, [])
      return
    }
    const current = () => { signal.throwIfAborted(); connection.assertCurrent() }
    await modes.recoverNewRoot(sessionPermissionTarget(session, { client, distro, signal, current }), permissions)
  }
  return {
    missionID, sessionID, creationMessageID, request: structuredClone(nativeInput), dispose,
    async readReceipt(): Promise<MissionPanelMap | undefined> {
      // Reconcile in the captured native Location, never the workspace's current default.
      await admission.assertReceiptCurrent()
      const result = await client.rpc(CODENOMAD_MISSIONS_RPC).creationReceipt(nativeInput,
        { location, ...locationRequestOptions(location), signal: AbortSignal.timeout(10_000) }) as { requestID: string; projectID: string; mission?: MissionPanelMap }
      await admission.assertReceiptCurrent()
      if (result.requestID !== request.requestId || result.projectID !== projectID || result.mission?.id !== missionID
        || result.mission.projectID !== projectID) return
      if (!isCoordinator(result.mission.coordinatorSessionId)) return
      const recoverPermissions = admission.uncertain
      admission.reconcile()
      // The durable receipt settles creation; current session rules only establish block ownership.
      if (recoverPermissions) await confirmPermissions(result.mission.coordinatorSessionId, true).catch(() => {})
      return result.mission
    },
    /** False until the native create is attempted: any earlier failure proves no effect. */
    get dispatched() { return dispatched },
    get rejected() { return rejected },
    /** Internal protected composition may supply a fresh exact passage fence.
     * This is NOT a standing grant: recurrence never exposes execute until its
     * real protected grant and native first-effect enforcement are qualified. */
    async execute(beforeEffect?: () => Promise<() => void>): Promise<{ mission: MissionMap; acknowledgement: "fresh" | "recovered" }> {
      if (disposed) throw new Error("Mission creation preparation was released")
      if (executing) throw new Error("Mission creation execution already claimed")
      // Claim before the first await. Only this invocation may release its
      // permit; duplicate calls/external disposal cannot park a live owner.
      executing = true
      try {
        await assertCurrent()
        const current = await beforeEffect?.()
        signal.throwIfAborted(); connection.assertCurrent()
        if (current) assertSynchronousAuthorityGuard(() => {
          const result: unknown = current()
          return (result === undefined ? true : result) as true
        }, "policy-unqualified")
        dispatched = true
        admission.dispatched()
        // No cancellation race or signal after dispatch: transport rejection is
        // not a no-effect receipt. The original physical permit remains parked.
        let result: { mission: MissionMap; acknowledgement: "fresh" | "recovered" }
        try { result = await client.rpc(CODENOMAD_MISSIONS_RPC).create(nativeInput,
          { location, ...locationRequestOptions(location) }) as typeof result }
        catch (error) {
          if (isMissionCreateNoEffectError(error, nativeInput.requestID, missionID)) { rejected = true; admission.settled() }
          throw error
        }
        const coordinator = result.mission?.actors?.find(actor => actor.sessionId === result.mission.coordinatorSessionId && actor.kind === "coordinator")
        if (!["fresh", "recovered"].includes(result.acknowledgement) || result.mission?.id !== missionID || result.mission.projectID !== projectID
          || !isCoordinator(result.mission.coordinatorSessionId) || !coordinator || result.mission.title !== nativeInput.title
          || !sameLocation(coordinator.location, nativeInput.expectedCoordinatorLocation)
          || result.mission.preparedBy?.missionId !== input.preparedBy?.missionID
          || result.mission.preparedBy?.coordinatorSessionId !== input.preparedBy?.coordinatorSessionID
          || !sameMissionProfiles(result.mission.profiles, nativeInput.profiles)
          || (result.mission.taskMode ?? "native") !== nativeInput.taskMode) throw new MissionCreationHoldError("creation-uncertain")
        if (result.acknowledgement === "fresh") await confirmPermissions(result.mission.coordinatorSessionId)
        admission.settled()
        await assertCurrent()
        return result
      } catch (error) {
        if (admission.uncertain) throw new MissionCreationHoldError("creation-uncertain")
        throw error
      } finally { release() }
    },
  }
}
