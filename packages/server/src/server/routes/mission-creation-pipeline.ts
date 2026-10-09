import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { CODENOMAD_MISSIONS_RPC, CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import type { MissionMap } from "../../missions/model"
import { stableToken } from "../../missions/journal"
import { isMissionCreateNoEffectError } from "../../missions/rpc-errors"
import { missionProfilesInputSchema, sameMissionProfiles, validateMissionProfiles } from "../../missions/playbook-profiles"
import { missionTaskModeInputSchema } from "../../missions/task-execution-mode"
import { MISSION_TITLE_MAX, MISSION_TITLE_PATTERN } from "../../missions/mission-title"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import { admitMissionCreationLocations } from "./mission-creation-admission"
import { MissionCreationHoldError, missionCreationDigest } from "./mission-creation-holds"

export const missionCreationRequestSchema = z.object({
  objective: z.string().trim().min(1).max(20_000), title: z.string().trim().min(1).max(MISSION_TITLE_MAX).regex(MISSION_TITLE_PATTERN).optional(), notes: z.string().max(20_000).optional(),
  template: z.enum(["custom", "wayfinder", "pocock-fix-bug"]), coordinatorSessionId: z.string().trim().min(1).max(240).optional(),
  directory: z.string().trim().min(1).max(4_096).optional(), requestId: z.string().trim().min(1).max(128),
  profiles: missionProfilesInputSchema, taskMode: missionTaskModeInputSchema.default("native"),
}).strict()

export type MissionCreationPipelineManager = Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceConnection"
  | "ownsLocation" | "getServiceDirectoryForPath" | "getWorktreeIdentityForPath">

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
}) {
  const { manager, workspaceID, signal } = input
  const wait = input.wait ?? (<T>(operation: Promise<T>) => operation)
  signal.throwIfAborted()
  const parsed = missionCreationRequestSchema.safeParse(input.request)
  if (!parsed.success) throw new MissionCreationPreparationError(400, "Invalid mission creation request")
  const request = parsed.data
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
  if (!await wait(manager.ownsLocation(workspaceID, location, client, signal))) {
    throw new MissionCreationPreparationError(403, "Mission directory does not belong to workspace")
  }
  const directory = await wait(manager.getServiceDirectoryForPath(workspaceID, location.directory))
  if (!directory) throw new MissionCreationPreparationError(503, "Mission plugin unavailable")
  location = { directory }
  const resolved = await wait(client.location.get({ location }, { ...locationRequestOptions(location), signal }))
  if (!sameLocation(location, resolved) || !await wait(manager.ownsLocation(workspaceID, resolved, client, signal))) {
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
  signal.throwIfAborted(); connection.assertCurrent()
  const locations = [location]
  if (request.coordinatorSessionId) {
    const coordinator = await wait(client.session.get({ sessionID: request.coordinatorSessionId }, { signal }))
    if (coordinator.id !== request.coordinatorSessionId || coordinator.parentID || coordinator.projectID !== projectID
      || !await wait(manager.ownsLocation(workspaceID, coordinator.location, client, signal))) {
      throw new MissionCreationPreparationError(403, "Coordinator session does not belong to workspace project")
    }
    locations.push(coordinator.location)
  }
  const missionID = `msn_${stableToken(`${projectID}\0${request.requestId}`, 24)}`
  const sessionID = request.coordinatorSessionId ?? `ses_${stableToken(`${missionID}\0coordinator`, 26)}`
  // Reserved identity seam only: prepared creation emits NO native message.
  // Same derivation as the durable recurrence passage, never a fresh retry ID.
  const creationMessageID = `msg_${stableToken(request.requestId, 28)}`
  const nativeInput = {
    prepared: true, requestID: request.requestId, objective: request.objective,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.notes === undefined ? {} : { notes: request.notes }), template: request.template, taskMode: request.taskMode,
    ...(request.profiles === undefined ? {} : { profiles: request.profiles }),
    ...(request.coordinatorSessionId ? { coordinatorSessionID: request.coordinatorSessionId } : {}),
    expectedCoordinatorLocation: locations.at(-1)!,
  }
  const admission = await admitMissionCreationLocations(manager, input.fence, workspaceID, connection, locations, signal, {
    key: `human:${projectID}:${missionID}`, workspaceID, projectID, missionID, sessionID, requestDigest: missionCreationDigest(nativeInput),
  })
  let disposed = false
  let executing = false
  const release = () => { if (!disposed) { disposed = true; admission.release() } }
  const dispose = () => { if (!executing) release() }
  const assertCurrent = async () => {
    if (disposed) throw new Error("Mission creation preparation was released")
    await admission.assertCurrent()
  }
  return {
    missionID, sessionID, creationMessageID, request: structuredClone(nativeInput), dispose,
    /** Internal protected composition may supply a fresh exact passage fence.
     * This is NOT a standing grant: recurrence never exposes execute until its
     * real protected grant and native first-effect enforcement are qualified. */
    async execute(beforeEffect?: () => Promise<() => void>): Promise<{ mission: MissionMap }> {
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
        admission.dispatched()
        // No cancellation race or signal after dispatch: transport rejection is
        // not a no-effect receipt. The original physical permit remains parked.
        let result: { mission: MissionMap }
        try { result = await client.rpc(CODENOMAD_MISSIONS_RPC).create(nativeInput,
          { location, ...locationRequestOptions(location) }) as { mission: MissionMap } }
        catch (error) {
          if (isMissionCreateNoEffectError(error, nativeInput.requestID, missionID)) admission.settled()
          throw error
        }
        const coordinator = result.mission?.actors?.find(actor => actor.sessionId === sessionID && actor.kind === "coordinator")
        if (result.mission?.id !== missionID || result.mission.projectID !== projectID
          || result.mission.coordinatorSessionId !== sessionID || !coordinator || result.mission.title !== nativeInput.title
          || !sameLocation(coordinator.location, nativeInput.expectedCoordinatorLocation)
          || !sameMissionProfiles(result.mission.profiles, nativeInput.profiles)
          || (result.mission.taskMode ?? "native") !== nativeInput.taskMode) throw new MissionCreationHoldError("creation-uncertain")
        admission.settled()
        await assertCurrent()
        return { mission: result.mission }
      } catch (error) {
        if (admission.uncertain) throw new MissionCreationHoldError("creation-uncertain")
        throw error
      } finally { release() }
    },
  }
}
