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
const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
const busTag = Context.Service<never, unknown>("@opencode/Bus")

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

/** The native map hashes keys with the service's own effect copy, so this bundle's
 * MutableHashMap.get misses structurally equal refs (observed against 2.0.26).
 * Scan the native iterator by Location.Ref fields; native lookups keep using `ref`. */
export function nativeLocationEntry(state: { _tag: string; map?: Iterable<readonly [Location.Ref, unknown]> } | undefined,
  ref: Location.Ref): Option.Option<unknown> {
  if (state?._tag !== "Open" || !state.map) return Option.none()
  for (const [key, value] of state.map) {
    if (key.directory === ref.directory && key.workspaceID === ref.workspaceID) return Option.some(value)
  }
  return Option.none()
}

const jobID = (input: RecurrenceClockPlacement) => `codenomad.missions.recurrence:${stableToken(
  `${input.projectID}\0${input.projectCanonical}\0${input.directory}\0${input.workspaceID ?? ""}\0${input.scheduleID}\0${input.profileID}\0${input.executionHost}`, 32)}`

/** Exact generation read only. Missing native Job is not a license to start it. */
export const readNativeRecurrenceClockStatus = Effect.fn("missions.readNativeRecurrenceClockStatus")(function* (input: RecurrenceClockPlacement) {
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
  const currentEntry = () => Option.getOrUndefined(nativeLocationEntry(map.value.rcMap?.state, ref))
  const entry = currentEntry()
  if (entry === undefined) return undefined
  const graph = yield* Effect.scoped(map.value.contextEffectOption(ref))
  if (Option.isNone(graph) || Option.getOrUndefined(Context.getOption(graph.value, locationTag)) !== origin.value
    || currentEntry() !== entry) return undefined
  const lookup = service.value.get(jobID(input))
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
  if (actual.id !== jobID(input) || actual.type !== "codenomad.missions.recurrence"
    || JSON.stringify(actual.metadata) !== JSON.stringify(metadata)) throw new Error("Recurrence Job generation changed")
  return actual.status
})

export const readNativeRecurrenceClock = Effect.fn("missions.readNativeRecurrenceClock")(function* (input: RecurrenceClockPlacement) {
  const status = yield* readNativeRecurrenceClockStatus(input)
  return status === undefined ? undefined : status === "running"
})

/** Native publishes an execution terminal from its `settled` hook BEFORE the session
 * leaves `Session.active`; wait briefly so the woken observation sees it inactive. */
const SETTLED_EVENT_DEBOUNCE_MS = 3_000
/** Only when the native Bus listener contract is absent, and only while pending. */
const PENDING_FALLBACK_BACKOFF_MS = [30_000, 120_000, 300_000] as const
const executionTerminal = /^session\.execution\.(succeeded|failed|interrupted)(\.\d+)?$/

/** Volatile wake hint, never settlement evidence: the woken Job re-observes the whole
 * family. Uses the native Bus `listen(listener) => Effect<Unsubscribe>` contract
 * (callback, no cross-bundle Stream interop); the listener runs inline during publish. */
export const nativeExecutionSettledSignal = (bus: unknown) => Effect.gen(function* () {
  let signalled = false, notify: (() => void) | undefined
  const listen = Predicate.hasProperty(bus, "listen") && Predicate.isFunction(bus.listen) ? bus.listen as
    (listener: (event: unknown) => Effect.Effect<void>) => Effect.Effect<unknown> : undefined
  const listener = (event: unknown) => Effect.sync(() => {
    if (!Predicate.hasProperty(event, "type") || typeof event.type !== "string" || !executionTerminal.test(event.type)) return
    signalled = true; notify?.()
  })
  const unsubscribe = listen ? yield* Effect.acquireRelease(listen(listener), stop =>
    Effect.isEffect(stop) ? (stop as Effect.Effect<unknown>).pipe(Effect.ignore) : Effect.void) : undefined
  return { supported: Effect.isEffect(unsubscribe), reset: () => { signalled = false },
    wait: Effect.callback<void>(resume => {
      if (signalled) return resume(Effect.void)
      notify = () => { notify = undefined; resume(Effect.void) }
      return Effect.sync(() => { notify = undefined })
    }) }
})

/** The caller has already committed an authenticated Play. Job owns this clock, not the
 * evictable Location/plugin Scope. A due callback must obtain its fresh authority,
 * passage store and environment from the borrowed graph; the clock grants none. */
export const startNativeRecurrenceClock = Effect.fn("missions.startNativeRecurrenceClock")(function* (
  input: RecurrenceClockPlacement,
  due: NativePassageDue,
  ctx: Pick<Plugin.Context, "storage" | "location">,
  clock: { now(): number; sleep(ms: number): Effect.Effect<void> } = { now: Date.now, sleep: Effect.sleep },
) {
  const exactCtx = { storage: ctx.storage, location: ctx.location }
  const nativeClock = yield* Clock.Clock
  const job = yield* jobTag, locations = yield* mapTag, session = yield* sessionTag
  // Process-global native services are absent from a borrowed Location graph (2.0.26 builds
  // Locations over a shared global layer). Retain exactly these; Location services stay fresh.
  const database = yield* databaseTag, bus = yield* Effect.serviceOption(busTag)
  const borrow = (graph: Context.Context<never>) => {
    const withGlobals = graph.pipe(Context.add(databaseTag, database), Context.add(sessionTag, session), Context.add(jobTag, job))
    return Option.isSome(bus) ? Context.add(withGlobals, busTag, bus.value) : withGlobals
  }
  const ref = Schema.decodeUnknownSync(Location.Ref)({ directory: input.directory,
    ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }) })
  const id = jobID(input), metadata = { projectID: input.projectID,
    projectCanonical: input.projectCanonical, directory: input.directory, scheduleID: input.scheduleID,
    ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
    profileID: input.profileID, executionHost: input.executionHost }
  const existing = yield* job.get(id)
  if (existing?.status === "running") {
    if (JSON.stringify(existing.metadata) !== JSON.stringify(metadata)) throw new Error("Recurrence Job generation changed")
    return existing
  }
  const run = Effect.scoped(Effect.gen(function* () {
    // While a passage is pending, a native execution terminal event wakes settlement promptly.
    const settled = yield* nativeExecutionSettledSignal(Option.getOrUndefined(bus))
    let pendingWakes = 0
    // Each wake borrows and validates a fresh Location graph. No minute polling.
    while (true) {
      settled.reset()
      const delay = yield* Effect.scoped(Effect.gen(function* () {
        const graph = borrow(yield* locations.contextEffect(ref))
        // Native and bundled Location.Info classes differ; validate fields, then rewrap (as the due path does).
        const location = new Location.Info(Schema.decodeUnknownSync(Schema.toType(Schema.Struct(Location.Info.fields)))(Context.get(graph, locationTag)))
        if (location.directory !== input.directory || location.workspaceID !== input.workspaceID
          || location.project.id !== input.projectID
          || location.project.canonical !== input.projectCanonical) throw new Error("Recurrence Location changed")
        const entry = nativeLocationEntry(locations.rcMap.state, ref)
        if (Option.isNone(entry)) throw new Error("Recurrence Location unavailable")
        const current = (): true => {
          const actual = nativeLocationEntry(locations.rcMap.state, ref)
          if (Option.isNone(actual) || actual.value !== entry.value) throw new Error("Recurrence Location replaced")
          return true
        }
        const source = yield* acquireNativeRecurrenceStore({ storage: exactCtx.storage, location }).pipe(Effect.provide(graph))
        let document = yield* Effect.promise(() => source.read(input.scheduleID))
        current()
        if (!document || document.state !== "running") return null
        const now = clock.now(), dueAt = recurrenceNextDueAt(document, now)
        if (!document.pending && dueAt > now) return Math.min(dueAt - now, 3_600_000)
        const beforeRevision = document.revision
        const controller = new AbortController()
        const invocation = due(input.scheduleID, () => {
            const current = nativeLocationEntry(locations.rcMap.state, ref)
            if (Option.isNone(current) || current.value !== entry.value) {
              throw new Error("Recurrence Location replaced")
            }
            return true
          }, controller.signal)
        yield* invocation.pipe(Effect.provide(graph),
          Effect.ensuring(Effect.sync(() => controller.abort())))
        document = yield* Effect.promise(() => source.read(input.scheduleID))
        current()
        if (!document || document.state !== "running") return null
        const after = clock.now()
        const next = document.pending ? nextDailyDue(document.config.clock, after).at : recurrenceNextDueAt(document, after)
        if (!document.pending && next <= after && document.revision === beforeRevision) throw new Error("recurrence-passage-state-unknown")
        pendingWakes = document.pending ? pendingWakes + 1 : 0
        return Math.min(next - after, 3_600_000)
      }))
      // A healthy accepted passage stays pending until its terminal archive;
      // polling it never admits another effect, but must not retire tomorrow's Job.
      if (delay === null) return "inactive"
      if (delay <= 0) continue
      const sleep = (ms: number) => clock.sleep(Math.max(1, ms)).pipe(Effect.provideService(Clock.Clock, nativeClock))
      if (!pendingWakes) yield* sleep(delay)
      else if (settled.supported) yield* Effect.raceFirst(sleep(delay), settled.wait.pipe(Effect.andThen(sleep(SETTLED_EVENT_DEBOUNCE_MS))))
      else yield* sleep(Math.min(delay, PENDING_FALLBACK_BACKOFF_MS[Math.min(pendingWakes, PENDING_FALLBACK_BACKOFF_MS.length) - 1]!))
    }
  })).pipe(Effect.catchCause(cause => Effect.scoped(Effect.gen(function* () {
    if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause)
    const graph = borrow(yield* locations.contextEffect(ref))
    const source = yield* acquireNativeRecurrenceStore(exactCtx).pipe(Effect.provide(graph))
    yield* Effect.promise(() => source.recordClockError(input.scheduleID, () => true)).pipe(Effect.catchCause(() => Effect.void))
    return yield* Effect.failCause(cause)
  }))), Effect.updateContext((_origin: Context.Context<never>) => Context.empty()))
  const started = yield* job.start({ id, type: "codenomad.missions.recurrence", metadata, run })
  if (JSON.stringify(started.metadata) !== JSON.stringify(metadata)) {
    throw new Error("Recurrence Job generation changed")
  }
  return started
})

/** Pause/Stop commits the desired state before calling this. */
export const cancelNativeRecurrenceClock = Effect.fn("missions.cancelNativeRecurrenceClock")(function* (input: RecurrenceClockPlacement) {
  return yield* (yield* jobTag).cancel(jobID(input))
})

export function recurrenceNextDueAt(document: RecurrenceDocument, now: number): number {
  const latest = latestDailyDue(document.config.clock, now)
  return isNewDailyDue(document, latest) ? latest.at : nextDailyDue(document.config.clock, now).at
}
