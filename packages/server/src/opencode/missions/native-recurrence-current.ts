import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Schema } from "effect"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { currentRecurrenceContent, recurrenceCurrentInput, recurrenceCurrentContentInput } from "../../missions/recurrence-current"
import { recurrencePassage } from "../../missions/recurrence-passage"
import type { MissionStorage } from "../../missions/journal"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"

const locationTag = Context.Service<never, unknown>("@opencode/Location")
const equal = (a: unknown, b: unknown) => canonicalAuthority(a ?? null, 256 * 1024) === canonicalAuthority(b ?? null, 256 * 1024)

/** Pending calendar + isolated business journal are reader authority. No signer,
 * owner challenge, scheduling, native messages or effects during display. */
const readCurrent = Effect.fn("missions.readNativeRecurrenceCurrent")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location">, raw: unknown, content: boolean,
) {
  const input = content ? recurrenceCurrentContentInput.parse(raw) : recurrenceCurrentInput.parse(raw)
  const origin = yield* Effect.serviceOption(locationTag)
  if (Option.isNone(origin)) throw new Error("Native recurrence Location unavailable")
  const location = yield* Schema.decodeUnknownEffect(Schema.toType(Schema.Struct(Location.Info.fields)))(origin.value)
  const current = (): true => {
    if (location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
      || location.project.id !== ctx.location.project.id || location.project.canonical !== ctx.location.project.canonical)
      throw new Error("Recurrence Location changed")
    return true
  }
  current()
  const store = yield* acquireNativeRecurrenceStore(ctx)
  const doc = yield* Effect.promise(() => store.read(input.scheduleID))
  if (!doc || !doc.config.roots.some(root => root.directory === location.directory)) throw new Error("Current recurrence schedule unavailable")
  const identity = { version: 1 as const, projectID: location.project.id, projectCanonical: location.project.canonical,
    location: { directory: location.directory, ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }) }, scheduleID: doc.id }
  const graph = yield* Effect.context<never>()
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect.pipe(Effect.provide(graph)))
  let bytes = 0
  const storage: MissionStorage = {
    get: key => run(ctx.storage.get(key)) as ReturnType<MissionStorage["get"]>,
    set: async () => { throw new Error("Current passage reader is read-only") },
    scan: async options => {
      current()
      const page = await run(ctx.storage.scan(options)) as Awaited<ReturnType<MissionStorage["scan"]>>
      // ponytail: bounded journal display; add checkpoints beyond 32 MiB.
      for (const entry of page.entries) bytes += Buffer.byteLength(canonicalAuthority(entry.value, 256 * 1024))
      if (bytes > 32 * 1024 * 1024) throw new Error("Current passage journal capacity")
      return page
    },
  }
  let mission
  if (doc.pending) {
    if ("passageID" in input && input.passageID !== doc.pending.passage.id) throw new Error("Current passage changed")
    const passage = recurrencePassage(storage, doc, current)
    const snapshot = yield* Effect.promise(() => passage.journal.snapshot())
    if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.missions.length > 1)
      throw new Error("Current passage journal unavailable")
    mission = snapshot.missions[0]
    if (mission && (mission.id !== passage.missionID || mission.coordinatorSessionId !== passage.coordinatorSessionID
      || !equal(mission.profiles, doc.config.profiles) || mission.taskMode !== doc.config.taskMode)) throw new Error("Current passage identity differs")
    if (mission) {
      const events = yield* Effect.promise(() => passage.journal.events())
      if (events.discardedEvents || !events.events.some(event => event.type === "mission.created"
        && event.missionID === passage.missionID && event.requestID === passage.passageID)) throw new Error("Current passage creation differs")
    }
  }
  const fresh = yield* Effect.promise(() => store.read(doc.id))
  current()
  if (!fresh || !equal(fresh, doc)) throw new Error("Current passage changed")
  if (content) {
    if (!mission) throw new Error("Current passage content unavailable")
    return { ...currentRecurrenceContent(mission, input), projectCanonical: identity.projectCanonical, location: identity.location }
  }
  return { ...identity, passageID: doc.pending?.passage.id ?? null, ...(mission ? { mission } : {}) }
})

export const readNativeRecurrenceCurrent = (ctx: Pick<Plugin.Context, "storage" | "location">, input: unknown) => readCurrent(ctx, input, false)
export const readNativeRecurrenceCurrentContent = (ctx: Pick<Plugin.Context, "storage" | "location">, input: unknown) => readCurrent(ctx, input, true)
