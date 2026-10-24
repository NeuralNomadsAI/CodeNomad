import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect } from "effect"
import { realpathSync } from "node:fs"
import { physical } from "../../missions/physical-path"
import { createFamilyAuthorityIdentityFence, readFamilyAuthorityPlacement } from "../../workspaces/family-authority-claim"
import { qualifyNativeRecurrenceControl } from "./native-recurrence-capability"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"

const locationTag = Context.Service<never, Location.Info>("@opencode/Location")

/** Read-only origin qualification for an authenticated recurrence effect: the
 * actual native graph, the exact borrowed Location and the schedule's single owned
 * Git root with its physical family. Fails before any CAS or native effect.
 * `rootCurrent` is the synchronous recheck callers run before each CAS/native
 * effect and after IO; it resolves Git only when captured routing inputs change. */
export const qualifyNativeRecurrenceOrigin = Effect.fn("missions.qualifyRecurrenceOrigin")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location">, input: { scheduleID: string; location: { directory: string; workspaceID?: string } },
) {
  yield* qualifyNativeRecurrenceControl()
  const location = yield* locationTag
  if (location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
    || location.project.id !== ctx.location.project.id || location.project.canonical !== ctx.location.project.canonical
    || input.location.directory !== location.directory || input.location.workspaceID !== location.workspaceID) throw new Error("Recurrence Location changed")
  const store = yield* acquireNativeRecurrenceStore(ctx)
  const before = yield* Effect.promise(() => store.read(input.scheduleID))
  if (!before || before.config.roots.length !== 1 || before.config.roots[0].directory !== location.directory) throw new Error("Recurrence scope changed")
  const root = before.config.roots[0]
  if (root.mode !== "git") throw new Error("Recurrence physical root changed")
  // Resolve with Git once, asynchronously; every synchronous CAS guard then rereads
  // the captured routing inputs and falls back to Git only when they changed.
  // A per-guard spawnSync timed out on loaded hosts as policy-unqualified.
  const family = yield* Effect.promise(() => createFamilyAuthorityIdentityFence(root.directory))
  const actual = yield* Effect.tryPromise({ try: () => readFamilyAuthorityPlacement(root.directory), catch: error => error })
  if (actual.checkout !== root.checkout || actual.family !== root.family) throw new Error("Recurrence physical root changed")
  const rootCurrent = (): true => {
    if (family() !== root.family || physical(realpathSync(root.family)) !== root.family) throw new Error("Recurrence physical root changed")
    return true
  }
  rootCurrent()
  return { location, store, before, rootCurrent }
})
