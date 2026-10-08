import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect } from "effect"
import { readNativeRecurrenceClockStatus, recurrenceNextDueAt } from "./native-service-clock"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { qualifyNativeRecurrenceControl } from "./native-recurrence-capability"
import type { MissionRecurrenceSnapshot } from "../../api-types"

const locationTag = Context.Service<never, Location.Info>("@opencode/Location")

/** Read-only: a restart never re-arms a schedule from its desired state. */
export const readNativeRecurrenceSnapshot = Effect.fn("missions.readNativeRecurrenceSnapshot")(function* (
  ctx: Pick<Plugin.Context, "location" | "storage">,
) {
  const location = yield* locationTag
  if (location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
    || location.project.id !== ctx.location.project.id || location.project.canonical !== ctx.location.project.canonical) throw new Error("Recurrence Location changed")
  const store = yield* acquireNativeRecurrenceStore(ctx)
  const schedules = (yield* Effect.promise(() => store.list())).filter(doc => doc.config.roots.some(root => root.directory === location.directory))
  const qualified = yield* qualifyNativeRecurrenceControl().pipe(Effect.catchCause(() => Effect.succeed(false)))
  const results: MissionRecurrenceSnapshot["schedules"] = []
  for (const doc of schedules) {
    const jobStatus = doc.state === "running" ? yield* readNativeRecurrenceClockStatus({ projectID: doc.projectID,
      projectCanonical: doc.projectCanonical, directory: location.directory, workspaceID: location.workspaceID,
      scheduleID: doc.id, profileID: doc.config.profileID, executionHost: doc.config.executionHost }) : false
    if (doc.state === "running" && jobStatus === undefined) throw new Error("Recurrence clock observation unavailable")
    const state = doc.state === "running" && jobStatus !== "running" ? "interrupted" : doc.state
    const history = doc.history.map(({ passage, settledAt, result }) => ({ passageID: passage.id, dueAt: passage.due.at,
      settledAt, outcome: result.outcome, missionID: result.missionID, conversationID: result.conversationID }))
    const actions: MissionRecurrenceSnapshot["schedules"][number]["actions"] = []
    const partial = doc.controls.some(item => !item.controlsComplete && (item.action === "pause" || item.action === "stop"))
    const retry = doc.controls.at(-1)
    if (qualified && partial && retry && !retry.controlsComplete && (retry.action === "pause" || retry.action === "stop")) actions.push(retry.action)
    if (qualified && !partial && state !== "stopped") {
      if (state === "paused" && !doc.pending) actions.push("play")
      if (state === "interrupted" || state === "paused" && doc.pending) actions.push("resume")
      if (state === "running" || state === "interrupted") actions.push("pause")
      actions.push("stop")
      if (!doc.pending) actions.push("run-now")
    }
    results.push({ id: doc.id, title: doc.config.title, revision: doc.revision, state, clock: doc.config.clock,
      nextDueAt: state === "running" ? recurrenceNextDueAt(doc, Date.now()) : null,
      ...(state === "interrupted" ? { interruptionReason: jobStatus === "error" ? "error" as const : doc.interruptionReason ?? "service-restart" } : {}),
      pending: doc.pending ? { passageID: doc.pending.passage.id, status: doc.pending.admission ? "running" : "uncertain",
        ...(doc.pending.admission ? { missionID: doc.pending.admission.missionID, conversationID: doc.pending.admission.conversationID } : {}) } : null,
      latestResult: history.at(-1) ?? null, history, actions,
      controls: doc.controls.map(({ targetsKnown: _known, ...record }) => ({ ...record, version: 1,
        scheduleID: doc.id, outcome: record.controlsComplete ? "committed" : "unknown" })) })
  }
  return { version: 1 as const, projectID: location.project.id, projectCanonical: location.project.canonical,
    location: { directory: location.directory, ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }) }, schedules: results }
})
