import path from "node:path"
import type { Plugin } from "@opencode/plugin/effect"
import { Rpc } from "@opencode/plugin/effect"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { missionDocumentChanges } from "../../missions/mission-document-state"
import { acquireNativeMissionDocumentStore } from "./native-mission-document-storage"
import { nativeInvocation } from "./native-invocation"
import { acquireNativeMissionScheduleWakeReader } from "./native-mission-schedule-wake-reader"
import { nativeScheduleCarrierHooks, nativeScheduleCarrierWakes, nativeScheduleCarrierNonWakeMessageIDs, NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import { assertNativeScheduleCarrierArtifacts, claimNativeScheduleCarrierWake, closeNativeScheduleCarrierClaim, nativeScheduleClaimKey,
  NATIVE_SCHEDULE_CARRIER_MARKER, NATIVE_SCHEDULE_CARRIER_SIGNAL, readNativeScheduleCarrierBinding,
  type NativeScheduleCarrierInstallation } from "./native-schedule-carrier-binding"
import { NativeScheduleTransportRpc, assertNativeScheduleWake, nativeScheduleWakeKey, type NativeScheduleWake } from "./native-schedule-transport-contract"
import { assertNativeScheduleIncarnation, nativeScheduleIncarnationGuard, type NativeScheduleIncarnation } from "./native-schedule-transport-identity"
import { createNativeScheduleTransport } from "./native-schedule-transport"

type Input = { wake: NativeScheduleWake; incarnation: NativeScheduleIncarnation; registrationFile: string }
type Options = NativeScheduleCarrierInstallation & { observe?: (event: Record<string, unknown>) => void }
const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
const scheduleTag = Context.Service<never, unknown>("@opencode/Schedule")
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const pluginPrefix = `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`
const exactWakeDueAt = (raw: unknown, expected: NativeScheduleWake): number | undefined => {
  if (typeof raw !== "string") return undefined
  const data = JSON.parse(raw), wake = data.metadata?.schedule
  return wake?.id === expected.scheduleID && wake.run === expected.run && Number.isSafeInteger(wake.dueAt)
    && wake.dueAt >= 0 && typeof wake.late === "boolean" && data.text === NATIVE_SCHEDULE_CARRIER_SIGNAL ? wake.dueAt : undefined
}

/** Reusable registration, installed only by an owning durable mapping adapter.
 * Reconciliation without a pending passage has a complete no-business-effect
 * implementation. Principal wakes and pending observation remain CORE-owned. */
export function registerNativeScheduleCarrierFoundation(ctx: Plugin.Context, options: Options) {
  return Effect.gen(function* () {
    const hooks = nativeScheduleCarrierHooks(() => false), invocation = nativeInvocation()
    const transport = createNativeScheduleTransport()
    const installed = () => assertNativeScheduleCarrierArtifacts(options)
    installed()

    const handler = (mode: "wake" | "status", raw: unknown) => Effect.gen(function* () {
      const input = raw as Input
      assertNativeScheduleWake(input?.wake)
      assertNativeScheduleIncarnation(input.incarnation)
      if (input.registrationFile !== options.registrationFile) throw new Error("schedule-registration-ownership")
      const guard = nativeScheduleIncarnationGuard(options.registrationFile, input.incarnation)
      guard(); installed()
      const binding = yield* readNativeScheduleCarrierBinding(ctx, input.wake.sessionID)
      if (!binding || binding.document.id !== input.wake.missionID || binding.document.timeGeneration !== input.wake.generation
        || binding.calendar.scheduleID !== input.wake.scheduleID) throw new Error("schedule-carrier-mapping")
      const key = nativeScheduleWakeKey(input.wake)
      const reply = (state: "applied" | "pending" | "rejected" | "unknown") => ({ key, state })
      const store = yield* acquireNativeMissionDocumentStore(ctx, effect => invocation.check(run => run(effect)))
      if (binding.calendar.highWater >= input.wake.run) return reply("applied")
      const intent = yield* ctx.storage.get(nativeScheduleClaimKey(ctx, input.wake.missionID))
      const claimed = !!intent && typeof intent === "object" && "key" in intent && intent.key === key
      if (mode === "status") {
        const found = yield* Effect.serviceOption(databaseTag)
        if (Option.isNone(found)) throw new Error("schedule-native-contract")
        const client = (found.value as { db: { $client: SqlClient.SqlClient } }).db.$client
        if (!Predicate.isFunction(client?.unsafe)) throw new Error("schedule-native-contract")
        const native = yield* client.unsafe(`SELECT m.type,m.data,s.session_id,s.run_count FROM session_message m
          JOIN schedule s ON s.id=? WHERE m.id=? AND m.session_id=? AND length(CAST(m.data AS BLOB))<=262144`,
        [input.wake.scheduleID, input.wake.messageID, input.wake.sessionID]).withoutTransform.pipe(Effect.flatMap(Schema.decodeUnknownEffect(rows)))
        const message = native[0]
        const present = message?.type === "user" && message.session_id === input.wake.sessionID && Number.isSafeInteger(message.run_count)
          && Number(message.run_count) >= input.wake.run && exactWakeDueAt(message.data, input.wake) !== undefined
        guard(); installed()
        return { ...reply(claimed ? "pending" : "unknown"), ...(present ? { messagePresent: true } : {}) }
      }
      if (!claimed) return reply("unknown")
      if (binding.calendar.role !== "reconciliation" || binding.document.pending
        || input.wake.run !== binding.calendar.highWater + 1) return reply("pending")
      const nativeSchedule = yield* Effect.serviceOption(scheduleTag)
      const nativeDatabase = yield* Effect.serviceOption(databaseTag)
      if (Option.isNone(nativeSchedule) || Option.isNone(nativeDatabase)) throw new Error("schedule-native-contract")
      const schedules = nativeSchedule.value as { enabled(sessionID: string): Effect.Effect<boolean, unknown> }
      const database = nativeDatabase.value as { db?: { $client?: SqlClient.SqlClient } }
      if (!Predicate.isFunction(schedules.enabled) || !Predicate.isFunction(database.db?.$client?.unsafe)) throw new Error("schedule-native-contract")
      if (!(yield* schedules.enabled(input.wake.sessionID))) throw new Error("schedule-disabled")
      const graph = yield* Effect.context<never>()
      const query = (sql: string, params: readonly unknown[]) => Effect.runSync(database.db!.$client!.unsafe(sql, params)
        .withoutTransform.pipe(Effect.flatMap(Schema.decodeUnknownEffect(rows)), Effect.provide(graph)))
      // Native row reads use the current RPC graph outside document publication.
      // The document adapter owns its SQL transaction and revision CAS; its sync
      // guard fences process/artifact identity without acquiring a second SQL lease.
      let dueAt = 0
      const observeNative = (): true => {
        guard(); installed()
        const session = query("SELECT project_id,directory,workspace_id,parent_id,metadata,model FROM session_v2 WHERE id=?", [input.wake.sessionID])[0]
        if (!session || session.project_id !== ctx.location.project.id || typeof session.directory !== "string"
          || path.normalize(session.directory) !== path.normalize(ctx.location.directory) || session.parent_id != null
          || (session.workspace_id ?? undefined) !== ctx.location.workspaceID || typeof session.metadata !== "string" || typeof session.model !== "string")
          throw new Error("schedule-carrier-placement")
        const marker = JSON.parse(session.metadata)[NATIVE_SCHEDULE_CARRIER_MARKER]
        const model = JSON.parse(session.model)
        if (marker?.missionID !== input.wake.missionID || marker.timeGeneration !== input.wake.generation
          || marker.role !== binding.calendar.role || marker.slot !== binding.calendar.slot
          || model.providerID !== NATIVE_SCHEDULE_CARRIER_MODEL.providerID || model.id !== NATIVE_SCHEDULE_CARRIER_MODEL.id) throw new Error("schedule-carrier-placement")
        const schedule = query("SELECT session_id,run_count FROM schedule WHERE id=?", [input.wake.scheduleID])[0]
        if (!schedule || schedule.session_id !== input.wake.sessionID || !Number.isSafeInteger(schedule.run_count)
          || Number(schedule.run_count) < input.wake.run) throw new Error("schedule-native-ack-pending")
        const message = query("SELECT type,data FROM session_message WHERE id=? AND session_id=? AND length(CAST(data AS BLOB))<=262144",
          [input.wake.messageID, input.wake.sessionID])[0]
        if (!message || message.type !== "user" || typeof message.data !== "string") throw new Error("schedule-native-message")
        const observedDueAt = exactWakeDueAt(message.data, input.wake)
        if (observedDueAt === undefined) throw new Error("schedule-native-message")
        dueAt = observedDueAt
        const stored = query("SELECT value FROM kv WHERE key=?", [`${pluginPrefix}${nativeScheduleClaimKey(ctx, input.wake.missionID)}`])[0]?.value
        if (typeof stored !== "string" || JSON.parse(stored).key !== key) throw new Error("schedule-native-claim")
        return true
      }
      const current = (): true => { guard(); installed(); return true }
      observeNative()
      yield* Effect.tryPromise({ try: async () => {
        await store.change(binding.document.id, binding.document.revision, current, doc => {
          if (doc.pending || doc.deletion || doc.synchronization || doc.blocked) throw new Error("schedule-core-observation-required")
          missionDocumentChanges.processWake(doc, { scheduleID: input.wake.scheduleID, run: input.wake.run,
            messageID: input.wake.messageID, dueAt })
        })
        await closeNativeScheduleCarrierClaim(ctx, input.wake.missionID, effect => invocation.check(run => run(effect)), current)
        options.observe?.({ kind: "cas", key, run: input.wake.run })
      }, catch: error => error })
      observeNative()
      return reply("applied")
    }).pipe(Effect.orDie)

    yield* ctx.rpc.register(Rpc.define(NativeScheduleTransportRpc), {
      wake: raw => invocation.capture(handler("wake", raw)), status: raw => invocation.capture(handler("status", raw)),
    }).pipe(Effect.orDie)
    yield* ctx.aisdk.hook("language", event => Effect.sync(() => hooks.language(event)))
    const owned = (sessionID: string) => readNativeScheduleCarrierBinding(ctx, sessionID).pipe(Effect.tap(binding =>
      binding ? Effect.sync(() => { installed() }) : Effect.void), Effect.orDie)
    yield* ctx.session.hook("prompt", event => Effect.gen(function* () {
      const binding = yield* owned(event.sessionID)
      if (!binding) return
      const wake = event.metadata?.schedule as { id?: unknown; run?: unknown; dueAt?: unknown; late?: unknown } | undefined
      if (!wake || wake.id !== binding.calendar.scheduleID || !Number.isSafeInteger(wake.run) || !Number.isSafeInteger(wake.dueAt)
        || typeof wake.late !== "boolean" || event.messageID !== `msg_${wake.id}_${wake.run}`
        || event.prompt.text !== NATIVE_SCHEDULE_CARRIER_SIGNAL) throw new Error("schedule-carrier-prompt")
    }))
    yield* ctx.session.hook("title", event => Effect.gen(function* () {
      if (yield* owned(event.sessionID)) { nativeScheduleCarrierHooks(id => id === event.sessionID).title(event); options.observe?.({ kind: "local-title" }) }
    }))
    yield* ctx.session.hook("compaction", event => Effect.gen(function* () {
      if (yield* owned(event.sessionID)) { nativeScheduleCarrierHooks(id => id === event.sessionID).compaction(event); options.observe?.({ kind: "local-compaction" }) }
    }))
    yield* ctx.session.hook("http.request", event => Effect.gen(function* () {
      if (yield* owned(event.sessionID)) nativeScheduleCarrierHooks(id => id === event.sessionID).httpRequest(event)
    }))
    yield* ctx.session.hook("context", event => Effect.scoped(invocation.capture(Effect.gen(function* () {
      const binding = yield* owned(event.sessionID)
      if (!binding) return
      nativeScheduleCarrierHooks(id => id === event.sessionID).context(event)
      const mapping = { missionID: binding.document.id, generation: binding.document.timeGeneration,
        scheduleID: binding.calendar.scheduleID, sessionID: binding.calendar.sessionID }
      const run = <A>(effect: Effect.Effect<A, unknown>) => invocation.check(run => run(effect))
      const reader = yield* acquireNativeMissionScheduleWakeReader(ctx, run)
      const nonWakes = yield* Effect.promise(() => reader.nonWakeMessages(mapping, event.messages))
      const wakes: NativeScheduleWake[] = nativeScheduleCarrierWakes(mapping, binding.calendar.highWater, event.messages, nativeScheduleCarrierNonWakeMessageIDs(nonWakes))
      // Only public context closures survive this hook. RPC reacquires its own
      // Core graph; never reuse the plugin setup or a completed HTTP Scope.
      yield* Effect.promise(async () => {
        // Auto compaction can absorb the current wake into checkpoint prose.
        // Point-read its deterministic native ID before any claim; never extract
        // metadata from the summary or let a missing message reserve a dispatch.
        if (!wakes.length) {
          const run = binding.calendar.highWater + 1
          const wake = { ...mapping, run, messageID: `msg_${mapping.scheduleID}_${run}` }
          const source = await transport.status({ registrationFile: options.registrationFile, directory: ctx.location.directory, wake })
          options.observe?.({ kind: "compacted-wake-point-read", result: source })
          if (source.state === "received" && source.reply.messagePresent === true) wakes.push(wake)
        }
        for (const wake of wakes) {
          options.observe?.({ kind: "transport-start", key: nativeScheduleWakeKey(wake) })
          const result = await transport.wake({ registrationFile: options.registrationFile, directory: ctx.location.directory, wake,
            claim: incarnation => claimNativeScheduleCarrierWake(ctx, wake, incarnation, run, installed) })
          options.observe?.({ kind: "transport", key: nativeScheduleWakeKey(wake), result })
          if (result.state !== "received" || result.reply.state !== "applied") break
        }
      })
    })).pipe(Effect.orDie)))
  })
}
