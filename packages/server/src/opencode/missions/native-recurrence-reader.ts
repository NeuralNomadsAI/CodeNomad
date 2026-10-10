import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Schema } from "effect"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { recurrenceReadInput } from "../../missions/recurrence-reader-contract"
import { readArchivedRecurrencePage } from "../../missions/recurrence-reader"
import { canonicalAuthority } from "../../missions/authority-protocol"
import type { MissionStorage } from "../../missions/journal"

const locationTag = Context.Service<never, unknown>("@opencode/Location")
const info = Schema.toType(Schema.Struct(Location.Info.fields))

/** Sealed native read-only graph. No owner, Job, publisher, prompt or transcript dependency. */
export const readNativeRecurrencePage = Effect.fn("missions.readNativeRecurrencePage")(function* (
  ctx: Pick<Plugin.Context, "location" | "storage">, raw: unknown,
) {
  const input = recurrenceReadInput.parse(raw), origin = yield* Effect.serviceOption(locationTag)
  if (Option.isNone(origin)) throw new Error("Native Location graph unavailable")
  const location = yield* Schema.decodeUnknownEffect(info)(origin.value)
  const assertLocation = () => {
    if (location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
      || location.project.id !== ctx.location.project.id || location.project.canonical !== ctx.location.project.canonical) throw new Error("Recurrence Location changed")
  }
  assertLocation()
  const store = yield* acquireNativeRecurrenceStore(ctx)
  const doc = yield* Effect.promise(() => store.read(input.scheduleID))
  if (!doc || !doc.config.roots.some(root => root.directory === location.directory)) throw new Error("Archived recurrence schedule unavailable")
  const receipt = doc.history.find(item => item.passage.id === input.passageID)
  if (!receipt) throw new Error("Archived recurrence receipt unavailable")
  const bound = canonicalAuthority(receipt), graph = yield* Effect.context<never>()
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect.pipe(Effect.provide(graph)))
  let bytes = 0
  const storage: MissionStorage = {
    get: async () => { throw new Error("Archived reader uses bounded journal scans only") },
    set: async () => { throw new Error("Archived reader is read-only") },
    scan: async input => {
      assertLocation()
      const page = await run(ctx.storage.scan(input)) as Awaited<ReturnType<MissionStorage["scan"]>>
      // ponytail: 32 MiB across two bounded journal passes; larger journals fail visibly rather than truncate results.
      for (const entry of page.entries) bytes += Buffer.byteLength(canonicalAuthority(entry.value, 256 * 1024), "utf8")
      if (bytes > 32 * 1024 * 1024) throw new Error("Archived recurrence journal capacity")
      assertLocation()
      return page
    },
  }
  const page = yield* Effect.promise(() => readArchivedRecurrencePage(storage, doc, input))
  const fresh = yield* Effect.promise(() => store.read(input.scheduleID))
  assertLocation()
  if (!fresh || !fresh.config.roots.some(root => root.directory === location.directory)
    || canonicalAuthority(fresh.history.find(item => item.passage.id === input.passageID)) !== bound) throw new Error("Archived recurrence receipt changed")
  return { ...page, projectCanonical: location.project.canonical,
    location: { directory: location.directory, ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }) } }
})
