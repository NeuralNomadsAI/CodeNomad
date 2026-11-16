import { recurrenceControlHttpSchema, recurrenceSnapshotSchema } from "../../missions/recurrence-control-contract"
import { sameLocation } from "../../opencode/compatibility/location"
import type { ScheduleToolInput } from "../../missions/schedule-tool"
import { prepareRecurrenceControl } from "./mission-recurrence-play-preparation"
import { dispatchRecurrenceControl } from "./mission-recurrence-control"
import { dispatchRecurrenceRunNow } from "./mission-recurrence-manual"
import { readExactRecurrenceControlStatus } from "./mission-recurrence-control-status"
import { executeMissionRecurrenceCreation } from "./mission-recurrence-create"
import { recurrenceNotDispatchedReply } from "./mission-recurrence-holds"
import type { ownedMissionAgent } from "./mission-agent-owner"
import type { ScheduledMissionDeps } from "./mission-scheduled"
import { prepareMissionMapMutation } from "./mission-map-mutation"

type Agent = Awaited<ReturnType<typeof ownedMissionAgent>>

/** Daily storage keeps its own shared business operations, receipts and physical holds. */
export async function controlAgentDailyRecurrence(deps: ScheduledMissionDeps, agent: Agent, input: ScheduleToolInput, signal: AbortSignal) {
  const { workspace, session, refresh, current } = agent, manager = deps.workspaceManager
  const principal = { kind: "agent" as const, author: { coordinatorSessionID: session.id } }
  const lifetime = { signal, wait: <T>(promise: Promise<T>) => promise }
  let status = 200
  const reply = { code(value: number) { status = value; return this }, send(value: unknown) { return value } }
  if (input.action === "list" || input.action === "read" && !input.requestID && !input.creation) {
    const owned = await prepareMissionMapMutation({ manager, fence: deps.worktreeDeletionFence,
      workspaceID: workspace.id, directory: session.location.directory, signal })
    return owned.run(async (rpc, nativeOptions) => {
      const snapshot = recurrenceSnapshotSchema.parse(await rpc.recurrenceSnapshot({}, { ...nativeOptions, signal }))
      await owned.refresh(); await refresh()
      if (snapshot.projectID !== session.projectID || snapshot.projectCanonical !== agent.project.canonical || !sameLocation(snapshot.location, session.location))
        throw new Error("Foreign daily Mission view")
      const rows = snapshot.schedules.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      if (input.action === "read") return { schedule: rows.find(row => row.id === input.missionID) ?? null }
      const selected = rows.filter(row => !input.after || row.id > input.after).slice(0, input.limit ?? 8)
      return { projectID: snapshot.projectID, schedules: selected.map(({ id, title, revision, state, clock, nextDueAt, actions }) =>
        ({ missionID: id, title, revision, state, clock, nextDueAt, actions })),
        ...(rows.some(row => row.id > (selected.at(-1)?.id ?? input.after ?? "")) ? { next: selected.at(-1)?.id } : {}) }
    })
  }
  if (!deps.worktreeDeletionFence || !deps.settings?.configYamlPathForAuthority || !deps.bridgeToken)
    throw new Error("Daily Mission admission unavailable")
  const settings = { getProfileScope: () => deps.settings!.getProfileScope(),
    configYamlPathForAuthority: () => deps.settings!.configYamlPathForAuthority!() }
  if (input.action === "create" || input.action === "read" && input.creation) {
    let missionID: string | undefined
    const body = await executeMissionRecurrenceCreation(deps, { workspaceID: workspace.id,
      input: { ...input.creation, requestID: input.requestID, directory: session.location.directory },
      lifetime, principal, currentPrincipal: current, refreshPrincipal: refresh, warn() {},
      ...(input.action === "read" ? { observeOnly: true as const } : {}), onIdentity: id => { missionID = id },
    }, reply)
    await refresh()
    return { status, requestID: input.requestID, ...(missionID ? { missionID } : {}), ...(body as object) }
  }
  const shared = { manager, fence: deps.worktreeDeletionFence }
  if (input.action === "read") {
    const body = await readExactRecurrenceControlStatus(shared, { id: workspace.id, requestedDirectory: session.location.directory,
      input: { scheduleID: input.missionID!, requestID: input.requestID!, expectedRevision: input.expectedRevision!, action: input.receiptAction! },
      lifetime, currentPrincipal: current,
    }, reply)
    await refresh()
    return { status, ...(body as object) }
  }
  if (!manager.getServicePathStyle) throw new Error("Daily Mission path style unavailable")
  const controlDeps = { ...shared, settings, bridgeToken: deps.bridgeToken,
    manager: manager as typeof manager & Required<Pick<typeof manager, "getServicePathStyle">> }
  const request = recurrenceControlHttpSchema.parse({ scheduleID: input.missionID!, requestID: input.requestID!, expectedRevision: input.expectedRevision!,
    action: input.action, directory: session.location.directory, ...(input.retry ? { retry: true } : {}) })
  let prepared: Awaited<ReturnType<typeof prepareRecurrenceControl>> | undefined, dispatched = false
  try {
    prepared = await prepareRecurrenceControl(workspace.id, request, controlDeps, signal, { principal, current, refresh })
    prepared.current(); prepared.hold.dispatched(); dispatched = true
    const result = input.action === "run-now" ? await dispatchRecurrenceRunNow(prepared, shared.fence, workspace.id)
      : await dispatchRecurrenceControl(prepared, shared.fence, workspace.id)
    await refresh()
    return { status: result.status, ...(result.body as object) }
  } catch (error) {
    if (!dispatched) prepared?.dispose()
    const refusal = dispatched ? undefined : recurrenceNotDispatchedReply(error, { ...shared, workspaceID: workspace.id, request })
    return { status: refusal?.status ?? 503, ...(refusal?.body ?? { pending: true, missionID: input.missionID,
      requestID: input.requestID, code: "recurrence-unconfirmed" }) }
  } finally { prepared?.dispose() }
}
