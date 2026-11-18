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
import { recurrenceListSchema, recurrencePlacementReadSchema } from "../../missions/recurrence-discovery"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"

type Agent = Awaited<ReturnType<typeof ownedMissionAgent>>

/** Daily storage keeps its own shared business operations, receipts and physical holds. */
export async function controlAgentDailyRecurrence(deps: ScheduledMissionDeps, agent: Agent, input: ScheduleToolInput, signal: AbortSignal) {
  const { workspace, session, refresh, current } = agent, manager = deps.workspaceManager
  const principal = { kind: "agent" as const, author: { coordinatorSessionID: session.id } }
  const lifetime = { signal, wait: <T>(promise: Promise<T>) => promise }
  let status = 200
  const reply = { code(value: number) { status = value; return this }, send(value: unknown) { return value } }
  const assertProject = (view: { projectID: string; projectCanonical: string }) => {
    if (view.projectID !== session.projectID || view.projectCanonical !== agent.project.canonical)
      throw new Error("Foreign daily Mission view")
  }
  const snapshotAt = async (target: { id: string; directory: string }) => {
    const owned = await prepareMissionMapMutation({ manager, fence: deps.worktreeDeletionFence,
      workspaceID: workspace.id, directory: target.directory, signal })
    return owned.run(async (rpc, nativeOptions) => {
      const location = await owned.client.location.get({ location: owned.location }, { signal })
      assertProject({ projectID: location.project.id, projectCanonical: location.project.canonical })
      await owned.refresh(); await refresh()
      const snapshot = recurrenceSnapshotSchema.parse(await rpc.recurrenceSnapshot({ scheduleID: target.id }, { ...nativeOptions, signal }))
      await owned.refresh(); await refresh()
      assertProject(snapshot)
      if (!sameLocation(snapshot.location, owned.location) || snapshot.schedules.some(row => row.id !== target.id))
        throw new Error("Foreign daily Mission view")
      const row = snapshot.schedules.find(row => row.id === target.id)
      if (!row) throw new Error("Daily Mission placement changed")
      return row
    })
  }
  if (input.action === "list") {
    const owned = await prepareMissionMapMutation({ manager, fence: deps.worktreeDeletionFence,
      workspaceID: workspace.id, directory: session.location.directory, signal })
    const page = await owned.run(async (rpc, nativeOptions) => {
      const page = recurrenceListSchema.parse(await rpc.recurrenceList({ after: input.after, limit: input.limit ?? 8 }, { ...nativeOptions, signal }))
      await owned.refresh(); await refresh(); assertProject(page)
      return page
    })
    const rows = await Promise.all(page.schedules.map(snapshotAt))
    return { projectID: page.projectID, schedules: rows.map(({ id, title, revision, state, clock, nextDueAt, actions }) =>
      ({ missionID: id, title, revision, state, clock, nextDueAt, actions })), ...(page.next ? { next: page.next } : {}) }
  }
  if (!deps.worktreeDeletionFence) throw new Error("Daily Mission admission unavailable")
  const settings = { getProfileScope: () => deps.settings!.getProfileScope(),
    configYamlPathForAuthority: () => deps.settings!.configYamlPathForAuthority!() }
  if (input.action === "create" || input.action === "read" && input.creation) {
    if (!deps.settings?.configYamlPathForAuthority || !deps.bridgeToken) throw new Error("Daily Mission admission unavailable")
    let missionID: string | undefined
    const body = await executeMissionRecurrenceCreation(deps, { workspaceID: workspace.id,
      input: { ...input.creation, requestID: input.requestID, directory: session.location.directory },
      lifetime, principal, currentPrincipal: current, refreshPrincipal: refresh, warn() {},
      ...(input.action === "read" ? { observeOnly: true as const } : {}), onIdentity: id => { missionID = id },
    }, reply)
    await refresh()
    return { status, requestID: input.requestID, ...(missionID ? { missionID } : {}), ...(body as object) }
  }
  // Routing reads take no new physical permit: an exact held receipt can settle
  // while deletion waits on its original control hold.
  const { schedule: target } = recurrencePlacementReadSchema.parse(await agent.client.rpc(CODENOMAD_MISSIONS_RPC)
    .recurrenceRead({ id: input.missionID! }, agent.options))
  await refresh()
  if (target) {
    assertProject(target)
    if (target.id !== input.missionID) throw new Error("Daily Mission identity differs")
  }
  if (!target) {
    if (input.action === "read") return { schedule: null }
    throw new Error("Daily Mission unavailable")
  }
  // The project-scoped lookup supplies routing only. The owned Location read and
  // shared control admission revalidate placement; native origin guards stay exact.
  const directory = target.directory
  if (input.action === "read" && !input.requestID) return { schedule: await snapshotAt(target) }
  const location = await agent.client.location.get({ location: { directory } }, { signal })
  assertProject({ projectID: location.project.id, projectCanonical: location.project.canonical })
  if (!sameLocation(location, { directory }) || !await manager.ownsLocation(workspace.id, location, agent.client, { signal, strict: true }))
    throw new Error("Foreign daily Mission Location")
  await refresh()
  if (!deps.settings?.configYamlPathForAuthority || !deps.bridgeToken) throw new Error("Daily Mission admission unavailable")
  const shared = { manager, fence: deps.worktreeDeletionFence }
  if (input.action === "read") {
    const body = await readExactRecurrenceControlStatus(shared, { id: workspace.id, requestedDirectory: directory,
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
    action: input.action, directory, ...(input.retry ? { retry: true } : {}) })
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
