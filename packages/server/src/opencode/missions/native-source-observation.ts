import { Context, Effect, Option, Predicate, Schema, Scope } from "effect"
import { Location } from "@opencode/schema/location"
import { acquireNativePassageObservation, type NativePassageObservation } from "./native-passage-observation"
import { nativeLocationEntry } from "./native-service-clock"
import type { MissionNativeRunner } from "./native-service-adapter"

const tag = (name: string) => Context.Service<never, unknown>(name)
const locationsTag = tag("@opencode/example/LocationServiceMap"), locationTag = tag("@opencode/Location")
const databaseTag = tag("@opencode/storage/Database"), sessionTag = tag("@opencode/Session")

/** Only the explicitly selected source's Location is borrowed, for this RPC's
 * lifetime. Global Session/Database stay pinned to the receiving service graph. */
export const acquireNativeSourceObservation = Effect.fn("missions.acquireSourceObservation")(function* (
  run: MissionNativeRunner, current: () => true,
) {
  const scope = yield* Scope.Scope, origin = yield* Effect.context<never>()
  const locations = Context.getOption(origin, locationsTag)
  return async (placement: { directory: string; workspaceID?: string }, projectID: string, canonical: string): Promise<NativePassageObservation> => {
    if (Option.isNone(locations)) throw new Error("Mission source Location graph unavailable")
    const map = locations.value as { contextEffect(ref: typeof Location.Ref.Type): Effect.Effect<Context.Context<never>, unknown, Scope.Scope>;
      rcMap: { state: Parameters<typeof nativeLocationEntry>[0] } }
    if (!Predicate.isFunction(map.contextEffect)) throw new Error("Mission source Location graph unavailable")
    const ref = Schema.decodeUnknownSync(Location.Ref)(placement)
    return run(Effect.gen(function* () {
      current()
      const local = yield* map.contextEffect(ref)
      const actual = Schema.decodeUnknownSync(Schema.toType(Schema.Struct(Location.Info.fields)))(Context.get(local, locationTag))
      if (actual.directory !== placement.directory || actual.workspaceID !== placement.workspaceID
        || actual.project.id !== projectID || actual.project.canonical !== canonical) throw new Error("Mission source Location differs")
      const entry = nativeLocationEntry(map.rcMap.state, ref)
      if (Option.isNone(entry)) throw new Error("Mission source Location unavailable")
      const graph = local.pipe(Context.add(databaseTag, Context.get(origin, databaseTag)), Context.add(sessionTag, Context.get(origin, sessionTag)))
      const scopedRun: MissionNativeRunner = effect => run(effect.pipe(Effect.provide(graph)))
      const observation = yield* acquireNativePassageObservation(undefined, scopedRun).pipe(Effect.provide(graph))
      return { ...observation, assertCurrent: (): true => {
        current(); observation.assertCurrent()
        const fresh = nativeLocationEntry(map.rcMap.state, ref)
        if (Option.isNone(fresh) || fresh.value !== entry.value) throw new Error("Mission source Location replaced")
        return true
      } }
    }).pipe(Effect.provideService(Scope.Scope, scope)))
  }
})
