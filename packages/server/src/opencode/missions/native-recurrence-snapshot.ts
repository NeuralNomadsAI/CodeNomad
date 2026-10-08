import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Schema } from "effect"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import type { MissionRecurrenceSnapshot } from "../../api-types"

const locationTag = Context.Service<never, unknown>("@opencode/Location")
const info = Schema.toType(Schema.Struct(Location.Info.fields))

/** No scan beyond the bounded native project prefix, no state/Job writes. */
export const readNativeRecurrenceSnapshot = Effect.fn("missions.readNativeRecurrenceSnapshot")(function* (
  ctx: Pick<Plugin.Context, "location" | "storage">,
) {
  const origin = yield* Effect.serviceOption(locationTag)
  if (Option.isNone(origin)) throw new Error("Native Location graph unavailable")
  const location = yield* Schema.decodeUnknownEffect(info)(origin.value)
  const assertLocation = () => {
    if (location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
      || location.project.id !== ctx.location.project.id || location.project.canonical !== ctx.location.project.canonical) {
      throw new Error("Recurrence Location changed")
    }
  }
  assertLocation()
  const store = yield* acquireNativeRecurrenceStore(ctx)
  const schedules = (yield* Effect.promise(() => store.list())).filter(schedule =>
    schedule.config.roots.some(root => root.directory === location.directory))
  const results: MissionRecurrenceSnapshot["schedules"] = []
  for (const schedule of schedules) {
    // Neither the ledger's structural codec nor an in-memory Job authenticates
    // activity. A future producer must authenticateRecurrenceStanding against
    // installer-pinned current signers INSIDE this RPC, recheck before response,
    // and verify the exact live Location map before projecting running/interrupted.
    const state = schedule.state === "running" ? "unavailable" : schedule.state
    const history = schedule.history.map(({ passage, settledAt, result }) => ({
      passageID: passage.id, messageID: result.messageID, dueAt: passage.due.at, settledAt,
      status: "kind" in result ? result.kind : result.outcome,
      ...("missionID" in result ? { missionID: result.missionID, conversationID: result.conversationID,
        artifactMessageIDs: result.artifactMessageIDs } : {}),
    }))
    results.push({ id: schedule.id, revision: schedule.revision, scheduleRevision: schedule.scheduleRevision,
      state, clock: schedule.config.clock, pendingPassageID: schedule.pending?.passage.id ?? null,
      pendingStatus: schedule.pending ? schedule.pending.admission ? "admitted" : "unknown" : null,
      pendingAdmission: schedule.pending?.admission ? { missionID: schedule.pending.admission.missionID,
        conversationID: schedule.pending.admission.conversationID } : null,
      settledCount: schedule.settledCount, latestResult: history.at(-1) ?? null, history })
  }
  assertLocation()
  return { version: 1 as const, projectID: location.project.id, projectCanonical: location.project.canonical,
    location: { directory: location.directory, ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }) },
    schedules: results }
})
