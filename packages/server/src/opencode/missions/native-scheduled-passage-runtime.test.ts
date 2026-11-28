import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Schema } from "effect"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { Automation } from "@opencode/schema/automation"
import { missionAutomationID, MISSION_WAKE_CODE } from "./native-mission-automation"
import type { MissionConfiguration } from "../../missions/launch-policy"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { projectMissionDocument, type MissionDocument } from "../../missions/mission-document"
import { acquireNativeMissionDocumentStore } from "./native-mission-document-storage"
import { acquireNativeScheduledPassageRuntime, type NativeScheduledPassageRuntime } from "./native-scheduled-passage-runtime"
import { acquireNativeScheduledPassageCapability } from "./native-scheduled-passage-capability"
import type { NativeCreateInput, NativeDocumentPassageCommand } from "./native-service-adapter"
import { NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import { NATIVE_SCHEDULE_CARRIER_MARKER, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"
import { scheduledPassageOwner } from "./native-scheduled-passage-owner"
import { missionScheduleAvailableActions } from "../../missions/mission-schedule-display"

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
  const installation = { registrationFile: path.join(root, "registration.json"), runtime: artifact("runtime.mjs") }
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL);
    CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,time_suspended INTEGER,metadata TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,seq INTEGER,type TEXT,data TEXT);
    CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,data TEXT);
    CREATE TABLE session_inbox(id TEXT PRIMARY KEY,session_id TEXT);`)
  const namespace = `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`
  const nativeKey = (key: string) => namespace + key
  let transaction = false, sends = 0, environments = 0, enabled = true, disableAtEnvironment = false
  let failRelease = false, loseReleaseACK = false, releaseWrites = 0
  const directory = path.resolve("scheduled-passage-runtime-isolated-unit")
  const location = Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: "project", directory, canonical: directory } })
  const sessions = new Map<string, Session.Info>(), messages = new Map<string, typeof SessionMessage.Info.Type>(), active = new Set<string>()
  const descriptors = (["principal", "reconciliation"] as const).map(role => ({ role, slot: 0, timeGeneration: 1,
    scheduleID: `sch_${role}`, sessionID: `ses_${role}`, name: `Calendar ${role}`, creation: "adopted" as const,
    when: { type: "every" as const, every: "15 minutes", tz: "UTC" }, endsAt: null, ambiguous: [] }))
  const calendars = descriptors.map(item => ({ role: item.role, slot: 0, timeGeneration: 1,
    scheduleID: item.scheduleID, sessionID: item.sessionID, highWater: 0, pendingWake: null, wakePreparing: null }))
  const infos = new Map(descriptors.map(item => [missionAutomationID(item.scheduleID), Schema.decodeUnknownSync(Automation.Info)({ id: missionAutomationID(item.scheduleID),
    sessionID: item.sessionID, name: item.name, projectID: "project", directory, trigger: item.when, tz: "UTC", status: "active", runCount: 0,
    nextDueAt: at + 900_000, action: { type: "code", code: MISSION_WAKE_CODE }, time: { created: at, updated: at } })]))
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
    get: (id: string) => Effect.suspend(() => {
      assert.equal(transaction, false)
      const session = sessions.get(id)
      return session ? Effect.succeed(session) : Effect.fail(Object.assign(new Error("Not found"), { _tag: "SessionNotFoundError", sessionID: id }))
    }),
    create: (input: NativeCreateInput) => Effect.sync(() => {
      assert.equal(transaction, false)
      const session = Schema.decodeUnknownSync(Session.Info)({ ...input, projectID: "project", cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: at, updated: at } })
      sessions.set(input.id, session)
      db.prepare("INSERT INTO session_v2(id,project_id,directory,metadata) VALUES(?,?,?,?)").run(input.id, "project", directory, JSON.stringify(input.metadata ?? null))
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
      if (transaction) assert.match(sql, /^(SELECT |WITH RECURSIVE |INSERT INTO kv|UPDATE kv)/)
      return db.prepare(sql).all(...params as []).map(row => ({ ...row }))
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
  graph = Context.add(graph, tag("@opencode/Automation"), { get: (id: string) => Effect.sync(() => infos.get(id)), enabled: () => Effect.sync(() => enabled) })
  const updateMetadata = (id: string, metadata: Record<string, unknown>) => {
    Object.assign(sessions.get(id)!, { metadata })
    db.prepare("UPDATE session_v2 SET metadata=? WHERE id=?").run(JSON.stringify(metadata), id)
  }
  const ctx = { storage: stored, location, session: { update: ({ sessionID, metadata }: { sessionID: string; metadata: Record<string, unknown> }) => Effect.sync(() => {
    assert.equal(transaction, false)
    if (failRelease) throw Error("Fixture update unavailable")
    updateMetadata(sessionID, metadata); releaseWrites++
    if (loseReleaseACK) { loseReleaseACK = false; throw Error("Lost release ACK") }
  }) } } as unknown as Plugin.Context
  const entry = { current, signal: new AbortController().signal }
  let retired: NativeScheduledPassageRuntime | undefined, owner: NativeMissionDocumentStore | undefined
  const invoke = <T>(use: (runtime: NativeScheduledPassageRuntime) => Promise<T>, source = ctx, nativeGraph = graph) => Effect.runPromiseWith(nativeGraph)(Effect.scoped(Effect.gen(function* () {
    const currentGraph = yield* Effect.context<never>()
    const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromiseWith(currentGraph)(effect)
    const runtime = yield* acquireNativeScheduledPassageRuntime(source, run, { now: () => at + 2000, environment: async () => ({ UNIT: "fresh" }) })
    return yield* Effect.promise(() => use(runtime))
  })))
  try {
    const configuration: MissionConfiguration = { title: "Native factory", objective: "Do useful work", template: "custom", taskMode: "native",
      profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory }], watchedConversationIDs: [],
      profiles: { coordinator: { agent: "worker", model: { providerID: "unit", id: "model" } },
        roles: { specialist: { agent: "worker", model: { providerID: "unit", id: "model" } } } },
      launch: { timing: { kind: "every", intervalMs: 900_000 }, condition: null, ends: { maxLaunches: null, at: null, afterMs: null } } }
    owner = await Effect.runPromiseWith(graph)(acquireNativeMissionDocumentStore(ctx))
    const debugConfiguration: MissionConfiguration = { ...configuration, template: "debug", profiles: {
      coordinator: configuration.profiles!.coordinator,
      roles: Object.fromEntries(["diagnostician", "implementer", "review-standards", "review-spec", "resolver", "validator"]
        .map(role => [role, configuration.profiles!.roles!.specialist])),
    } }
    let doc = await owner.create("review", debugConfiguration, at, current)
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
    await t.test("runtime preflight verifies durable Code Mode preparation before readiness and publishes no KV or HWM", async () => {
      const principal = calendars[0], messageID = `msg_${principal.scheduleID}_1`
      const wake = { missionID: doc.id, generation: doc.timeGeneration, scheduleID: principal.scheduleID,
        sessionID: principal.sessionID, run: 1, messageID }
      const snapshot = () => db.prepare("SELECT key,value FROM kv ORDER BY key").all()
      const before = snapshot()
      assert.deepEqual(await invoke(runtime => runtime.preflight({ ...entry, missionID: doc.id, wake })),
        { messagePresent: false, ready: false, cutoff: at + 2000 })
      assert.deepEqual(snapshot(), before)
      const info = infos.get(missionAutomationID(principal.scheduleID))!
      infos.set(info.id, { ...info, runCount: 1 })
      doc = await owner!.change(doc.id, doc.revision, current, next => changes.prepareWake(next,
        { scheduleID: principal.scheduleID, run: 1, messageID, dueAt: at }))
      const prepared = snapshot()
      assert.deepEqual(await invoke(runtime => runtime.preflight({ ...entry, missionID: doc.id, wake })),
        { messagePresent: true, ready: true, cutoff: at + 2000 })
      assert.deepEqual(snapshot(), prepared)
      assert.equal((await owner!.read(doc.id) as MissionDocument).calendars[0].highWater, 0)
      assert.equal(sends, 0); assert.equal(environments, 0)
      doc = await owner!.change(doc.id, doc.revision, current, next => { next.calendars[0].wakePreparing = null })
      infos.set(info.id, info)
    })
    const originalRevision = doc.revision
    enabled = false
    assert.equal(await invoke(runtime => runtime.runNow({ ...entry, missionID: "review", requestID: "manual_one", expectedRevision: originalRevision })), "unknown")
    doc = await owner.read("review") as MissionDocument
    const reservedID = doc.pending!.id
    assert.equal(doc.launchedCount, 0); assert.equal(sends, 0); assert.equal(environments, 0)
    enabled = true
    const savedAuxiliary = infos.get("aut_reconciliation")!
    infos.set(savedAuxiliary.id, { ...savedAuxiliary, action: { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL,
      to: { session: savedAuxiliary.sessionID! } } })
    assert.equal(await invoke(runtime => runtime.reconcile({ ...entry, missionID: "review" })), "unknown")
    assert.equal(sends, 0); assert.equal(environments, 0)
    doc = await owner.read("review") as MissionDocument
    doc = await owner.change(doc.id, doc.revision, current, next => { next.state = "paused"; next.pending!.manualAllowed = false })
    assert.deepEqual(await invoke(runtime => runtime.controlPassage({ ...entry, missionID: "review", requestID: "pause_without_provider", action: "pause" })), { pending: false })
    doc = await owner.change(doc.id, doc.revision, current, next => { next.state = "running" })
    infos.set(savedAuxiliary.id, savedAuxiliary)
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
    const auxiliary = infos.get("aut_reconciliation")!
    infos.set(auxiliary.id, { ...auxiliary, status: "paused" })
    await assert.rejects(invoke(runtime => runtime.prepareBusiness(pending.coordinatorSessionID, entry)))
    assert.equal(environments, 1)
    infos.set(auxiliary.id, { ...auxiliary, nextDueAt: undefined })
    await assert.rejects(invoke(runtime => runtime.prepareBusiness(pending.coordinatorSessionID, entry)))
    assert.equal(environments, 1)
    infos.set(auxiliary.id, auxiliary)
    assert.equal(await invoke(runtime => runtime.prepareBusiness(pending.coordinatorSessionID, entry)), true)
    assert.equal(environments, 2)
    infos.set(auxiliary.id, { ...auxiliary, action: { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL, to: { session: auxiliary.sessionID! } } })
    await assert.rejects(invoke(runtime => runtime.prepareBusiness(pending.coordinatorSessionID, entry)))
    await assert.rejects(invoke(runtime => runtime.executeBusiness(pending.coordinatorSessionID, entry, control => control.declare(pending.coordinatorSessionID,
      { taskKey: "refused_task", title: "Refused", brief: "Do bounded work", role: "diagnostician", blockedBy: [] }))))
    assert.equal((await owner.read("review") as MissionDocument).everCreatedTask, false)
    assert.equal(environments, 2); assert.equal(sends, 1)
    infos.set(auxiliary.id, auxiliary)
    // The user may switch the coordinator conversation's model after admission.
    const coordinator = sessions.get(pending.coordinatorSessionID)!
    sessions.set(coordinator.id, { ...coordinator, model: { providerID: "other", id: "chat", variant: "high" } } as unknown as Session.Info)
    await invoke(async runtime => {
      assert.equal((await runtime.businessSelection(pending.coordinatorSessionID, entry))?.readSessionID, pending.coordinatorSessionID)
      const result = await runtime.executeBusiness(pending.coordinatorSessionID, entry, control => control.report(pending.coordinatorSessionID,
        { final: true, outcome: "completed", summary: "The reviewed sync merged without conflicts.",
          artifact: { kind: "verified-completion" },
          evidence: ["Independent review and focused tests passed on the frozen merge candidate.", "Verified source ancestry after the merge."], next: [] }))
      assert.equal(result?.value.mission.status, "completed")
    })
    active.clear()
    enabled = false
    db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)").run("msg_native_idle", pending.coordinatorSessionID, 2, "idle", JSON.stringify({ outcome: "succeeded" }))
    assert.equal(await invoke(runtime => runtime.reconcile({ ...entry, missionID: "review" })), "settled")
    doc = await owner.read("review") as MissionDocument
    assert.equal(doc.pending, null); assert.equal(doc.history[0].outcome, "completed"); assert.equal(sends, 1)
    assert.equal(doc.successfulCount, 1); assert.equal(doc.blocked, null)
    await t.test("unconfirmed coordinator cleanup survives history eviction and an idle Check reconciles its exact native ACK", async () => {
      let releaseDoc = await owner!.create("cleanup_retention", { ...configuration, coordinatorSessionID: "ses_retiring" }, at, current)
      releaseDoc = await owner!.change(releaseDoc.id, releaseDoc.revision, current, next => {
        changes.play(next, "play_cleanup", at, [])
        changes.synchronized(next, "play_cleanup", calendars)
        changes.reserve(next, { kind: "manual", requestID: "first_cleanup" }, at + 1, [])
        next.pending!.coordinatorBaseline = [["ses_retiring", -1, null, null, 0]]
        changes.admitted(next, next.pending!.id, at + 2)
      })
      const first = releaseDoc.pending!, marker = { version: 1, missionID: first.missionID, kind: "coordinator", role: "coordinator",
        document: { missionID: releaseDoc.id, passageID: first.id, coordinatorReused: true } }
      await Effect.runPromise(native.create({ id: "ses_retiring", title: "Preserved conversation", location: { directory },
        metadata: { unrelated: "preserve", "codenomad.mission": marker }, agent: "worker", model: { providerID: "unit", id: "model" } }))
      releaseDoc = await owner!.change(releaseDoc.id, releaseDoc.revision, current,
        next => changes.settle(next, first.id, "completed", at + 3, false, { revision: 1, familyDigest: "a".repeat(64) }))
      for (let index = 1; index <= 35; index++) releaseDoc = await owner!.change(releaseDoc.id, releaseDoc.revision, current, next => {
        next.configuration.coordinatorSessionID = "ses_other_root"
        changes.reserve(next, { kind: "manual", requestID: `later_cleanup_${index}` }, at + index * 10, [])
        next.pending!.coordinatorBaseline = [["ses_other_root", -1, null, null, 0]]
        changes.admitted(next, next.pending!.id, at + index * 10 + 1)
        changes.settle(next, next.pending!.id, "completed", at + index * 10 + 2, false, { revision: 1, familyDigest: "b".repeat(64) })
        next.coordinatorReleases = next.coordinatorReleases.filter(item => item.coordinatorSessionID !== "ses_other_root")
      })
      assert.equal(releaseDoc.history.length, 30)
      assert.ok(!releaseDoc.history.some(item => item.id === first.id))
      assert.deepEqual(releaseDoc.coordinatorReleases, [{ id: first.id, missionID: first.missionID, coordinatorSessionID: first.coordinatorSessionID }])
      assert.equal(scheduledPassageOwner(releaseDoc, releaseDoc, "ses_retiring", marker), undefined, "retained cleanup identity proves inactive ownership after history eviction")
      assert.ok(missionScheduleAvailableActions(releaseDoc).includes("check"), "retained cleanup offers Check with no pending passage")
      failRelease = true
      assert.equal(await invoke(runtime => runtime.reconcile({ ...entry, missionID: releaseDoc.id })), "idle")
      assert.equal((await owner!.read(releaseDoc.id) as MissionDocument).coordinatorReleases.length, 1)
      failRelease = false; loseReleaseACK = true
      assert.equal(await invoke(runtime => runtime.reconcile({ ...entry, missionID: releaseDoc.id })), "idle")
      releaseDoc = await owner!.read(releaseDoc.id) as MissionDocument
      assert.equal(releaseDoc.coordinatorReleases.length, 0)
      assert.equal(sessions.get("ses_retiring")!.metadata?.unrelated, "preserve")
      assert.equal(sessions.get("ses_retiring")!.metadata?.["codenomad.mission"], undefined)
      const writes = releaseWrites, replacement = { missionID: "newer_assignment" }
      updateMetadata("ses_retiring", { unrelated: "preserve", "codenomad.mission": replacement })
      releaseDoc = await owner!.change(releaseDoc.id, releaseDoc.revision, current,
        next => { next.coordinatorReleases.push({ id: first.id, missionID: first.missionID, coordinatorSessionID: first.coordinatorSessionID }) })
      assert.equal(await invoke(runtime => runtime.reconcile({ ...entry, missionID: releaseDoc.id })), "idle")
      assert.equal(releaseWrites, writes, "cleanup never overwrites a newer marker")
      assert.deepEqual(sessions.get("ses_retiring")!.metadata?.["codenomad.mission"], replacement)
      assert.equal((await owner!.read(releaseDoc.id) as MissionDocument).coordinatorReleases.length, 0)
      assert.equal(sends, 1, "idle Check never starts another passage")
    })
    await t.test("never-played scheduled object converts to immediate with one original admission, frozen profiles and no Schedule/provider", async () => {
      const beforeSessions = sessions.size
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
      const noSchedule = Context.omit(tag("@opencode/Automation"))(graph)
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
      assert.equal(sends, 2); assert.equal(sessions.size, beforeSessions + 1)
    })
    await t.test("passage capability refuses a prompt auxiliary without qualifying the passage", async () => {
      enabled = true
      let candidate = await owner!.create("prompt_capability_fence", configuration, at, current)
      candidate = await owner!.change(candidate.id, candidate.revision, current, next => {
        next.calendarOwner = { ...doc.calendarOwner!, installation }
        changes.play(next, "play_prompt", at, [])
        changes.synchronized(next, "play_prompt", calendars)
        changes.reserve(next, { kind: "manual", requestID: "manual_prompt" }, at + 1, [])
      })
      const auxiliary = infos.get("aut_reconciliation")!
      infos.set(auxiliary.id, { ...auxiliary, action: { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL, to: { session: auxiliary.sessionID! } } })
      const auxSession = sessions.get(auxiliary.sessionID!)!
      sessions.set(auxSession.id, { ...auxSession, metadata: { [NATIVE_SCHEDULE_CARRIER_MARKER]: {
        missionID: candidate.id, timeGeneration: 1, role: "reconciliation", slot: 0 } } } as Session.Info)
      await Effect.runPromiseWith(graph)(Effect.gen(function* () {
        const cap = yield* acquireNativeScheduledPassageCapability(ctx, current)
        assert.match(String(yield* Effect.flip(Effect.catchCause(cap.prepare(candidate), cause => Effect.fail(cause)))), /schedule-calendar-requires-code/)
        assert.throws(() => cap.assertCurrent(candidate), /unqualified/)
      }))
      assert.deepEqual(await owner!.read(candidate.id), candidate)
      infos.set(auxiliary.id, auxiliary)
      sessions.set(auxSession.id, auxSession)
    })
    await t.test("Code Mode scheduled passage admits and runs business without a provider", async () => {
      enabled = true
      const aux = infos.get("aut_reconciliation")!
      infos.set(aux.id, { ...aux, action: { type: "code", code: MISSION_WAKE_CODE } })
      const { model: _legacy, ...auxWithoutModel } = sessions.get("ses_reconciliation")!
      let codeDoc = await owner!.create("code_no_provider", configuration, at, current)
      codeDoc = await owner!.change(codeDoc.id, codeDoc.revision, current, next => {
        next.calendarOwner = { ...doc.calendarOwner!, installation: { registrationFile: installation.registrationFile, runtime: installation.runtime } }
        changes.play(next, "play_code", at, [])
        changes.synchronized(next, "play_code", calendars)
      })
      const auxMeta = { [NATIVE_SCHEDULE_CARRIER_MARKER]: { missionID: codeDoc.id, timeGeneration: 1, role: "reconciliation", slot: 0 } }
      sessions.set("ses_reconciliation", { ...auxWithoutModel, metadata: auxMeta } as Session.Info)
      const bare = { storage: stored, location } as unknown as Plugin.Context
      assert.equal(await invoke(runtime => runtime.runNow({ ...entry, missionID: codeDoc.id, requestID: "manual_code", expectedRevision: codeDoc.revision }), bare), "pending")
      codeDoc = await owner!.read(codeDoc.id) as MissionDocument
      assert.equal(codeDoc.launchedCount, 1)
      assert.equal(await invoke(runtime => runtime.prepareBusiness(codeDoc.pending!.coordinatorSessionID, entry), bare), true)
      const declared = await invoke(runtime => runtime.executeBusiness(codeDoc.pending!.coordinatorSessionID, entry, control => control.declare(
        codeDoc.pending!.coordinatorSessionID, { taskKey: "code_task", title: "Code work", brief: "Bounded work", role: "specialist", blockedBy: [] })), bare)
      assert.equal(declared?.value.contract.taskKey, "code_task")
      assert.equal((await owner!.read(codeDoc.id) as MissionDocument).everCreatedTask, true)
    })
    await t.test("missing reused coordinator settles as not-started, blocks the calendar visibly, and unlocks structural edit", async () => {
      const beforeSends = sends
      const missingDescriptors = (["principal", "reconciliation"] as const).map(role => ({ role, slot: 0, timeGeneration: 1,
        scheduleID: `sch_missing_${role}`, sessionID: `ses_missing_${role}`, name: `Missing ${role}`, creation: "adopted" as const,
        when: { type: "every" as const, every: "15 minutes", tz: "UTC" }, endsAt: null, ambiguous: [] }))
      const missingCalendars = missingDescriptors.map(item => ({ role: item.role, slot: 0, timeGeneration: 1,
        scheduleID: item.scheduleID, sessionID: item.sessionID, highWater: 0, pendingWake: null, wakePreparing: null }))
      for (const item of missingDescriptors) {
        infos.set(missionAutomationID(item.scheduleID), Schema.decodeUnknownSync(Automation.Info)({ id: missionAutomationID(item.scheduleID),
          sessionID: item.sessionID, name: item.name, projectID: "project", directory, trigger: item.when, tz: "UTC", status: "active", runCount: 0,
          nextDueAt: at + 900_000, action: { type: "code", code: MISSION_WAKE_CODE }, time: { created: at, updated: at } }))
        sessions.set(item.sessionID, Schema.decodeUnknownSync(Session.Info)({ id: item.sessionID, projectID: "project",
          location: { directory }, model: NATIVE_SCHEDULE_CARRIER_MODEL, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: at, updated: at }, metadata: { [NATIVE_SCHEDULE_CARRIER_MARKER]: { missionID: "missing_reused", timeGeneration: 1, role: item.role, slot: 0 } } }))
      }
      const beforeSessions = sessions.size
      let missingDoc = await owner!.create("missing_reused", { ...configuration, coordinatorSessionID: "ses_deleted_reused" }, at, current)
      missingDoc = await owner!.change(missingDoc.id, missingDoc.revision, current, next => {
        next.calendarOwner = { ...doc.calendarOwner!, installation, slots: missingDescriptors }
        changes.play(next, "play_missing_reused", at, [])
        changes.synchronized(next, "play_missing_reused", missingCalendars)
        changes.reserve(next, { kind: "manual", requestID: "manual_missing_reused" }, at + 1, [])
      })
      assert.equal(projectMissionDocument(missingDoc).edit.structural, false)
      assert.equal(await invoke(runtime => runtime.reconcile({ ...entry, missionID: missingDoc.id })), "settled")
      missingDoc = await owner!.read(missingDoc.id) as MissionDocument
      assert.equal(missingDoc.pending, null)
      assert.equal(missingDoc.blocked, "failed")
      assert.equal(missingDoc.launchedCount, 0)
      assert.equal(missingDoc.coordinatorReleases.length, 0)
      assert.equal(missingDoc.history.length, 1)
      assert.equal(missingDoc.history[0].outcome, "failed")
      assert.equal(missingDoc.history[0].reason, "not-started")
      assert.equal(projectMissionDocument(missingDoc).edit.structural, true)
      assert.equal(sends, beforeSends)
      assert.equal(sessions.size, beforeSessions)
    })
    await t.test("principal wake settling missing reused coordinator unlocks Edit and Resume while the Code Mode wake is still in flight", async () => {
      const beforeSends = sends
      const wakeDescriptors = (["principal", "reconciliation"] as const).map(role => ({ role, slot: 0, timeGeneration: 1,
        scheduleID: `sch_wake_missing_${role}`, sessionID: `ses_wake_missing_${role}`, name: `Wake Missing ${role}`, creation: "adopted" as const,
        when: { type: "every" as const, every: "15 minutes", tz: "UTC" }, endsAt: null, ambiguous: [] }))
      const wakeCalendars = wakeDescriptors.map(item => ({ role: item.role, slot: 0, timeGeneration: 1,
        scheduleID: item.scheduleID, sessionID: item.sessionID, highWater: 0, pendingWake: null, wakePreparing: null }))
      // While the Code Mode principal wake is running, runCount is still 0 and nextDueAt points at the firing slot (<= cutoff).
      const firingDueAt = at + 1_000
      for (const item of wakeDescriptors) {
        infos.set(missionAutomationID(item.scheduleID), Schema.decodeUnknownSync(Automation.Info)({ id: missionAutomationID(item.scheduleID),
          sessionID: item.sessionID, name: item.name, projectID: "project", directory, trigger: item.when, tz: "UTC", status: "active", runCount: 0,
          nextDueAt: item.role === "principal" ? firingDueAt : at + 900_000, action: { type: "code", code: MISSION_WAKE_CODE }, time: { created: at, updated: at } }))
        sessions.set(item.sessionID, Schema.decodeUnknownSync(Session.Info)({ id: item.sessionID, projectID: "project",
          location: { directory }, model: NATIVE_SCHEDULE_CARRIER_MODEL, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: at, updated: at }, metadata: { [NATIVE_SCHEDULE_CARRIER_MARKER]: { missionID: "wake_missing_reused", timeGeneration: 1, role: item.role, slot: 0 } } }))
      }
      const beforeSessions = sessions.size
      let wakeDoc = await owner!.create("wake_missing_reused", { ...configuration, coordinatorSessionID: "ses_deleted_wake_reused" }, at, current)
      const principal = wakeCalendars[0]
      wakeDoc = await owner!.change(wakeDoc.id, wakeDoc.revision, current, next => {
        next.calendarOwner = { ...doc.calendarOwner!, installation, slots: wakeDescriptors }
        changes.play(next, "play_wake_missing", at, [])
        changes.synchronized(next, "play_wake_missing", wakeCalendars)
        changes.prepareWake(next, { scheduleID: principal.scheduleID, run: 1, messageID: `msg_${principal.scheduleID}_1`, dueAt: firingDueAt })
      })
      assert.equal(await invoke(runtime => runtime.wake({
        ...entry,
        missionID: wakeDoc.id,
        wake: { missionID: wakeDoc.id, generation: 1, scheduleID: principal.scheduleID, sessionID: principal.sessionID,
          run: 1, messageID: `msg_${principal.scheduleID}_1`, dueAt: firingDueAt },
      })), "settled")
      wakeDoc = await owner!.read(wakeDoc.id) as MissionDocument
      assert.equal(wakeDoc.pending, null)
      assert.equal(wakeDoc.blocked, "failed")
      assert.equal(wakeDoc.launchedCount, 0)
      assert.equal(wakeDoc.calendars[0].highWater, 1)
      assert.equal(wakeDoc.calendars[0].pendingWake, null)
      assert.equal(wakeDoc.calendars[0].wakePreparing, null)
      assert.equal(wakeDoc.fanIn?.completed, true)
      assert.equal(projectMissionDocument(wakeDoc).edit.structural, true)
      const actions = missionScheduleAvailableActions(wakeDoc)
      assert.ok(actions.includes("configure"))
      assert.ok(actions.includes("resume"))
      assert.equal(sends, beforeSends)
      assert.equal(sessions.size, beforeSessions)
    })
  } finally { db.close() }
})
