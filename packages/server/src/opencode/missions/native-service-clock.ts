import { Location } from "@opencode/schema/location"
import { Cause, Clock, Context, Effect, MutableHashMap, Option, Predicate, Schema, Scope } from "effect"
import { stableToken } from "../../missions/journal"
import type { NativePassageDue } from "./native-recurrence-due"
import type { RecurrenceDocument } from "../../missions/recurrence-contract"
import { latestDailyDue, nextDailyDue } from "../../missions/recurrence-clock"
import { isNewDailyDue } from "../../missions/recurrence-store"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import type { Plugin } from "@opencode/plugin/effect"

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
  contextEffectOption?(ref: Location.Ref): Effect.Effect<Option.Option<Context.Context<never>>, unknown, Scope.Scope>
}
export type RecurrenceClockPlacement = Readonly<{
  projectID: string; projectCanonical: string; directory: string; workspaceID?: string; scheduleID: string
  profileID: string; executionHost: string
  /** Only the original authenticated manual invocation carries this hint. */
  manual?: { requestID: string; expectedRevision: number }
}>

/** "schedule" is the one daily Job of a running schedule. "settle" only observes
 * an already admitted pending passage of a non-running schedule until it settles;
 * it never starts a daily passage. */
export type RecurrenceClockKind = "schedule" | "settle"
const jobType = (kind: RecurrenceClockKind) => kind === "schedule" ? "codenomad.missions.recurrence" : "codenomad.missions.recurrence.settle"
const jobID = (input: RecurrenceClockPlacement, kind: RecurrenceClockKind = "schedule") => `${jobType(kind)}:${stableToken(
  `${input.projectID}\0${input.projectCanonical}\0${input.directory}\0${input.workspaceID ?? ""}\0${input.scheduleID}\0${input.profileID}\0${input.executionHost}`, 32)}`

/** Exact generation read only. Missing native Job is not a license to start it. */
export const readNativeRecurrenceClockStatus = Effect.fn("missions.readNativeRecurrenceClockStatus")(function* (input: RecurrenceClockPlacement,
  kind: RecurrenceClockKind = "schedule") {
  const service = yield* Effect.serviceOption(jobTag)
  const map = yield* Effect.serviceOption(mapTag), origin = yield* Effect.serviceOption(locationTag)
  if (Option.isNone(service) || !Predicate.isFunction(service.value?.get)) throw new Error("Native Job graph unavailable")
  // RcMap.getOption never loads another Location. A Job can still say running
  // after its owner graph was evicted, until the next due callback notices it.
  if (Option.isNone(map) || Option.isNone(origin) || !Predicate.isFunction(map.value.contextEffectOption)) return undefined
  if (origin.value.directory !== input.directory || origin.value.workspaceID !== input.workspaceID
    || origin.value.project.id !== input.projectID || origin.value.project.canonical !== input.projectCanonical) return undefined
  const ref = Schema.decodeUnknownSync(Location.Ref)({ directory: input.directory,
    ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }) })
  const currentEntry = () => {
    const state = map.value.rcMap?.state
    if (state?._tag !== "Open") return undefined
    const found = MutableHashMap.get(state.map, ref)
    return Option.isSome(found) ? found.value : undefined
  }
  const entry = currentEntry()
  if (entry === undefined) return undefined
  const graph = yield* Effect.scoped(map.value.contextEffectOption(ref))
  if (Option.isNone(graph) || Option.getOrUndefined(Context.getOption(graph.value, locationTag)) !== origin.value
    || currentEntry() !== entry) return undefined
  const lookup = service.value.get(jobID(input, kind))
  if (!Effect.isEffect(lookup)) throw new Error("Native Job contract unavailable")
  const found = yield* lookup
  if (currentEntry() !== entry) return undefined
  if (!found) return false
  const actual = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String, type: Schema.String,
    status: Schema.Literals(["running", "completed", "error", "cancelled"]),
    metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }))(found)
  const metadata = { projectID: input.projectID, projectCanonical: input.projectCanonical,
    directory: input.directory, scheduleID: input.scheduleID,
    ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
    profileID: input.profileID, executionHost: input.executionHost }
  if (actual.id !== jobID(input, kind) || actual.type !== jobType(kind)
    || JSON.stringify(actual.metadata) !== JSON.stringify(metadata)) throw new Error("Recurrence Job generation changed")
  return actual.status
})

export const readNativeRecurrenceClock = Effect.fn("missions.readNativeRecurrenceClock")(function* (input: RecurrenceClockPlacement) {
  const status = yield* readNativeRecurrenceClockStatus(input)
  return status === undefined ? undefined : status === "running"
})

/** The caller has already committed an authenticated Play. Job owns this clock, not the
 * evictable Location/plugin Scope. A due callback must obtain its fresh authority,
 * passage store and environment from the borrowed graph; the clock grants none. */
export const startNativeRecurrenceClock = Effect.fn("missions.startNativeRecurrenceClock")(function* (
  input: RecurrenceClockPlacement,
  due: NativePassageDue,
  ctx: Pick<Plugin.Context, "storage" | "location">,
  clock: { now(): number; sleep(ms: number): Effect.Effect<void> } = { now: Date.now, sleep: Effect.sleep },
  kind: RecurrenceClockKind = "schedule",
) {
  const exactCtx = { storage: ctx.storage, location: ctx.location }
  const nativeClock = yield* Clock.Clock
  const job = yield* jobTag, locations = yield* mapTag, session = yield* sessionTag
  const ref = Schema.decodeUnknownSync(Location.Ref)({ directory: input.directory,
    ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }) })
  const id = jobID(input, kind), metadata = { projectID: input.projectID,
    projectCanonical: input.projectCanonical, directory: input.directory, scheduleID: input.scheduleID,
    ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
    profileID: input.profileID, executionHost: input.executionHost }
  const existing = yield* job.get(id)
  if (existing?.status === "running") {
    if (JSON.stringify(existing.metadata) !== JSON.stringify(metadata)) throw new Error("Recurrence Job generation changed")
    return existing
  }
  const run = Effect.scoped(Effect.gen(function* () {
    // Each wake borrows and validates a fresh Location graph. No minute polling.
    while (true) {
      const delay = yield* Effect.scoped(Effect.gen(function* () {
        const graph = yield* locations.contextEffect(ref)
        const location = Schema.decodeUnknownSync(Location.Info)(Context.get(graph, locationTag))
        if (location.directory !== input.directory || location.workspaceID !== input.workspaceID
          || location.project.id !== input.projectID
          || location.project.canonical !== input.projectCanonical) throw new Error("Recurrence Location changed")
        const entry = MutableHashMap.get(locations.rcMap.state.map, ref)
        if (locations.rcMap.state._tag !== "Open" || Option.isNone(entry)) throw new Error("Recurrence Location unavailable")
        const current = (): true => {
          const actual = MutableHashMap.get(locations.rcMap.state.map, ref)
          if (locations.rcMap.state._tag !== "Open" || Option.isNone(actual) || actual.value !== entry.value) throw new Error("Recurrence Location replaced")
          return true
        }
        const source = yield* acquireNativeRecurrenceStore({ storage: exactCtx.storage, location }).pipe(Effect.provide(graph))
        let document = yield* Effect.promise(() => source.read(input.scheduleID))
        current()
        // Settle mode exits once settled, or when a running schedule's own Job owns observation.
        const active = (doc: RecurrenceDocument | undefined): doc is RecurrenceDocument => kind === "schedule"
          ? doc?.state === "running" : doc?.state === "paused" && !!doc.pending
        if (!active(document)) return null
        const now = clock.now(), dueAt = recurrenceNextDueAt(document, now)
        if (!document.pending && dueAt > now) return Math.min(dueAt - now, 3_600_000)
        const beforeRevision = document.revision
        const controller = new AbortController()
        const invocation = due(input.scheduleID, () => {
            const current = MutableHashMap.get(locations.rcMap.state.map, ref)
            if (locations.rcMap.state._tag !== "Open" || Option.isNone(current) || current.value !== entry.value) {
              throw new Error("Recurrence Location replaced")
            }
            return true
          }, controller.signal)
        yield* invocation.pipe(Effect.provide(Context.add(graph, sessionTag, session)),
          Effect.ensuring(Effect.sync(() => controller.abort())))
        document = yield* Effect.promise(() => source.read(input.scheduleID))
        current()
        if (!active(document)) return null
        const after = clock.now()
        if (kind === "settle") return 3_600_000
        const next = document.pending ? nextDailyDue(document.config.clock, after).at : recurrenceNextDueAt(document, after)
        if (!document.pending && next <= after && document.revision === beforeRevision) throw new Error("recurrence-passage-state-unknown")
        return Math.min(next - after, 3_600_000)
      }))
      // A healthy accepted passage stays pending until its terminal archive;
      // polling it never admits another effect, but must not retire tomorrow's Job.
      if (delay === null) return "inactive"
      if (delay <= 0) continue
      yield* clock.sleep(Math.max(1, delay)).pipe(Effect.provideService(Clock.Clock, nativeClock))
    }
  })).pipe(Effect.catchCause(cause => Effect.scoped(Effect.gen(function* () {
    if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause)
    const graph = yield* locations.contextEffect(ref)
    const source = yield* acquireNativeRecurrenceStore(exactCtx).pipe(Effect.provide(graph))
    yield* Effect.promise(() => source.recordClockError(input.scheduleID, () => true)).pipe(Effect.catchCause(() => Effect.void))
    return yield* Effect.failCause(cause)
  }))), Effect.updateContext((_origin: Context.Context<never>) => Context.empty()))
  const started = yield* job.start({ id, type: jobType(kind), metadata, run })
  if (JSON.stringify(started.metadata) !== JSON.stringify(metadata)) {
    throw new Error("Recurrence Job generation changed")
  }
  return started
})

/** Pause/Stop commits the desired state before calling this. */
export const cancelNativeRecurrenceClock = Effect.fn("missions.cancelNativeRecurrenceClock")(function* (input: RecurrenceClockPlacement,
  kind: RecurrenceClockKind = "schedule") {
  return yield* (yield* jobTag).cancel(jobID(input, kind))
})

export function recurrenceNextDueAt(document: RecurrenceDocument, now: number): number {
  const latest = latestDailyDue(document.config.clock, now)
  return isNewDailyDue(document, latest) ? latest.at : nextDailyDue(document.config.clock, now).at
}
