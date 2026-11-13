import { Plugin, Rpc } from "@opencode/plugin/effect"
import { Clock, Context, Deferred, Effect, Option, Scope } from "effect"
import type { SqlClient } from "effect/sql"
import { Session } from "@opencode/schema/session"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import type { MissionStorage } from "../../missions/journal"
import { acquireNativeMissionDocumentStore } from "./native-mission-document-storage"
import { acquireMissionNativeService } from "./native-service-adapter"
import { acquireNativePassageObservation } from "./native-passage-observation"
import { adoptNativeScheduledCoordinator } from "./native-scheduled-coordinator"
import { admitNativeScheduledPassage } from "./native-scheduled-passage-admission"
import { nativeScheduledPassageBusiness, type NativeScheduledPassageContext } from "./native-scheduled-passage-business"
import { observeNativeScheduledPassage } from "./native-scheduled-passage-settlement"
import { nativeInvocation } from "./native-invocation"
import { acquireNativeSourceFence } from "./native-source-fence"
import { registerScheduledChildInput } from "./native-scheduled-child-input"
import { nativeBackgroundSQL } from "./native-source-fence"

const method = { input: { type: "object" }, output: { type: "object" } } as const
export const coordinatorQualification = { id: "codenomad.coordinator-qualification", methods: { begin: method, finish: method, read: method,
  probe: method, watermark: method, sameTime: method, backgroundStart: method, backgroundState: method, backgroundRelease: method }, events: {} }

/** Isolated native Session/CAS/admission/settlement qualification. Calendar mappings
 * are fixture-owned; product calendar activation has its separate native driver. */
export default Plugin.define({ id: "codenomad.missions", effect: ctx => Effect.gen(function* () {
  yield* registerScheduledChildInput(ctx)
  let background: { sessionID: string; turn: number; gate: Deferred.Deferred<void>; childID?: string; failedResume: boolean } | undefined
  yield* ctx.session.hook("http.response", event => Effect.gen(function* () {
    const state = background
    if (!state || event.kind !== "primary") return
    if (event.sessionID === state.sessionID) {
      state.turn++
      if (state.turn === 1) {
        const body = yield* Effect.tryPromise(() => event.request.clone().json())
        if (!(body.tools ?? []).some((tool: { function?: { name?: string } }) => tool.function?.name === "subagent")) throw Error("Fixture native subagent unavailable")
        yield* Effect.tryPromise(() => event.response.text())
        const call = { index: 0, id: "background_fixture_call", type: "function", function: { name: "subagent", arguments: JSON.stringify({
          agent: "reuse_worker", description: "Inherited background grandchild", prompt: "Finish private work.", background: true,
        }) } }
        event.response = new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0,
          delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
      } else if (state.turn >= 3 && state.failedResume) {
        state.failedResume = false
        yield* Effect.tryPromise(() => event.response.text())
        event.response = Response.json({ error: { type: "invalid_request_error", message: "Private resumed failure" } }, { status: 400 })
      }
      return
    }
    const session = yield* ctx.session.get({ sessionID: event.sessionID })
    if (session.parentID === state.sessionID) { state.childID = session.id; yield* Deferred.await(state.gate) }
  }).pipe(Effect.orDie))
  const invocation = nativeInvocation(30_000)
  const invoke = (kind: string) => (raw: unknown) => Effect.scoped(invocation.capture(Effect.gen(function* () {
    const scope = yield* Scope.Scope
    return yield* Effect.tryPromise(() => invocation.check(async run => {
    const input = raw as { sessionID: string; requestID: string; loseACK?: boolean; failedResume?: boolean }
    const current = () => true as const, signal = AbortSignal.timeout(30_000)
    const query = async (sql: string, parameters: readonly unknown[]) => {
      const found = await run(Effect.serviceOption(Context.Service<never, unknown>("@opencode/storage/Database")))
      if (Option.isNone(found)) throw Error("Fixture database unavailable")
      const db = (found.value as { db: { $client: SqlClient.SqlClient } }).db.$client
      return run(db.unsafe(sql, parameters).withoutTransform)
    }
    if (kind === "backgroundStart") { background = { sessionID: input.sessionID, turn: 0, gate: await run(Deferred.make<void>()), failedResume: false }; return { ready: true } }
    if (kind === "backgroundRelease") { if (!background) throw Error("Fixture background unavailable"); background.failedResume = !!input.failedResume; await run(Deferred.succeed(background.gate, undefined)); return { released: true } }
    if (kind === "backgroundState") {
      const rows = await query(nativeBackgroundSQL, [])
      const last = (await query("SELECT type,json_extract(data,'$.outcome') AS outcome FROM session_message WHERE session_id=? ORDER BY seq DESC LIMIT 1", [input.sessionID]))[0]
      return { last, childID: background?.childID, pending: rows.some(row => (row as { parentSessionID?: string }).parentSessionID === input.sessionID) }
    }
    const watermark = async () => {
      const rows = await query("SELECT s.time_updated,e.seq FROM session_v2 s JOIN event_sequence e ON e.aggregate_id=s.id WHERE s.id=?", [input.sessionID])
      const row = rows[0] as { time_updated: number; seq: number }
      if (!row || !Number.isSafeInteger(row.seq) || !Number.isSafeInteger(row.time_updated)) throw Error("Fixture aggregate sequence unavailable")
      return { sequence: row.seq, updated: row.time_updated }
    }
    if (kind === "watermark") return watermark()
    if (kind === "sameTime") {
      const real = await run(Clock.Clock), at = 1_700_000_000_000
      const fixed: Clock.Clock = { currentTimeMillisUnsafe: () => at, currentTimeMillis: Effect.succeed(at),
        currentTimeNanosUnsafe: () => BigInt(at) * 1_000_000n, currentTimeNanos: Effect.succeed(BigInt(at) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(), monotonicTimeNanos: real.monotonicTimeNanos,
        sleep: duration => real.sleep(duration) }
      const session = await run(ctx.session.get({ sessionID: Session.ID.make(input.sessionID) }))
      await run(ctx.session.update({ sessionID: session.id, title: "Fixed clock update" }).pipe(Effect.provideService(Clock.Clock, fixed)))
      const first = await watermark()
      await run(ctx.session.update({ sessionID: session.id, title: session.title ?? "Restored" }).pipe(Effect.provideService(Clock.Clock, fixed)))
      return { first, second: await watermark() }
    }
    const store = await run(acquireNativeMissionDocumentStore(ctx, run))
    const native = await run(acquireMissionNativeService(current, run).pipe(Effect.provideService(Scope.Scope, scope)))
    const observation = await run(acquireNativePassageObservation(undefined, run))
    const sourceFence = await run(acquireNativeSourceFence(current))
    const storage: MissionStorage = { get: key => run(ctx.storage.get(key)), scan: query => run(ctx.storage.scan(query)),
      set: async (key, value, guard) => { guard?.(); await run(ctx.storage.set(key, value)) } }
    if (kind === "read") return { document: await store.read("coordinator_reuse") }
    let document = await store.read("coordinator_reuse")
    if (!document) {
      const selected = { agent: "reuse_coordinator", model: { providerID: "fixture", id: "fixture", variant: "default" } }
      document = await store.create("coordinator_reuse", { title: "Reuse qualification", objective: "Complete this bounded passage.",
        template: "custom", taskMode: "native", roots: [{ mode: "directory-only", directory: ctx.location.directory }],
        profiles: { coordinator: selected, roles: { specialist: selected } }, profileID: "private", executionHost: "local",
        watchedConversationIDs: [], coordinatorSessionID: input.sessionID, launch: { when: [{ kind: "cron", expression: "0 * * * *", zone: "UTC" }] },
      }, Date.now(), current)
      document = await store.change(document.id, document.revision, current, doc => {
        changes.play(doc, "play", Date.now(), [])
        changes.synchronized(doc, "play", (["principal", "reconciliation"] as const).map(role => ({ role, slot: 0, timeGeneration: 1,
          scheduleID: `sch_${role}`, sessionID: `ses_${role}`, highWater: 0, pendingWake: null, wakePreparing: null })))
      })
    }
    if ("deletedAt" in document) throw Error("Fixture document deleted")
    if (kind === "begin" && !document.pending) document = await store.change(document.id, document.revision, current,
      doc => changes.reserve(doc, { kind: "manual", requestID: input.requestID }, Date.now(), []))
    return store.withExclusion(async locked => {
      if (!document || "deletedAt" in document) throw Error("Fixture document unavailable")
      const target = document
      const context: NativeScheduledPassageContext = { document, locked, storage, native, observation, current, signal,
        authority: () => locked.assertActive(), now: Date.now, environment: async () => ({}),
        profile: { profileID: "private", executionHost: "local", configYamlPath: "unused-private-profile" },
        adoptCoordinator: (metadata, guard) => adoptNativeScheduledCoordinator(ctx, run, native, target, metadata, guard, async () => {}, signal, current,
          session => { const fence = sourceFence(); fence.selectedSession(session); return fence.current }),
        settlementFence: sourceFence }
      if (kind === "begin") {
        const admission = await admitNativeScheduledPassage(context)
        if (input.loseACK) throw Error("Lost original admission ACK")
        const fresh = await locked.read(document.id)
        if (!fresh || "deletedAt" in fresh) throw Error("Fixture admission document unavailable")
        if (admission.kind === "admitted") document = await locked.change(document.id, fresh.revision, current,
          doc => changes.admitted(doc, admission.passageID, admission.at))
        return { admission, document: await locked.read(document.id) }
      }
      const business = nativeScheduledPassageBusiness(context)
      if (kind === "probe") { const result = await observeNativeScheduledPassage(context); return { settled: !!result, ...(result ? { outcome: result.outcome } : {}) } }
      await business.control.report(document.pending!.coordinatorSessionID, { final: true, outcome: "completed", summary: `Native passage ${document.launchedCount} delivered`, evidence: [], next: [] })
      const result = await observeNativeScheduledPassage(context)
      if (!result) throw Error("Native family has not settled")
      const snapshot = await business.control.snapshot()
      document = await locked.change(document.id, document.revision, current,
        doc => changes.settle(doc, doc.pending!.id, result.outcome, Date.now(), false, result.proof))
      return { document, snapshot }
    })
  }))
  }))).pipe(Effect.map(value => JSON.parse(JSON.stringify(value))), Effect.orDie)
  yield* ctx.rpc.register(Rpc.define(coordinatorQualification), { begin: invoke("begin"), finish: invoke("finish"), read: invoke("read"),
    probe: invoke("probe"), watermark: invoke("watermark"), sameTime: invoke("sameTime"), backgroundStart: invoke("backgroundStart"),
    backgroundState: invoke("backgroundState"), backgroundRelease: invoke("backgroundRelease") }).pipe(Effect.orDie)
}) })
