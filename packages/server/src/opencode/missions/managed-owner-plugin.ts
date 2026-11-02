import { Plugin, Rpc } from "@opencode/plugin/effect"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Context, Effect, Exit, Scope } from "effect"
import { desktopPlugin as promisePlugin } from "./desktop-plugin"
import { CODENOMAD_MISSIONS_RPC_ID, CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { readNativeRecurrenceSnapshot } from "./native-recurrence-snapshot"
import { readNativeRecurrenceControlStatus } from "./native-recurrence-control-status"
import { controlNativeRecurrence } from "./native-recurrence-control"
import { nativeRecurrenceHandlers } from "./native-recurrence-create"
import { HUMAN_ANSWER_RPC } from "../../missions/human-answer"
import { acquireNativeHumanAnswers, nativeHumanAnswerGate } from "./native-human-answer"
import { readNativeRecurrenceCurrent, readNativeRecurrenceCurrentContent } from "./native-recurrence-current"
import { readNativeRecurrencePage } from "./native-recurrence-reader"
import { runNativeRecurrenceNow, readNativeRecurrenceRunNow } from "./native-recurrence-manual"
import { nativeInvocation } from "./native-invocation"
import { acquireNativeMissionDocumentStore } from "./native-mission-document-storage"
import type { MissionDocumentAccess } from "../../missions/mission-document-one-time"
import { applyMissionDocumentActivation } from "../../missions/mission-document-activation-rpc"
import type { NativeScheduleArtifacts } from "./native-schedule-installation"
import { nativeMissionScheduleHandlers } from "./native-mission-schedule-rpc"
import { registerNativeMissionScheduleRuntime } from "./native-mission-schedule-runtime"
import { useNativeMissionDocuments } from "./native-mission-document-access"

export function withNativeRecurrenceRpc(ctx: Plugin.Context, artifacts?: NativeScheduleArtifacts): Plugin.Context["rpc"] {
  const documentInvocation = nativeInvocation()
  const register: typeof ctx.rpc.register = (definition, handlers) => ctx.rpc.register(definition,
    definition.id === CODENOMAD_MISSIONS_RPC_ID
      ? { ...handlers, ...nativeMissionScheduleHandlers(ctx, artifacts),
        documentCapabilities: () => acquireNativeMissionDocumentStore(ctx).pipe(Effect.as({ version: 1 as const }), Effect.orDie),
        documentActivation: (input: unknown) => documentInvocation.capture(Effect.tryPromise({
          try: () => documentInvocation.check(run => run(Effect.gen(function* () {
            const store = yield* acquireNativeMissionDocumentStore(ctx, run)
            return yield* Effect.tryPromise({ try: () => applyMissionDocumentActivation(store, input, () => true, ctx.location.directory), catch: error => error })
          }))), catch: error => error,
        })).pipe(Effect.orDie), recurrenceSnapshot: () => readNativeRecurrenceSnapshot(ctx),
        ...nativeRecurrenceHandlers(ctx), recurrencePassageRead: (input: unknown) => readNativeRecurrencePage(ctx, input),
        recurrenceCurrent: (input: unknown) => readNativeRecurrenceCurrent(ctx, input),
        recurrenceCurrentContent: (input: unknown) => readNativeRecurrenceCurrentContent(ctx, input),
        recurrenceControl: (input: unknown) => controlNativeRecurrence(ctx, input),
        recurrenceRunNow: (input: unknown) => runNativeRecurrenceNow(ctx, input),
        recurrenceRunNowStatus: (input: unknown) => readNativeRecurrenceRunNow(ctx, input),
        recurrenceControlStatus: (input: unknown) => readNativeRecurrenceControlStatus(ctx, input) } as typeof handlers
      : handlers)
  return new Proxy(ctx.rpc, { get(target, key) {
    return key === "register" ? register : Reflect.get(target, key)
  } })
}

// The Promise adapter preserves the shipped Missions plugin. Recurrence reads
// and paused CREATE run in the sealed service Effect graph. The retired signed
// `authority-v2` namespace and its managed-owner observer are not part of the
// shipped lifecycle: setup never reads, creates or repairs those bytes.
export function desktopPlugin(presenceDirectory: string | readonly string[], artifacts?: NativeScheduleArtifacts) {
  return Plugin.define({ id: "codenomad.missions", effect: ctx => Effect.gen(function* () {
    const graph = yield* Effect.context<Scope.Scope>()
    const scope = yield* Scope.make()
    const run = Effect.runPromiseWith(Context.add(graph, Scope.Scope, scope))
    const invocation = nativeInvocation()
    const documents: MissionDocumentAccess = use => invocation.check(run => run(useNativeMissionDocuments(ctx, run, use)))
    const humanGate = nativeHumanAnswerGate(use => invocation.check(run => run(Effect.gen(function* () {
      const answers = yield* acquireNativeHumanAnswers(ctx, run)
      return yield* Effect.tryPromise({ try: () => use(answers), catch: error => error })
    }))))
    // Keep schedule RPC available without desktop presence. One-shot handlers
    // remain dynamically bound to their existing presence-owned registration.
    type Handlers = Record<string, (...args: never[]) => Effect.Effect<unknown, unknown>>
    let ordinary: Handlers | undefined
    const forwarding = Object.fromEntries(Object.keys(CODENOMAD_MISSIONS_RPC.methods).map(name => [name,
      (...args: never[]) => invocation.capture(Effect.suspend(() => ordinary?.[name]?.(...args)
        ?? Effect.die(new Error("CodeNomad Missions is no longer available"))))]))
    const persistent = yield* withNativeRecurrenceRpc(ctx, artifacts).register(CODENOMAD_MISSIONS_RPC,
      forwarding as Parameters<typeof ctx.rpc.register<typeof CODENOMAD_MISSIONS_RPC>>[1]).pipe(Effect.orDie)
    const documentBusiness = yield* registerNativeMissionScheduleRuntime(ctx, artifacts, invocation).pipe(Effect.orDie)
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
        try { await run(fromPromise(promisePlugin(presenceDirectory, humanGate, documents, documentBusiness)).effect(nativeCtx)) }
        catch (error) { await Effect.runPromise(Scope.close(scope, Exit.void)); throw error }
        return scope
    }), owned => Scope.close(owned, Exit.void))
  }) })
}
