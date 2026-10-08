import { Location } from "@opencode/schema/location"
import { Context, Effect, MutableHashMap, Option, Schema, Scope } from "effect"
import { stableToken } from "../../missions/journal"
import type { RecurrenceRunOutcome } from "../../missions/recurrence-runner"

const jobTag = Context.Service<never, NativeJob>("@opencode/Job")
const mapTag = Context.Service<never, NativeLocations>("@opencode/example/LocationServiceMap")
const sessionTag = Context.Service<never, unknown>("@opencode/Session")
const locationTag = Context.Service<never, Location.Info>("@opencode/Location")

type NativeJob = {
  get(id: string): Effect.Effect<{ status: string; metadata?: Record<string, unknown> } | undefined>
  start(input: { id: string; type: string; metadata: Record<string, unknown>; run: Effect.Effect<string, unknown> }):
    Effect.Effect<{ status: string; metadata?: Record<string, unknown> }>
  cancel(id: string): Effect.Effect<unknown>
}
type NativeLocations = {
  rcMap: { state: { _tag: string; map: MutableHashMap.MutableHashMap<Location.Ref, unknown> } }
  contextEffect(ref: Location.Ref): Effect.Effect<Context.Context<never>, unknown, Scope.Scope>
}
export type RecurrenceClockPlacement = Readonly<{
  projectID: string; projectCanonical: string; directory: string; workspaceID?: string; scheduleID: string
  profileID: string; executionHost: string; epoch: number
}>

const jobID = (input: RecurrenceClockPlacement) => `codenomad.missions.recurrence:${stableToken(
  `${input.projectID}\0${input.projectCanonical}\0${input.directory}\0${input.workspaceID ?? ""}\0${input.scheduleID}\0${input.profileID}\0${input.executionHost}\0${input.epoch}`, 32)}`

/** The caller has already committed a signed Play. Job owns this clock, not the
 * evictable Location/plugin Scope. A due callback must obtain its fresh authority,
 * passage store and environment from the borrowed graph; the clock grants none. */
export const startNativeRecurrenceClock = Effect.fn("missions.startNativeRecurrenceClock")(function* (
  input: RecurrenceClockPlacement,
  due: (graph: Context.Context<never>, assertCurrent: () => true, signal: AbortSignal) => Promise<RecurrenceRunOutcome>,
) {
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) throw new Error("Invalid recurrence epoch")
  const job = yield* jobTag, locations = yield* mapTag, session = yield* sessionTag
  const ref = Schema.decodeUnknownSync(Location.Ref)({ directory: input.directory,
    ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }) })
  const id = jobID(input), metadata = { epoch: input.epoch, projectID: input.projectID,
    projectCanonical: input.projectCanonical, directory: input.directory, scheduleID: input.scheduleID,
    ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
    profileID: input.profileID, executionHost: input.executionHost }
  const existing = yield* job.get(id)
  if (existing?.status === "running") {
    if (JSON.stringify(existing.metadata) !== JSON.stringify(metadata)) throw new Error("Recurrence Job generation changed")
    return existing
  }
  const run = Effect.scoped(Effect.gen(function* () {
    // Poll at the next UTC minute. The runner's civil-time clock owns DST and
    // bounded catch-up when the process wakes from sleep; Job is not persistent.
    while (true) {
      const outcome = yield* Effect.scoped(Effect.gen(function* () {
        const graph = yield* locations.contextEffect(ref)
        const location = Schema.decodeUnknownSync(Location.Info)(Context.get(graph, locationTag))
        if (location.directory !== input.directory || location.workspaceID !== input.workspaceID
          || location.project.id !== input.projectID
          || location.project.canonical !== input.projectCanonical) throw new Error("Recurrence Location changed")
        const entry = MutableHashMap.get(locations.rcMap.state.map, ref)
        if (locations.rcMap.state._tag !== "Open" || Option.isNone(entry)) throw new Error("Recurrence Location unavailable")
        return yield* Effect.tryPromise((signal) => due(Context.add(graph, sessionTag, session), () => {
          signal.throwIfAborted()
          const current = MutableHashMap.get(locations.rcMap.state.map, ref)
          if (locations.rcMap.state._tag !== "Open" || Option.isNone(current) || current.value !== entry.value) {
            throw new Error("Recurrence Location replaced")
          }
          return true
        }, signal))
      }))
      if (outcome === "unknown" || outcome === "pending" || outcome === "inactive") return outcome
      yield* Effect.sleep(60_000 - Date.now() % 60_000)
    }
  })).pipe(Effect.updateContext((_origin: Context.Context<never>) => Context.empty()))
  const started = yield* job.start({ id, type: "codenomad.missions.recurrence", metadata, run })
  if (JSON.stringify(started.metadata) !== JSON.stringify(metadata)) {
    throw new Error("Recurrence Job generation changed")
  }
  return started
})

/** Pause/Stop fences the signed epoch in durable storage before calling this. */
export const cancelNativeRecurrenceClock = Effect.fn("missions.cancelNativeRecurrenceClock")(function* (input: RecurrenceClockPlacement) {
  return yield* (yield* jobTag).cancel(jobID(input))
})
