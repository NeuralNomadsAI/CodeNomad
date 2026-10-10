import { Event } from "@opencode/schema/event"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import { MISSION_RECURRENCE_CHANGED_EVENT, readRecurrenceScheduleChanged, type RecurrenceScheduleChanged } from "../../missions/recurrence-events"

const changed = Event.ephemeral({ type: MISSION_RECURRENCE_CHANGED_EVENT, schema: {
  scheduleID: Schema.String, revision: Schema.Int,
} })
type Bus = { publish(definition: typeof changed, data: RecurrenceScheduleChanged, options: { location: Location.Ref }): Effect.Effect<unknown, unknown> }
const busTag = Context.Service<never, Bus>("@opencode/Bus")
const locationTag = Context.Service<never, Location.Info>("@opencode/Location")

/** Call only AFTER the native calendar transaction returns. Lookup the app-global
 * Bus in this commit's fresh graph, never an evicted origin's RPC registration.
 * Contract reviewed against core bus.ts/rpc.ts at upstream v2.0.24. */
export const emitNativeRecurrenceChanged = Effect.fn("missions.emitNativeRecurrenceChanged")(function* (
  placement: { directory: string; workspaceID?: string; projectID: string; projectCanonical: string }, scheduleID: string, revision: number,
) {
  const data = readRecurrenceScheduleChanged({ type: MISSION_RECURRENCE_CHANGED_EVENT, data: { scheduleID, revision } })
  if (!data) throw new Error("Invalid recurrence invalidation")
  const bus = yield* Effect.serviceOption(busTag), origin = yield* Effect.serviceOption(locationTag)
  if (Option.isNone(bus) || !Predicate.isFunction(bus.value.publish) || Option.isNone(origin)
    || origin.value.directory !== placement.directory || origin.value.workspaceID !== placement.workspaceID
    || origin.value.project.id !== placement.projectID || origin.value.project.canonical !== placement.projectCanonical) throw new Error("Recurrence event graph unavailable")
  const location = Schema.decodeUnknownSync(Location.Ref)({ directory: placement.directory,
    ...(placement.workspaceID === undefined ? {} : { workspaceID: placement.workspaceID }) })
  const publication = bus.value.publish(changed, data, { location })
  if (!Effect.isEffect(publication)) throw new Error("Recurrence Bus contract unavailable")
  yield* publication
})
