import { Plugin, Rpc } from "@opencode/plugin/effect"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Context, Effect, Exit, Scope } from "effect"
import { desktopPlugin as promisePlugin } from "./desktop-plugin"
import { CODENOMAD_MISSIONS_RPC_ID, CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { HUMAN_ANSWER_RPC } from "../../missions/human-answer"
import { acquireNativeHumanAnswers, nativeHumanAnswerGate } from "./native-human-answer"
import { nativeInvocation } from "./native-invocation"
import { acquireNativeMissionDocumentStore } from "./native-mission-document-storage"
import type { MissionDocumentAccess } from "../../missions/mission-document-one-time"
import { useNativeMissionDocuments } from "./native-mission-document-access"
import { optionalOrdinaryJournalRange } from "./ordinary-journal-range"
import type { NativeJournalRange } from "./native-journal-range"
import { registerNativeCoordinatorGoalRuntime } from "./native-coordinator-goal"

/** The native request graph answers what a one-time Mission's document needs of this service. */
export function withNativeDocumentRpc(ctx: Plugin.Context): Plugin.Context["rpc"] {
  const register: typeof ctx.rpc.register = (definition, handlers) => ctx.rpc.register(definition,
    definition.id === CODENOMAD_MISSIONS_RPC_ID
      ? { ...handlers, documentCapabilities: () => acquireNativeMissionDocumentStore(ctx).pipe(Effect.as({
          version: 1 as const, automaticStart: true as const, rootPermissions: true as const,
        }), Effect.orDie) } as typeof handlers
      : handlers)
  return new Proxy(ctx.rpc, { get(target, key) {
    return key === "register" ? register : Reflect.get(target, key)
  } })
}

// The Promise adapter preserves the shipped Missions plugin; document reads run in the
// sealed service Effect graph.
export function desktopPlugin(presenceDirectory: string | readonly string[]) {
  return Plugin.define({ id: "codenomad.missions", effect: ctx => Effect.gen(function* () {
    const graph = yield* Effect.context<Scope.Scope>()
    const scope = yield* Scope.make()
    const run = Effect.runPromiseWith(Context.add(graph, Scope.Scope, scope))
    // Presence and outbox reads also run outside tool/RPC invocations. The
    // range uses only the activation's database service and owned scope.
    const invocation = nativeInvocation()
    const setupRange = yield* optionalOrdinaryJournalRange(ctx, run)
    const readRange = <A>(use: (range: NativeJournalRange) => Promise<A>): Promise<A> => {
      return invocation.check(async run => {
        const range = await run(optionalOrdinaryJournalRange(ctx, run))
        if (!range) throw new Error("Native Mission journal database unavailable")
        return use(range)
      })
    }
    const journalRange: NativeJournalRange = {
      listRanges: () => readRange(range => range.listRanges()),
      readOrdered: (...args) => readRange(range => range.readOrdered(...args)),
      readEvent: (...args) => readRange(range => range.readEvent(...args)),
      readDisplay: (...args) => readRange(range => range.readDisplay!(...args)),
      saveDisplay: (...args) => readRange(range => range.saveDisplay!(...args)),
    }
    // On a cold daemon the setup graph can lack the database even though the
    // request graph has it. Background work keeps its setup-owned capability.
    const currentJournalRange = () => invocation.active() ? journalRange : setupRange
    const documents: MissionDocumentAccess = use => invocation.check(run => run(useNativeMissionDocuments(ctx, run, use)))
    const humanGate = nativeHumanAnswerGate(use => invocation.check(run => run(Effect.gen(function* () {
      const answers = yield* acquireNativeHumanAnswers(ctx, run)
      return yield* Effect.tryPromise({ try: () => use(answers), catch: error => error })
    }))))
    // The RPC stays registered without desktop presence; its handlers are bound
    // to their presence-owned registration.
    type Handlers = Record<string, (...args: never[]) => Effect.Effect<unknown, unknown>>
    let ordinary: Handlers | undefined
    const forwarding = Object.fromEntries(Object.keys(CODENOMAD_MISSIONS_RPC.methods).map(name => [name,
      (...args: never[]) => invocation.capture(Effect.suspend(() => ordinary?.[name]?.(...args)
        ?? Effect.die(new Error("CodeNomad Missions is no longer available"))))]))
    const persistent = yield* withNativeDocumentRpc(ctx).register(CODENOMAD_MISSIONS_RPC,
      forwarding as Parameters<typeof ctx.rpc.register<typeof CODENOMAD_MISSIONS_RPC>>[1]).pipe(Effect.orDie)
    const coordinatorGoal = yield* registerNativeCoordinatorGoalRuntime(ctx, invocation).pipe(Effect.orDie)
    const register: typeof ctx.rpc.register = (definition, handlers) => definition.id !== CODENOMAD_MISSIONS_RPC_ID
      ? ctx.rpc.register(definition, handlers)
      : Effect.sync(() => {
        const selected = handlers as unknown as Handlers
        ordinary = selected
        return { events: persistent.events, dispose: Effect.sync(() => { if (ordinary === selected) ordinary = undefined }) }
      }) as ReturnType<typeof ctx.rpc.register>
    const transform: typeof ctx.tool.transform = callback => ctx.tool.transform(editor => callback(new Proxy(editor, {
      get(target, key) {
        if (key !== "add") return Reflect.get(target, key)
        const add: typeof editor.add = definition => editor.add({ ...definition,
          execute: (input, context) => invocation.capture(definition.execute(input, context)) })
        return add
      },
    })))
    const hook: typeof ctx.session.hook = (name, callback, options) => ctx.session.hook(name,
      input => invocation.capture(callback(input)), options)
    const nativeCtx = { ...ctx, tool: new Proxy(ctx.tool, { get(target, key) {
      return key === "transform" ? transform : Reflect.get(target, key)
    } }), session: new Proxy(ctx.session, { get(target, key) {
      return key === "hook" ? hook : Reflect.get(target, key)
    } }), rpc: new Proxy(ctx.rpc, { get(target, key) {
      return key === "register" ? register : Reflect.get(target, key)
    } }) }
    yield* ctx.rpc.register(Rpc.define(HUMAN_ANSWER_RPC), {
      binding: input => Effect.gen(function* () { const answers = yield* acquireNativeHumanAnswers(ctx); return yield* Effect.promise(() => answers.binding(input)) }).pipe(Effect.orDie),
      reply: input => Effect.gen(function* () { const answers = yield* acquireNativeHumanAnswers(ctx); return yield* Effect.promise(() => answers.reply(input)) }).pipe(Effect.orDie),
      verify: input => Effect.gen(function* () { const answers = yield* acquireNativeHumanAnswers(ctx); return yield* Effect.promise(() => answers.verify(input)) }).pipe(Effect.orDie),
    }).pipe(Effect.orDie)
    yield* Effect.acquireRelease(Effect.promise(async () => {
         try { await run(fromPromise(promisePlugin(presenceDirectory, humanGate, documents, currentJournalRange, coordinatorGoal)).effect(nativeCtx)) }
        catch (error) { await Effect.runPromise(Scope.close(scope, Exit.void)); throw error }
        return scope
    }), owned => Scope.close(owned, Exit.void))
  }) })
}
