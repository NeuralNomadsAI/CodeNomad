// Isolated qualification entrypoint; product provisioning never installs it.
import { appendFileSync, existsSync } from "node:fs"
import path from "node:path"
import cp from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { Service } from "@opencode/client/service"
import { Plugin, Rpc } from "@opencode/plugin/effect"
import { Cause, Context, Effect, Option } from "effect"
import { Session } from "@opencode/schema/session"
import { acquireNativeMissionDocumentStore } from "./native-mission-document-storage"
import { missionDocumentChanges } from "../../missions/mission-document-state"
import { NativeScheduleTransportRpc } from "./native-schedule-transport-contract"
import { registerNativeScheduleCarrierFoundation } from "./native-schedule-carrier-runtime"
import { assertOrdinaryMissionScheduleInput, claimNativeScheduleCarrierWake, type NativeScheduleCarrierInstallation } from "./native-schedule-carrier-binding"
import { nativeScheduleIncarnationGuard, readNativeScheduleIncarnation } from "./native-schedule-transport-identity"
import type { NativeScheduleWake } from "./native-schedule-transport-contract"
import { NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"

const method = { input: { type: "object" }, output: { type: "object" } } as const
const qualification = Rpc.define({ id: "codenomad.schedule-qualification", methods: {
  initialize: method, snapshot: method, forceTitle: method, ordinary: method, replay: method, claimOnly: method,
}, events: {} })

export default Plugin.define({ id: "codenomad.missions", effect: ctx => Effect.gen(function* () {
  const options = ctx.options as NativeScheduleCarrierInstallation & { logFile: string; loseFirstReply: boolean; holdCompaction?: boolean }
  const log = (event: Record<string, unknown>) => appendFileSync(options.logFile, JSON.stringify({ pid: process.pid, at: Date.now(), ...event }) + "\n")
  let inTransport = false
  const observe = (event: Record<string, unknown>) => {
    if (event.kind === "transport-start") inTransport = true
    log(event)
    if (event.kind === "transport") inTransport = false
  }
  // Qualification-only instrumentation; production registration carries none of it.
  for (const method of ["ensure", "stop"] as const) {
    const original = Service[method]
    Object.assign(Service, { [method]: (...args: never[]) => {
      if (inTransport) { log({ kind: "forbidden-lifecycle", method }); throw new Error("qualification-lifecycle") }
      return (original as (...args: never[]) => unknown)(...args)
    } })
  }
  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
    const original = cp[method]
    Object.assign(cp, { [method]: (...args: never[]) => {
      if (inTransport) { log({ kind: "forbidden-child", method }); throw new Error("qualification-child") }
      return (original as (...args: never[]) => unknown)(...args)
    } })
  }
  const kill = process.kill
  process.kill = (...args) => { if (inTransport) { log({ kind: "forbidden-signal" }); throw new Error("qualification-signal") }; return kill(...args) }
  const bun = (globalThis as { Bun?: Record<string, unknown> }).Bun
  if (bun) for (const method of ["spawn", "spawnSync"]) {
    const original = bun[method] as (...args: unknown[]) => unknown
    bun[method] = (...args: unknown[]) => {
      if (inTransport) { log({ kind: "forbidden-child", method: `Bun.${method}` }); throw new Error("qualification-child") }
      return original(...args)
    }
  }
  syncBuiltinESMExports()
  let language: unknown
  let languageCount = 0
  const wrappedLanguages = new WeakMap<object, NonNullable<import("@opencode/plugin/effect/aisdk").AISDKHooks["language"]["language"]>>()
  const register: typeof ctx.rpc.register = (definition, handlers) => {
    if (definition.id !== NativeScheduleTransportRpc.id) return ctx.rpc.register(definition, handlers)
    type Handlers = Record<string, (...args: never[]) => Effect.Effect<unknown, unknown>>
    const native = handlers as unknown as Handlers
    return ctx.rpc.register(definition, { ...handlers, wake: (...args: never[]) => Effect.gen(function* () {
      log({ kind: "rpc-wake", input: args[0] })
      const result = yield* native.wake(...args).pipe(Effect.tapCause(cause => Effect.sync(() => log({ kind: "rpc-failure", error: Cause.pretty(cause) }))))
      const raw = args[0] as unknown as { wake?: { run?: number } }
      if (options.loseFirstReply && raw?.wake?.run === 1) {
        log({ kind: "hold-ack", milliseconds: 10_000 })
        yield* Effect.sleep(10_000)
      }
      return result
    }) } as typeof handlers)
  }
  yield* registerNativeScheduleCarrierFoundation({ ...ctx, rpc: new Proxy(ctx.rpc, {
    get(target, key) { return key === "register" ? register : Reflect.get(target, key) },
  }) }, { ...options, observe })
  yield* ctx.aisdk.hook("language", event => Effect.sync(() => {
    if (event.model.providerID !== NATIVE_SCHEDULE_CARRIER_MODEL.providerID) return
    if (event.language) {
      const original = event.language
      let wrapped = wrappedLanguages.get(original)
      if (!wrapped) {
        const token = ++languageCount
        wrapped = { ...original, doStream: async input => { log({ kind: "local-stream", token }); return original.doStream(input) } }
        wrappedLanguages.set(original, wrapped)
      }
      event.language = wrapped
    }
    log({ kind: "language-cache", same: language === undefined || language === event.language, model: event.model.id })
    language = event.language
  }))
  yield* ctx.session.hook("title", event => Effect.sync(() => log({ kind: "title-result", model: event.model, local: event.result !== undefined })))
  yield* ctx.session.hook("compaction", event => Effect.gen(function* () {
    log({ kind: "compaction-result", model: event.model, local: event.result !== undefined })
    if (options.holdCompaction && !existsSync(path.join(path.dirname(options.logFile), "release-compaction"))) {
      log({ kind: "compaction-held" })
      for (let pass = 0; pass < 800; pass++) {
        if (existsSync(path.join(path.dirname(options.logFile), "release-compaction"))) { log({ kind: "compaction-released" }); return }
        yield* Effect.sleep(25)
      }
      throw new Error("qualification-compaction-release-timeout")
    }
  }))
  yield* ctx.session.hook("http.request", event => Effect.sync(() => log({ kind: "provider-http-hook", model: event.model, requestKind: event.kind })))
  yield* ctx.rpc.register(qualification, {
    initialize: raw => Effect.gen(function* () {
      const input = raw as { principal: { sessionID: string; scheduleID: string }; reconciliation: { sessionID: string; scheduleID: string } }
      const store = yield* acquireNativeMissionDocumentStore(ctx), now = Date.now(), current = () => true as const
      const selection = { agent: "build", model: { ...NATIVE_SCHEDULE_CARRIER_MODEL } }
      const configuration = { title: "Native foundation", objective: "Qualification without business admission", template: "custom" as const,
        taskMode: "native" as const, profileID: "isolated", executionHost: "isolated", profiles: { coordinator: selection, roles: { specialist: selection } },
        roots: [{ mode: "directory-only" as const, directory: ctx.location.directory }], watchedConversationIDs: [],
        launch: { timing: { kind: "every" as const, intervalMs: 90 * 60_000 }, condition: null,
          ends: { maxLaunches: 3, afterMs: 91 * 60_000, at: null } } }
      const result = yield* Effect.tryPromise({ try: async () => {
        const doc = await store.create("native_foundation", configuration, now, current)
        const played = await store.change(doc.id, doc.revision, current, value => missionDocumentChanges.play(value, "qualification_play", now, []))
        return store.change(doc.id, played.revision, current, value => missionDocumentChanges.synchronized(value, "qualification_play", [
          { ...input.principal, role: "principal", slot: 0, timeGeneration: 1, highWater: 0, wakePreparing: null, pendingWake: null },
          { ...input.reconciliation, role: "reconciliation", slot: 0, timeGeneration: 1, highWater: 0, wakePreparing: null, pendingWake: null },
        ]))
      }, catch: error => error })
      log({ kind: "initialized", revision: result.revision })
      return result
    }).pipe(Effect.orDie),
    snapshot: () => Effect.gen(function* () {
      const store = yield* acquireNativeMissionDocumentStore(ctx)
      return yield* Effect.promise(() => store.read("native_foundation"))
    }).pipe(Effect.orDie),
    forceTitle: raw => Effect.gen(function* () {
      const title = yield* Effect.serviceOption(Context.Service<never, unknown>("@opencode/SessionTitle"))
      if (Option.isNone(title)) throw new Error("qualification-title-contract")
      const service = title.value as { generate(id: ReturnType<typeof Session.ID.make>): Effect.Effect<void> }
      yield* service.generate(Session.ID.make((raw as { sessionID: string }).sessionID))
      return { generated: true }
    }),
    ordinary: raw => Effect.sync(() => {
      try { assertOrdinaryMissionScheduleInput(raw as Parameters<typeof assertOrdinaryMissionScheduleInput>[0]); return { allowed: true } }
      catch { return { allowed: false } }
    }),
    replay: raw => ctx.rpc(Rpc.define(NativeScheduleTransportRpc)).wake(raw).pipe(Effect.orDie),
    claimOnly: raw => Effect.promise(async () => {
      const incarnation = readNativeScheduleIncarnation(options.registrationFile)
      const claimed = await claimNativeScheduleCarrierWake(ctx, raw as NativeScheduleWake, incarnation, Effect.runPromise,
        nativeScheduleIncarnationGuard(options.registrationFile, incarnation))
      return { claimed }
    }),
  }).pipe(Effect.orDie)
  log({ kind: "registered", directory: ctx.location.directory })
}) })
