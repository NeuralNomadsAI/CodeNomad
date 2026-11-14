import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Scope } from "effect"
import type { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import type { MissionDocumentSources } from "../../missions/mission-document-one-time"
import { acquireNativeMissionDocumentStore } from "./native-mission-document-storage"
import { acquireMissionNativeService, type MissionNativeRunner } from "./native-service-adapter"
import { acquireNativeSourceFence } from "./native-source-fence"
import { prepareNativeDocumentSources } from "./native-scheduled-passage-sources"

/** Source leases stay alive through the first-Play document CAS and readback. */
export function useNativeMissionDocuments<T>(ctx: Plugin.Context, run: MissionNativeRunner,
  use: (store: NativeMissionDocumentStore, sources: MissionDocumentSources) => Promise<T>) {
  return Effect.scoped(Effect.gen(function* () {
    const scope = yield* Effect.scope
    const store = yield* acquireNativeMissionDocumentStore(ctx, run)
    return yield* Effect.tryPromise({ try: () => use(store, (document, current) => run(Effect.gen(function* () {
      const native = yield* acquireMissionNativeService(current, run)
      const fence = yield* acquireNativeSourceFence(current)
      return yield* Effect.tryPromise(() => prepareNativeDocumentSources(document, native,
        new AbortController().signal, current, undefined, fence(), true))
    }).pipe(Effect.provideService(Scope.Scope, scope)))), catch: error => error })
  }))
}
