import plugin from "./plugin"
import { followPresence, observeDesignRequest, PRESENCE_INTERVAL_MS } from "./presence"
import { Plugin } from "@opencode/plugin/effect"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Context, Effect, Exit, Predicate, Scope } from "effect"
import { fileURLToPath } from "node:url"
import { registerPendingSnapshot } from "./pending-snapshot"
import { loadDesignContent } from "../design/content"
import { registerDesign } from "../design/register"

// The bundled factory is wrapped by a tiny auto-discovered native entry.
// Backend presence owns the history/pruning RPCs and the Code Mode session_search tool.
export function desktopPlugin(presenceDirectory: string | readonly string[]) {
  return Plugin.define({
    id: plugin.id,
    effect: (ctx) => Effect.gen(function* () {
      // At load, never from presence: a late registration would bypass the user's
      // permissions and override their own agent or skills.
      yield* registerDesign(ctx, observeDesignRequest(presenceDirectory), loadDesignContent,
        fileURLToPath(import.meta.url), PRESENCE_INTERVAL_MS)
      const context = yield* Effect.context<Scope.Scope>()
      // The published Promise adapter preserves all existing setup/cleanup and RPC semantics.
      // Only registration runs in this sealed setup context; pending handlers inherit their later HTTP caller.
      yield* Effect.acquireRelease(Effect.promise(() => followPresence(presenceDirectory, async () => {
        const scope = await Effect.runPromise(Scope.make())
        const run = Effect.runPromiseWith(Context.add(context, Scope.Scope, scope))
        const close = () => Effect.runPromise(Scope.close(scope, Exit.void))
        try {
          const adapted = fromPromise(plugin)
          if (!Predicate.isFunction(adapted?.effect)) throw new Error("Unsupported native Promise plugin adapter")
          const setup = adapted.effect(ctx)
          if (!Effect.isEffect(setup)) throw new Error("Unsupported native Promise plugin adapter effect")
          await run(setup)
          await run(registerPendingSnapshot(ctx))
        } catch (error) {
          await close()
          throw error
        }
        return close
      })), (stop) => Effect.promise(stop))
    }),
  })
}
