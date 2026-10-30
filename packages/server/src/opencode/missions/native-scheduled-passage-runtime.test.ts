import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { ProviderEditor, ProviderRecord } from "@opencode/plugin/effect/provider"
import { Context, Effect, Exit, Schema, Scope } from "effect"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { Schedule } from "@opencode/schema/schedule"
import type { MissionConfiguration } from "../../missions/launch-policy"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import type { MissionDocument } from "../../missions/mission-document"
import { acquireNativeMissionDocumentStore } from "./native-mission-document-storage"
import { acquireNativeScheduledPassageRuntime, type NativeScheduledPassageRuntime } from "./native-scheduled-passage-runtime"
import type { NativeCreateInput, NativeDocumentPassageCommand } from "./native-service-adapter"
import { registerNativeScheduleProvider } from "./native-schedule-provider-registration"
import { NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import { NATIVE_SCHEDULE_CARRIER_MARKER, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"

const current = () => true as const, at = Date.parse("2026-10-01T00:00:00Z")

test("real SQLite factory fences broken initial/business capabilities but observes admitted originals without provider/flag", async t => {
  const parent = path.join(os.tmpdir(), "opencode")
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(path.join(parent, "scheduled-phase-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const artifact = (name: string) => {
    const file = path.join(root, name), bytes = Buffer.from(name)
    writeFileSync(file, bytes)
    return { file, sha256: createHash("sha256").update(bytes).digest("hex") }
  }
  const installation = { registrationFile: path.join(root, "registration.json"), provider: artifact("provider.mjs"), runtime: artifact("runtime.mjs") }
  const providerScope = await Effect.runPromise(Scope.make())
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL);
    CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,time_suspended INTEGER);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,seq INTEGER,type TEXT,data TEXT);
    CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,data TEXT);
    CREATE TABLE session_inbox(id TEXT PRIMARY KEY,session_id TEXT);`)
  const namespace = `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`
  const nativeKey = (key: string) => namespace + key
  let transaction = false, sends = 0, environments = 0, enabled = true, disableAtEnvironment = false
  const directory = path.resolve("scheduled-passage-runtime-isolated-unit")
  const location = Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: "project", directory, canonical: directory } })
  const sessions = new Map<string, Session.Info>(), messages = new Map<string, typeof SessionMessage.Info.Type>(), active = new Set<string>()
  const descriptors = (["principal", "reconciliation"] as const).map(role => ({ role, slot: 0, timeGeneration: 1,
    scheduleID: `sch_${role}`, sessionID: `ses_${role}`, name: `Calendar ${role}`, creation: "adopted" as const,
    when: { type: "every" as const, every: "15 minutes", tz: "UTC" }, endsAt: null, ambiguous: [] }))
  const calendars = descriptors.map(item => ({ role: item.role, slot: 0, timeGeneration: 1,
    scheduleID: item.scheduleID, sessionID: item.sessionID, highWater: 0, pendingWake: null, wakePreparing: null }))
  const infos = new Map(descriptors.map(item => [item.scheduleID, Schema.decodeUnknownSync(Schedule.Info)({ id: item.scheduleID,
    sessionID: item.sessionID, name: item.name, when: item.when, tz: "UTC", status: "active", runCount: 0,
    nextDueAt: at + 900_000, action: { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL }, time: { created: at, updated: at } })]))
  for (const item of descriptors) sessions.set(item.sessionID, Schema.decodeUnknownSync(Session.Info)({ id: item.sessionID, projectID: "project",
    location: { directory }, model: NATIVE_SCHEDULE_CARRIER_MODEL, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: at, updated: at }, metadata: { [NATIVE_SCHEDULE_CARRIER_MARKER]: { missionID: "review", timeGeneration: 1, role: item.role, slot: 0 } } }))
  const stored = {
    get: (key: string) => Effect.sync(() => { const row = db.prepare("SELECT value FROM kv WHERE key=?").get(nativeKey(key)) as { value: string } | undefined
      return row ? JSON.parse(row.value) : undefined }),
    set: (key: string, value: unknown) => Effect.sync(() => {
      assert.equal(transaction, false)
      db.prepare("INSERT INTO kv VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(nativeKey(key), JSON.stringify(value), at, at)
    }),
    scan: ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => Effect.sync(() => {
      const rows = db.prepare("SELECT key,value FROM kv WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?")
        .all(nativeKey(prefix), nativeKey(prefix) + "\uffff", after === undefined ? "" : nativeKey(after), limit + 1) as Array<{ key: string; value: string }>
      const entries = rows.slice(0, limit).map(row => ({ key: row.key.slice(namespace.length), value: JSON.parse(row.value) }))
      return { entries, ...(rows.length > limit ? { next: entries.at(-1)!.key } : {}) }
    }),
  }
  const native = {
    active: Effect.sync(() => new Set(active)),
    get: (id: string) => Effect.sync(() => { assert.equal(transaction, false); return sessions.get(id) }),
    create: (input: NativeCreateInput) => Effect.sync(() => {
      assert.equal(transaction, false)
      const session = Schema.decodeUnknownSync(Session.Info)({ ...input, projectID: "project", cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: at, updated: at } })
      sessions.set(input.id, session)
      db.prepare("INSERT INTO session_v2(id,project_id,directory) VALUES(?,?,?)").run(input.id, "project", directory)
      return session
    }),
    inbox: () => Effect.succeed([]),
    message: ({ messageID }: { messageID: string }) => Effect.sync(() => messages.get(messageID)),
    environment: ({ variables }: { variables: Record<string, string> }) => {
      if (disableAtEnvironment) { enabled = false; disableAtEnvironment = false }
      return Effect.sync(() => { assert.equal(transaction, false); environments++; return variables })
    },
    prompt: () => Effect.die("Unexpected ordinary prompt"),
    synthetic: ({ sessionID, id, text, description, metadata }: NativeDocumentPassageCommand["input"]) => Effect.sync(() => {
      const written = db.prepare("SELECT value FROM kv WHERE json_extract(value,'$.pending.coordinatorSessionID')=?").get(sessionID) as { value: string }
      assert.equal(JSON.parse(written.value).pending.admissionAttempted, true)
      assert.equal(transaction, false); sends++; active.add(sessionID)
      const message = Schema.decodeUnknownSync(SessionMessage.Info)({ type: "synthetic", id, text, description, metadata, time: { created: at } })
      messages.set(id, message)
      db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)").run(id, sessionID, 1, "synthetic", JSON.stringify(Schema.encodeSync(SessionMessage.Info)(message)))
      return Schema.decodeUnknownSync(SessionInbox.Info)({ id, sessionID, type: "synthetic", payload: { text, description, metadata }, delivery: "queue", time: { created: at } })
    }),
  }
  const tag = (key: string) => Context.Service<never, unknown>(key)
  const client = Object.assign(() => {}, { unsafe: (sql: string, params: readonly unknown[]) => ({
    withoutTransform: Effect.sync(() => {
      if (transaction) assert.match(sql, /^(SELECT value FROM kv|INSERT INTO kv|UPDATE kv)/)
      return db.prepare(sql).all(...params as [])
    }),
  }) })
  const database = { db: { $client: client, transaction: (callback: () => Effect.Effect<unknown, unknown>) => Effect.gen(function* () {
    const graph = yield* Effect.context<never>()
    return yield* Effect.tryPromise({ try: async () => {
      db.exec("BEGIN IMMEDIATE"); transaction = true
      try { const result = await Effect.runPromiseWith(graph)(callback()); db.exec("COMMIT"); return result }
      catch (error) { db.exec("ROLLBACK"); throw error }
      finally { transaction = false }
    }, catch: error => error })
  }) } }
  let graph = Context.make(tag("@opencode/storage/Database"), database)
  graph = Context.add(graph, tag("@opencode/Location"), location)
  graph = Context.add(graph, tag("@opencode/Session"), native)
  for (const name of ["Form", "Permission", "Shell"]) graph = Context.add(graph, tag(`@opencode/${name}`), { list: () => Effect.succeed([]) })
  graph = Context.add(graph, tag("@opencode/Schedule"), { get: (id: string) => Effect.sync(() => infos.get(id)), enabled: () => Effect.sync(() => enabled) })
  const transforms: Array<(editor: ProviderEditor) => void> = []
  let records = new Map<string, ProviderRecord>()
  const ctx = { storage: stored, location, provider: {
    transform: (callback: (editor: ProviderEditor) => void) => Effect.sync(() => { transforms.push(callback); return { dispose: Effect.void } }),
    get: ({ providerID }: { providerID: string }) => Effect.sync(() => {
      records = new Map()
      const editor = { get: (id: string) => records.get(id), add: ({ info, models }: Parameters<ProviderEditor["add"]>[0]) =>
        records.set(info.id, { provider: info, models: new Map(models.map(model => [model.id, model])) }) } as unknown as ProviderEditor
      for (const transform of transforms) transform(editor)
      return { data: records.get(providerID)?.provider }
    }),
  }, model: { list: () => Effect.sync(() => ({ data: [...records.values()].flatMap(record => [...record.models.values()]) })) } } as unknown as Plugin.Context
  const entry = { current, signal: new AbortController().signal }
  let retired: NativeScheduledPassageRuntime | undefined, owner: NativeMissionDocumentStore | undefined
  const invoke = <T>(use: (runtime: NativeScheduledPassageRuntime) => Promise<T>, source = ctx, nativeGraph = graph) => Effect.runPromiseWith(nativeGraph)(Effect.scoped(Effect.gen(function* () {
    const currentGraph = yield* Effect.context<never>()
    const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromiseWith(currentGraph)(effect)
    const runtime = yield* acquireNativeScheduledPassageRuntime(source, run, { now: () => at + 2000, environment: async () => ({ UNIT: "fresh" }) })
    return yield* Effect.promise(() => use(runtime))
  })))
  try {
    await Effect.runPromise(registerNativeScheduleProvider(ctx, installation).pipe(Effect.provideService(Scope.Scope, providerScope)))
    const configuration: MissionConfiguration = { title: "Native factory", objective: "Do useful work", template: "custom", taskMode: "native",
      profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [],
      profiles: { coordinator: { agent: "worker", model: { providerID: "unit", id: "model" } },
        roles: { specialist: { agent: "worker", model: { providerID: "unit", id: "model" } } } },
      launch: { timing: { kind: "every", intervalMs: 900_000 }, condition: null, ends: { maxLaunches: null, at: null, afterMs: null } } }
    owner = await Effect.runPromiseWith(graph)(acquireNativeMissionDocumentStore(ctx))
    let doc = await owner.create("review", configuration, at, current)
    doc = await owner.change(doc.id, doc.revision, current, next => {
      changes.play(next, "first_play", at, [])
      const digest = "a".repeat(64)
      next.calendarOwner = { version: 1, installation,
        profileSource: { profileID: "profile", executionHost: "local", configYamlPath: "/isolated/profile.yaml" },
        placement: { rootsDigest: digest, roots: [{ directory, physical: directory, dev: "1", ino: "1", birth: "1" }], routing: [], gitEnvironmentDigest: digest },
        operation: { action: "play", requestID: "first_play", expectedRevision: 0, fingerprint: digest, pending: false, startedAt: at },
        receipts: [], checks: [], slots: descriptors, retired: [], auxiliaryReady: true, error: null }
      changes.synchronized(next, "first_play", calendars)
    })
    await t.test("runtime preflight verifies native ACK/message before readiness and publishes no KV or HWM", async () => {
      const principal = calendars[0], messageID = `msg_${principal.scheduleID}_1`
      const wake = { missionID: doc.id, generation: doc.timeGeneration, scheduleID: principal.scheduleID,
        sessionID: principal.sessionID, run: 1, messageID }
      const snapshot = () => db.prepare("SELECT key,value FROM kv ORDER BY key").all()
      const before = snapshot()
      assert.deepEqual(await invoke(runtime => runtime.preflight({ ...entry, missionID: doc.id, wake })),
        { messagePresent: false, ready: false, cutoff: at + 2000 })
      assert.deepEqual(snapshot(), before)
      const info = infos.get(principal.scheduleID)!
      infos.set(info.id, { ...info, runCount: 1 })
      messages.set(messageID, Schema.decodeUnknownSync(SessionMessage.Info)({ type: "user", id: messageID,
        text: NATIVE_SCHEDULE_CARRIER_SIGNAL, time: { created: at },
        metadata: { schedule: { id: principal.scheduleID, run: 1, dueAt: at, late: false } } }))
      assert.deepEqual(await invoke(runtime => runtime.preflight({ ...entry, missionID: doc.id, wake })),
        { messagePresent: true, ready: true, cutoff: at + 2000 })
      assert.deepEqual(snapshot(), before)
      assert.equal((await owner!.read(doc.id) as MissionDocument).calendars[0].highWater, 0)
      assert.equal(sends, 0); assert.equal(environments, 0)
    })
    const originalRevision = doc.revision
    enabled = false
    assert.equal(await invoke(runtime => runtime.runNow({ ...entry, missionID: "review", requestID: "manual_one", expectedRevision: originalRevision })), "unknown")
    doc = await owner.read("review") as MissionDocument
    const reservedID = doc.pending!.id
    assert.equal(doc.launchedCount, 0); assert.equal(sends, 0); assert.equal(environments, 0)
    enabled = true
    unlinkSync(installation.provider.file)
    assert.equal(await invoke(runtime => runtime.reconcile({ ...entry, missionID: "review" })), "unknown")
    assert.equal(sends, 0); assert.equal(environments, 0)
    doc = await owner.read("review") as MissionDocument
    doc = await owner.change(doc.id, doc.revision, current, next => { next.state = "paused"; next.pending!.manualAllowed = false })
    assert.deepEqual(await invoke(runtime => runtime.controlPassage({ ...entry, missionID: "review", requestID: "pause_without_provider", action: "pause" })), { pending: false })
    doc = await owner.change(doc.id, doc.revision, current, next => { next.state = "running" })
    writeFileSync(installation.provider.file, "provider.mjs")
    doc = await owner.read("review") as MissionDocument
    doc = await owner.change(doc.id, doc.revision, current, next => { next.calendarOwner!.auxiliaryReady = false })
    assert.equal(await invoke(runtime => runtime.reconcile({ ...entry, missionID: "review" })), "unknown")
    doc = await owner.read("review") as MissionDocument
    doc = await owner.change(doc.id, doc.revision, current, next => { next.calendarOwner!.auxiliaryReady = true })
    assert.equal(await invoke(async runtime => {
      retired = runtime
      return runtime.runNow({ ...entry, missionID: "review", requestID: "manual_one", expectedRevision: originalRevision })
    }), "pending")
    doc = await owner.read("review") as MissionDocument
    const pending = doc.pending!
    assert.equal(pending.id, reservedID)
    assert.equal(doc.launchedCount, 1); assert.equal(sends, 1); assert.equal(environments, 1)
    await assert.rejects(retired!.prepareBusiness(pending.coordinatorSessionID, entry), /retired/)
    disableAtEnvironment = true
    await assert.rejects(invoke(runtime => runtime.prepareBusiness(pending.coordinatorSessionID, entry)))
    assert.equal(environments, 1)
    enabled = true
    const auxiliary = infos.get("sch_reconciliation")!
    infos.set(auxiliary.id, { ...auxiliary, status: "paused" })
    await assert.rejects(invoke(runtime => runtime.prepareBusiness(pending.coordinatorSessionID, entry)))
    assert.equal(environments, 1)
    infos.set(auxiliary.id, { ...auxiliary, nextDueAt: undefined })
    await assert.rejects(invoke(runtime => runtime.prepareBusiness(pending.coordinatorSessionID, entry)))
    assert.equal(environments, 1)
    infos.set(auxiliary.id, auxiliary)
    assert.equal(await invoke(runtime => runtime.prepareBusiness(pending.coordinatorSessionID, entry)), true)
    assert.equal(environments, 2)
    writeFileSync(installation.provider.file, "damaged bytes")
    await assert.rejects(invoke(runtime => runtime.prepareBusiness(pending.coordinatorSessionID, entry)))
    await assert.rejects(invoke(runtime => runtime.executeBusiness(pending.coordinatorSessionID, entry, control => control.declare(pending.coordinatorSessionID,
      { taskKey: "refused_task", title: "Refused", brief: "Do bounded work", role: "specialist", blockedBy: [] }))))
    assert.equal((await owner.read("review") as MissionDocument).everCreatedTask, false)
    assert.equal(environments, 2); assert.equal(sends, 1)
    await invoke(async runtime => {
      assert.equal((await runtime.businessSelection(pending.coordinatorSessionID, entry))?.readSessionID, pending.coordinatorSessionID)
      const result = await runtime.executeBusiness(pending.coordinatorSessionID, entry, control => control.report(pending.coordinatorSessionID,
        { final: true, outcome: "completed", summary: "Bounded work delivered", evidence: [], next: [] }))
      assert.equal(result?.value.mission.status, "completed")
    })
    active.clear()
    enabled = false
    db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)").run("msg_native_idle", pending.coordinatorSessionID, 2, "idle", JSON.stringify({ outcome: "succeeded" }))
    assert.equal(await invoke(runtime => runtime.reconcile({ ...entry, missionID: "review" })), "settled")
    doc = await owner.read("review") as MissionDocument
    assert.equal(doc.pending, null); assert.equal(doc.history[0].outcome, "completed"); assert.equal(sends, 1)
    await t.test("never-played scheduled object converts to immediate with one original admission, frozen profiles and no Schedule/provider", async () => {
      const original = await owner!.create("conversion", configuration, at, current)
      let converted = await owner!.change(original.id, original.revision, current, next => changes.configure(next,
        { ...next.configuration, launch: { ...next.configuration.launch, timing: { kind: "immediate" } } }, at + 1000))
      assert.equal(converted.id, original.id); assert.equal(converted.firstPlayedAt, null)
      assert.deepEqual(converted.configuration.profiles, configuration.profiles)
      const armless = { ...doc.calendarOwner!, receipts: [], checks: [], slots: [], retired: [], auxiliaryReady: false,
        operation: { ...doc.calendarOwner!.operation, requestID: "play_conversion", expectedRevision: converted.revision } }
      converted = await owner!.change(converted.id, converted.revision, current, next => {
        next.calendarOwner = armless
        changes.play(next, "play_conversion", at + 1000, [])
        changes.reserve(next, { kind: "immediate", requestID: "play_conversion" }, at + 1000, [])
      })
      const originalPending = structuredClone(converted.pending!)
      const bare = { storage: stored, location } as unknown as Plugin.Context
      const noSchedule = Context.omit(tag("@opencode/Schedule"))(graph)
      const immediate = <T>(use: (runtime: NativeScheduledPassageRuntime) => Promise<T>) => invoke(use, bare, noSchedule)
      assert.equal(await immediate(runtime => runtime.reconcile({ ...entry, missionID: converted.id })), "pending")
      converted = await owner!.read(converted.id) as MissionDocument
      assert.equal(converted.launchedCount, 1); assert.equal(converted.state, "finished")
      assert.equal(converted.pending!.id, originalPending.id); assert.equal(converted.pending!.messageID, originalPending.messageID)
      const coordinator = sessions.get(originalPending.coordinatorSessionID)!
      assert.equal(coordinator.agent, configuration.profiles!.coordinator!.agent)
      assert.deepEqual(coordinator.model, configuration.profiles!.coordinator!.model)
      assert.equal(await immediate(runtime => runtime.prepareBusiness(coordinator.id, entry)), true)
      assert.equal(await immediate(runtime => runtime.reconcile({ ...entry, missionID: converted.id })), "pending")
      assert.equal(sends, 2)
      await immediate(runtime => runtime.executeBusiness(coordinator.id, entry, control => control.report(coordinator.id,
        { final: true, outcome: "completed", summary: "Immediate work delivered", evidence: [], next: [] })))
      active.delete(coordinator.id)
      db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)").run("msg_immediate_idle", coordinator.id, 2, "idle", JSON.stringify({ outcome: "succeeded" }))
      assert.equal(await immediate(runtime => runtime.reconcile({ ...entry, missionID: converted.id })), "settled")
      converted = await owner!.read(converted.id) as MissionDocument
      assert.deepEqual(converted.calendars, []); assert.deepEqual(converted.calendarOwner!.slots, [])
      assert.equal(converted.calendarOwner!.auxiliaryReady, false)
      assert.equal(converted.launchedCount, 1); assert.equal(converted.pending, null)
      assert.equal(converted.history[0].origin.kind, "immediate"); assert.equal(converted.history[0].messageID, originalPending.messageID)
      await assert.rejects(immediate(runtime => runtime.runNow({ ...entry, missionID: converted.id,
        requestID: "second_immediate", expectedRevision: converted.revision })))
      assert.equal(sends, 2); assert.equal(sessions.size, descriptors.length + 2)
    })
  } finally { await Effect.runPromise(Scope.close(providerScope, Exit.void)); db.close() }
})
