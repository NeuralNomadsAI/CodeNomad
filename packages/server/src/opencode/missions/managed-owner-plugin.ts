import { Plugin, Rpc } from "@opencode/plugin/effect"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Context, Effect, Exit, Scope } from "effect"
import { z } from "zod"
import { desktopPlugin as promisePlugin } from "./desktop-plugin"
import { enrollmentSchema, observeNativeManagedOwner } from "./native-managed-owner"
import { CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import { readNativeRecurrenceSnapshot } from "./native-recurrence-snapshot"
import { readNativeRecurrenceControlStatus } from "./native-recurrence-control-status"
import { controlNativeRecurrence } from "./native-recurrence-control"
import { nativeRecurrenceHandlers } from "./native-recurrence-create"
import { HUMAN_ANSWER_RPC, type NativeHumanAnswerGate } from "../../missions/human-answer"
import { acquireNativeHumanAnswers } from "./native-human-answer"
import { readNativeRecurrenceCurrent, readNativeRecurrenceCurrentContent } from "./native-recurrence-current"
import { readNativeRecurrencePage } from "./native-recurrence-reader"

export const MANAGED_OWNER_RPC_ID = "codenomad.missions.managed-owner"
export const MANAGED_OWNER_RPC = Rpc.define({ id: MANAGED_OWNER_RPC_ID, methods: {
  observe: { input: z.object({}).strict(), output: z.object({
    projectID: z.string(), projectCanonical: z.string(), directory: z.string(),
    enrollment: enrollmentSchema, storageChallengeVerified: z.literal(true),
  }).strict() },
}, events: {} })

export function withNativeRecurrenceRpc(ctx: Plugin.Context): Plugin.Context["rpc"] {
  const register: typeof ctx.rpc.register = (definition, handlers) => ctx.rpc.register(definition,
    definition.id === CODENOMAD_MISSIONS_RPC_ID
      ? { ...handlers, recurrenceSnapshot: () => readNativeRecurrenceSnapshot(ctx),
        ...nativeRecurrenceHandlers(ctx), recurrencePassageRead: (input: unknown) => readNativeRecurrencePage(ctx, input),
        recurrenceCurrent: (input: unknown) => readNativeRecurrenceCurrent(ctx, input),
        recurrenceCurrentContent: (input: unknown) => readNativeRecurrenceCurrentContent(ctx, input),
        recurrenceControl: (input: unknown) => controlNativeRecurrence(ctx, input),
        recurrenceControlStatus: (input: unknown) => readNativeRecurrenceControlStatus(ctx, input) } as typeof handlers
      : handlers)
  return new Proxy(ctx.rpc, { get(target, key) {
    return key === "register" ? register : Reflect.get(target, key)
  } })
}

// The Promise adapter preserves the shipped Missions plugin. Recurrence reads
// and paused CREATE run in the sealed service Effect graph.
export function desktopPlugin(presenceDirectory: string | readonly string[]) {
  return Plugin.define({ id: "codenomad.missions", effect: ctx => Effect.gen(function* () {
    let ownerReady = false
    let ownerRpcReady = false
    const graph = yield* Effect.context<Scope.Scope>()
    const scope = yield* Scope.make()
    const run = Effect.runPromiseWith(Context.add(graph, Scope.Scope, scope))
    const humanGate: NativeHumanAnswerGate = request => run(Effect.gen(function* () {
      const answers = yield* acquireNativeHumanAnswers(ctx)
      return yield* Effect.promise(() => answers.verify(request))
    }).pipe(Effect.orDie))
    const nativeCtx = { ...ctx, rpc: withNativeRecurrenceRpc(ctx) }
    yield* ctx.rpc.register(Rpc.define(HUMAN_ANSWER_RPC), {
      binding: input => Effect.gen(function* () { const answers = yield* acquireNativeHumanAnswers(ctx); return yield* Effect.promise(() => answers.binding(input)) }).pipe(Effect.orDie),
      reply: input => Effect.gen(function* () { const answers = yield* acquireNativeHumanAnswers(ctx); return yield* Effect.promise(() => answers.reply(input)) }).pipe(Effect.orDie),
      verify: input => Effect.gen(function* () { const answers = yield* acquireNativeHumanAnswers(ctx); return yield* Effect.promise(() => answers.verify(input)) }).pipe(Effect.orDie),
    }).pipe(Effect.orDie)
    yield* Effect.acquireRelease(Effect.promise(async () => {
        try {
          await run(fromPromise(promisePlugin(presenceDirectory, ready => { ownerReady = ready }, humanGate)).effect(nativeCtx))
          try { await run(ctx.rpc.register(MANAGED_OWNER_RPC, { observe: () => Effect.scoped(
            Effect.gen(function* () {
              if (!ownerReady || !ownerRpcReady) return yield* Effect.fail(new Error("Native owner authority unavailable"))
              const result = yield* observeNativeManagedOwner(ctx)
              if (!ownerReady || !ownerRpcReady) return yield* Effect.fail(new Error("Native owner authority changed"))
              return {
              ...result, projectID: ctx.location.project.id, projectCanonical: ctx.location.project.canonical,
              directory: ctx.location.directory,
              }
            }).pipe(Effect.orDie),
          ) })); ownerRpcReady = true }
          catch { ownerRpcReady = false } // Optional native observation cannot unload the independent one-shot plugin.
        } catch (error) { await Effect.runPromise(Scope.close(scope, Exit.void)); throw error }
        return scope
    }), owned => Scope.close(owned, Exit.void))
  }) })
}
