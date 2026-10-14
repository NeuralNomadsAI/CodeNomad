import plugin from "./plugin"
import { followPresence } from "./presence"
import { Plugin } from "@opencode/plugin/effect"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Context, Effect, Exit, Predicate, Scope } from "effect"
import { registerPendingSnapshot } from "./pending-snapshot"

// The bundled factory is wrapped by a tiny auto-discovered native entry.
// No tools, commands or model hooks are registered, even while CodeNomad is open.
export function desktopPlugin(presenceDirectory: string | readonly string[]) {
  return Plugin.define({
    id: plugin.id,
    effect: (ctx) => Effect.gen(function* () {
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
