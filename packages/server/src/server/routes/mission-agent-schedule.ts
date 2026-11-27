import { z } from "zod"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { scheduleToolInput } from "../../missions/schedule-tool"
import { requiresMissionCalendar } from "../../missions/launch-policy"
import type { MissionScheduleRead } from "../../missions/mission-schedule-view"
import type { MissionScheduleList } from "../../missions/mission-schedule-list"
import { ownedMissionAgent } from "./mission-agent-owner"
import { executeScheduledMission, type ScheduledMissionDeps } from "./mission-scheduled"
import type { ScheduledPreparationDeps } from "./mission-prepare-scheduled"
import { prepareMissionMapMutation } from "./mission-map-mutation"
import { missionScheduleActivationJournal } from "./mission-schedule-activation-journal"
import { prepareMissionScheduleSettings } from "./mission-schedule-settings"
import { scheduledMissionHold } from "./mission-scheduled-holds"
import type { WorkspaceManager } from "../../workspaces/manager"
import { readMissionScheduleCapability } from "./mission-schedule-list"
import { controlAgentMissionProgram } from "./mission-agent-program"
import type { MissionCalendarDeps } from "./mission-calendars"
import type { NativeScheduleCapabilityReader } from "../../opencode/native-schedule-capability"

const commandSchema = z.object({ kind: z.literal("schedule"), input: scheduleToolInput }).strict()
type Deps = ScheduledMissionDeps & Pick<ScheduledPreparationDeps, "scheduleSettingsActivation">
  & { workspaceManager: ScheduledMissionDeps["workspaceManager"] & Pick<WorkspaceManager, "list">;
    scheduleCapability?: Pick<NativeScheduleCapabilityReader, "read"> } & Pick<MissionCalendarDeps, "permissionModes">

/** Private bridge entry: native caller identity, never an HTTP-supplied principal. */
export async function controlAgentMissionSchedule(deps: Deps, sessionID: string, command: unknown, signal: AbortSignal) {
  const program = (command as { input?: { program?: unknown } } | null)?.input?.program
  if (program !== undefined) return controlAgentMissionProgram(deps as never, sessionID, program, signal)
  const { input } = commandSchema.parse(command), manager = deps.workspaceManager
   if (!deps.worktreeDeletionFence) throw new Error("Mission schedule owner unavailable")
   const agent = await ownedMissionAgent(manager, sessionID, signal)
   const { client, workspace, session, current, refresh, options } = agent
  const rpc = client.rpc(CODENOMAD_MISSIONS_RPC)
   if (!["list", "read", "capabilities", "activation-read"].includes(input.action)) {
    const capability = await rpc.documentCapabilities({}, options) as { version?: number; agentScheduleControl?: boolean }
    await refresh()
    if (capability.version !== 1 || capability.agentScheduleControl !== true)
      return { status: 503, pending: true, missionID: input.missionID, requestID: input.requestID, code: "schedule-control-unavailable" }
   }
   if (input.action === "capabilities") {
     const owned = await prepareMissionMapMutation({ manager, fence: deps.worktreeDeletionFence, workspaceID: workspace.id,
       directory: session.location.directory, signal })
     return owned.run(async () => readMissionScheduleCapability(deps, workspace.id, owned.location,
       async () => { await owned.refresh(); await refresh() }))
   }
  if (input.action === "list") {
    const owned = await prepareMissionMapMutation({ manager, fence: deps.worktreeDeletionFence, workspaceID: workspace.id,
      directory: session.location.directory, signal })
    return owned.run(async (native, nativeOptions) => {
      const page = await native.scheduleList({ after: input.after, limit: input.limit ?? 8 }, { ...nativeOptions, signal }) as MissionScheduleList
      await owned.refresh(); await refresh()
      if (page.projectID !== session.projectID) throw new Error("Foreign Mission schedule list")
      return { ...page, schedules: page.schedules.map(document => ({
        missionID: document.id, title: document.configuration.title, kind: document.kind, revision: document.revision,
        state: document.state, observation: document.observation, availableActions: document.availableActions, blockReason: document.blockReason,
      })) }
    })
  }
  const point = await rpc.scheduleRead({ missionID: input.missionID! }, options) as MissionScheduleRead
  await refresh()
  const document = point.document
   if (document && document.kind !== "schedule" && !["read", "configure"].includes(input.action)) throw new Error("Use this Mission's owning controls")
  const directory = document?.configuration.roots.find(root => root.directory === session.location.directory)?.directory
    ?? document?.configuration.roots[0]?.directory ?? session.location.directory
   if (!await manager.ownsLocation(workspace.id, { directory }, client, { signal, strict: true })) throw new Error("Foreign Mission schedule Location")
   if (input.action === "activate" || input.action === "activation-read") {
     const owned = await prepareMissionMapMutation({ manager, fence: deps.worktreeDeletionFence, workspaceID: workspace.id, directory, signal })
     return owned.run(async (native, nativeOptions) => {
       const guarded = { documentActivation: async (...args: Parameters<typeof native.documentActivation>) => {
         await owned.refresh(); await refresh()
         return native.documentActivation(...args)
       } }
       const adapter = missionScheduleActivationJournal(guarded, nativeOptions,
         { missionID: input.missionID!, requestID: input.requestID!, expectedRevision: input.expectedRevision! }, current)
       const before = await adapter.read()
       if (input.action === "activation-read") { await refresh(); return { document: before } }
       if (!deps.scheduleSettingsActivation || before.state !== "paused" || !requiresMissionCalendar(before.launch))
         throw new Error("Mission schedule activation unavailable")
       return { document: await prepareMissionScheduleSettings({ adapter, activation: deps.scheduleSettingsActivation, before,
         workspaceID: workspace.id, location: nativeOptions.location, requestID: input.requestID!, expectedRevision: input.expectedRevision!,
         refresh: async () => { await owned.refresh(); await refresh() } }) }
     })
   }
  const principal = { kind: "agent" as const, author: { coordinatorSessionID: sessionID } }
  let expectedRevision = input.expectedRevision
  const held = scheduledMissionHold(deps.worktreeDeletionFence, input.missionID!)
  // Ready activation retains the original user-facing revision. Exact control
  // receipts and held permits retain the post-activation native CAS revision.
  const activation = document?.scheduleActivation
  const sameActivation = !!activation && activation.requestID === input.requestID && activation.expectedRevision === input.expectedRevision
  if (input.action === "play" || input.action === "resume") {
    if (!document) throw new Error("Mission schedule unavailable")
    if (held && held.binding.requestID === input.requestID && (sameActivation || held.binding.expectedRevision === input.expectedRevision))
      expectedRevision = held.binding.expectedRevision
    else {
      const exact = await rpc.scheduleRead({ missionID: input.missionID!, requestID: input.requestID! }, options) as MissionScheduleRead
      await refresh()
      const control = exact.document?.control
      if (control && control.requestID === input.requestID
        && (sameActivation || control.expectedRevision === input.expectedRevision))
        expectedRevision = control.expectedRevision
      else if (sameActivation && !held) {
        // An earlier activation crossed the native boundary. Recovery observes
        // that original request only, even when settings became ready meanwhile.
        return { status: 503, missionID: input.missionID, requestID: input.requestID, pending: true, code: "schedule-pending" }
      }
      else if (!held && document.state === "paused" && requiresMissionCalendar(document.configuration.launch)) {
        if (!deps.scheduleSettingsActivation) throw new Error("Mission schedule activation unavailable")
        const owned = await prepareMissionMapMutation({ manager, fence: deps.worktreeDeletionFence, workspaceID: workspace.id, directory, signal })
        expectedRevision = await owned.run(async (native, nativeOptions) => {
          const guarded = { documentActivation: async (...params: Parameters<typeof native.documentActivation>) => {
            await owned.refresh(); await refresh()
            return native.documentActivation(...params)
          } }
          const adapter = missionScheduleActivationJournal(guarded, nativeOptions, { missionID: input.missionID!,
            requestID: input.requestID!, expectedRevision: input.expectedRevision! }, current)
          const after = await prepareMissionScheduleSettings({ adapter, activation: deps.scheduleSettingsActivation!,
            workspaceID: workspace.id, location: nativeOptions.location, requestID: input.requestID!, expectedRevision: input.expectedRevision!,
            refresh: async () => { await owned.refresh(); await refresh() } })
          if (after.scheduleActivation?.state !== "ready") throw new Error("Mission schedule activation remains uncertain")
          return after.revision
        })
      }
    }
  }
   const { action, missionID, requestID, configuration, deleteManagedSessions, retry } = input
  const result = await executeScheduledMission(deps, {
    selected: { id: workspace.id, missionID }, query: { directory, ...(requestID ? { requestID } : {}) },
    value: action === "read" ? undefined : { action, requestID: requestID!, expectedRevision: expectedRevision!, directory,
      ...(configuration ? { configuration } : {}), ...(deleteManagedSessions === undefined ? {} : { deleteManagedSessions }), ...(retry ? { retry } : {}) },
    method: action === "read" ? "GET" : "POST", creating: false,
    lifetime: { signal, wait: promise => Promise.resolve(promise) }, principal, currentPrincipal: current, checkPrincipal: refresh,
  })
  await refresh()
  return { status: result.status, ...(result.body as object) }
}
