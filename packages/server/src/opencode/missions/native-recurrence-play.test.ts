import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { Context, Effect, Exit, RcMap, Schema, Scope } from "effect"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { AuthManager } from "../../auth/manager"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { recurrenceHumanRequestID } from "../../missions/recurrence-authority-contract"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { recurrenceControlRequestDigest, signNativeRecurrenceControl } from "../../missions/recurrence-control-proof"
import { physical } from "../../missions/host-authority/private-files"
import { readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import { createAutomationBridgeRegistration, publishAutomationBridge, AUTOMATION_BRIDGE_PATH } from "../automation-plugin"
import { verifyHumanRecurrenceRequest } from "../../server/routes/mission-recurrence-proof"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { controlNativeRecurrence } from "./native-recurrence-control"
import { readNativeRecurrenceSnapshot } from "./native-recurrence-snapshot"
import { readRecurrenceScheduleChanged, type RecurrenceScheduleChanged } from "../../missions/recurrence-events"
import { missionProfileRoles } from "../../missions/playbook-profiles"
import { nativeRecurrenceDue } from "./native-recurrence-due"

const tag = (id: string) => Context.Service<never, unknown>(id)
const dbTag = tag("@opencode/storage/Database"), locationTag = tag("@opencode/Location"), sessionTag = tag("@opencode/Session")

test("real signed Play starts the reviewed due callback; succeeded archive permits next day and restart requires explicit Resume", async () => {
  const root = await mkdtemp(path.join(process.env.LOCALAPPDATA ?? "C:/Users/Admin/AppData/Local", "Temp", "opencode", "play-offline-"))
  const originalLocal = process.env.LOCALAPPDATA, originalNow = Date.now
  process.env.LOCALAPPDATA = root
  const db = new DatabaseSync(path.join(root, "native.sqlite")), scope = await Effect.runPromise(Scope.make())
  const bridge = Fastify({ logger: false })
  let removeBridge: (() => Promise<void>) | undefined
  try {
    execFileSync("git", ["init", "-q", root])
    await mkdir(path.join(root, "nested"))
    const projectCanonical = realpathSync(root), directory = realpathSync(path.join(root, "nested")), family = await readFamilyAuthorityIdentity(directory)
    const location = Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: "project", directory: projectCanonical, canonical: projectCanonical } })
    const ref = Schema.decodeUnknownSync(Location.Ref)({ directory })
    db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL);
      CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,metadata TEXT,time_suspended INTEGER);
      CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY,seq INTEGER,owner_id TEXT);
      CREATE TABLE event(id TEXT PRIMARY KEY,aggregate_id TEXT,seq INTEGER,type TEXT,data TEXT);
      CREATE TABLE session_inbox(session_id TEXT);
      CREATE TABLE session_pending(session_id TEXT);
      CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,data TEXT,seq INTEGER);`)
    const encoded = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
    const get = (key: string) => { const row = db.prepare("SELECT value FROM kv WHERE key=?").get(encoded(key)) as { value: string } | undefined; return row && JSON.parse(row.value) }
    const put = (key: string, value: unknown) => db.prepare("INSERT INTO kv VALUES(?,?,0,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(encoded(key), JSON.stringify(value))
    const tx = tag("@test/TransactionService")
    let base: Context.Context<never>, transactionGraph: Context.Context<never>
    const sql = Object.assign(() => {}, { transactionService: tx,
      unsafe: (query: string, params: readonly unknown[]) => ({ withoutTransform: Effect.sync(() => {
        const statement = db.prepare(query)
        if (/^(INSERT|UPDATE)/.test(query)) { statement.run(...params as []); return [] }
        return statement.all(...params as [])
      }) }) })
    const database = { db: { $client: sql, transaction: <A>(callback: () => Effect.Effect<A, unknown>) => Effect.promise(async () => {
      db.exec("BEGIN IMMEDIATE")
      try { const result = await Effect.runPromise(callback().pipe(Effect.provideService(tx, {}), Effect.provide(transactionGraph ?? base))); db.exec("COMMIT"); return result }
      catch (error) { db.exec("ROLLBACK"); throw error }
    }) } }
    base = Context.make(dbTag, database).pipe(Context.add(locationTag, location))
    const storage = { get: (key: string) => Effect.sync(() => get(key)), set: (key: string, value: unknown) => Effect.sync(() => { put(key, value) }),
      scan: ({ prefix, after, limit }: { prefix: string; after?: string; limit: number }) => Effect.sync(() => {
        const found = db.prepare("SELECT key,value FROM kv WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?")
          .all(encoded(prefix).length, encoded(prefix), encoded(after ?? prefix), limit + 1) as Array<{ key: string; value: string }>
        const entries = found.slice(0, limit).map(row => ({ key: row.key.slice(encoded("").length), value: JSON.parse(row.value) }))
        return { entries, ...(found.length > limit ? { next: entries.at(-1)!.key } : {}) }
      }) }
    const ctx = { storage, location } as never
    const store = await Effect.runPromiseWith(base)(acquireNativeRecurrenceStore(ctx))
    const selected = { agent: "worker", model: { providerID: "provider", id: "model" } }
    const config = { template: "wayfinder" as const, consigne: "Finish once", clock: { time: "00:00", zone: "UTC" }, profileID: "profile", executionHost: "local",
      roots: [{ mode: "git" as const, directory, checkout: physical(projectCanonical), family }],
      profiles: { coordinator: selected, roles: Object.fromEntries(missionProfileRoles.wayfinder.map(role => [role, selected])) }, taskMode: "native" as const,
      watchedConversationIDs: ["ses_watched"], publication: { policy: "disabled" as const, conversationIDs: [] },
      budgets: { effects: 4, nativeCalls: 0, inboxMessages: 1, publications: 0 } }
    const profileSource = { profileID: "profile", executionHost: "local", configYamlPath: path.join(root, "config.yaml") }
    await writeFile(profileSource.configYamlPath, "server:\n  environmentVariables:\n    MARKER: fresh\n")
    let now = originalNow(), creates = 0, sends = 0, environment = "", loads = 0
    let document = await store.create("schedule", config, now - 86_400_000, () => true)
    put(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, "9f6f590e-271d-477f-8c02-7a6a119d63b9")
    const sessions = new Map<string, unknown>()
    sessions.set("ses_watched", Schema.decodeUnknownSync(Session.Info)({ id: "ses_watched", projectID: "project", location: { directory },
      time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }))
    const sourceMessage = Schema.decodeUnknownSync(SessionMessage.User)({ id: "msg_watched", type: "user", text: "Whole watched source reply", time: { created: 1 } })
    db.prepare("INSERT INTO session_v2 VALUES('ses_watched',NULL,'project',?,NULL,'{}',NULL)").run(directory)
    db.prepare("INSERT INTO event_sequence VALUES('ses_watched',0,NULL)").run()
    db.prepare("INSERT INTO event VALUES('evt_watched','ses_watched',0,'session.created.1',?)").run(JSON.stringify({ sessionID: "ses_watched" }))
    db.prepare("INSERT INTO session_message VALUES('msg_watched','ses_watched','user',?,0)").run(JSON.stringify({ text: sourceMessage.text }))
    const interrupted: string[] = [], inactive = new Set<string>()
    let failInterrupt: string | undefined
    const native = { get: (id: string) => Effect.sync(() => { const value = sessions.get(id); if (!value) throw new Error("Missing session"); return value }),
      create: (input: Record<string, unknown>) => Effect.sync(() => {
        creates++
        const result = Schema.decodeUnknownSync(Session.Info)({ ...input, model: { ...(input.model as Record<string, unknown>), variant: "default" },
          projectID: "project", time: { created: 1, updated: 1 },
          cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
        sessions.set(result.id, result)
        db.prepare("INSERT INTO session_v2 VALUES(?,NULL,'project',?,NULL,?,NULL)").run(result.id, directory, JSON.stringify(input.metadata))
        return result
      }), inbox: () => Effect.succeed([]), prompt: () => Effect.die("Raw prompt forbidden"),
      messages: (input: { sessionID: string; cursor?: { id: string } }) => Effect.succeed(input.sessionID === "ses_watched" && !input.cursor ? [sourceMessage] : []),
      message: (input: { sessionID: string; messageID: string }) => Effect.succeed(input.sessionID === "ses_watched" && input.messageID === sourceMessage.id ? sourceMessage : undefined),
      interrupt: (id: string, options: { resume: boolean }) => Effect.sync(() => {
        assert.equal(options.resume, false)
        assert(["paused", "stopped"].includes(get(`codenomad-missions/recurrence-v1/project/${store.projectToken}/schedule`).state), "denial precedes native interruption")
        if (id === failInterrupt) { failInterrupt = undefined; throw new Error("Original target interruption uncertain") }
        interrupted.push(id)
        const wasActive = !inactive.has(id); inactive.add(id); return wasActive
      }), cancelInbox: () => Effect.void,
      environment: (input: { variables: Record<string, string> }) => Effect.sync(() => { environment = input.variables.MARKER; return input.variables }),
      synthetic: (input: { sessionID: string; id: string; text: string; metadata: unknown; delivery: string; description: string }) => Effect.sync(() => {
        sends++
        const payload = { text: input.text, description: input.description, metadata: input.metadata }
        db.prepare("INSERT INTO session_message VALUES(?,?,'synthetic',?,0)").run(input.id, input.sessionID, JSON.stringify(payload))
        const events = [
          { type: "session.created.1", data: { sessionID: input.sessionID } },
          { type: "session.inbox.enqueued.1", data: { sessionID: input.sessionID, inboxID: input.id, item: { type: "synthetic", payload } } },
          { type: "session.execution.started.1", data: { sessionID: input.sessionID } },
          { type: "session.inbox.delivered.1", data: { sessionID: input.sessionID, inboxID: input.id } },
          { type: "session.execution.succeeded.1", data: { sessionID: input.sessionID } },
        ]
        events.forEach((event, index) => db.prepare("INSERT INTO event VALUES(?,?,?,?,?)").run(`evt_${sends}_${index}`, input.sessionID, index, event.type, JSON.stringify(event.data)))
        db.prepare("INSERT INTO event_sequence VALUES(?,4,NULL)").run(input.sessionID)
        return Schema.decodeUnknownSync(SessionInbox.Info)({ id: input.id, sessionID: input.sessionID, type: "synthetic",
          payload, delivery: input.delivery, time: { created: originalNow() } })
      }) }
    Object.assign(ctx, { session: { interrupt: (input: { sessionID: string; resume: boolean }) =>
      native.interrupt(input.sessionID, { resume: input.resume }).pipe(Effect.map(interrupted => ({ interrupted }))) } })
    const map = await Effect.runPromise(RcMap.make({ idleTimeToLive: Infinity, lookup: () => Effect.sync(() => { loads++; return base }) }).pipe(Effect.provideService(Scope.Scope, scope)))
    const locations = { rcMap: map, contextEffect: (key: Location.Ref) => RcMap.get(map, key), contextEffectOption: (key: Location.Ref) => RcMap.getOption(map, key) }
    const jobs = new Map<string, { id: string; type: string; status: string; metadata: Record<string, unknown>; run: Effect.Effect<string, unknown> }>()
    const job = { get: (id: string) => Effect.succeed(jobs.get(id)), start: (input: { id: string; type: string; metadata: Record<string, unknown>; run: Effect.Effect<string, unknown> }) => Effect.sync(() => {
      const record = { ...input, status: "running" }; jobs.set(input.id, record); return record
    }), cancel: (id: string) => Effect.sync(() => {
      const row = get(`codenomad-missions/recurrence-v1/project/${store.projectToken}/schedule`)
      assert(["paused", "stopped", "running"].includes(row.state), "CAS precedes predecessor consumption or denying cancellation")
      jobs.delete(id) // Native Job.cancel consumes completed/error/cancelled history too.
    }) }
    const invalidations: RecurrenceScheduleChanged[] = []
    const bus = { publish: (definition: { type: string }, data: RecurrenceScheduleChanged, options: { location: { directory: string } }) => Effect.sync(() => {
      assert.equal(db.isTransaction, false, "never publish optimistic native transaction state")
      assert.equal(options.location.directory, directory)
      const decoded = readRecurrenceScheduleChanged({ type: definition.type, data })
      assert(decoded)
      assert.deepEqual(Object.keys(decoded).sort(), ["revision", "scheduleID"])
      invalidations.push(decoded)
    }) }
    const app = base.pipe(Context.add(sessionTag, native), Context.add(tag("@opencode/Job"), job), Context.add(tag("@opencode/example/LocationServiceMap"), locations),
      Context.add(tag("@opencode/Bus"), bus),
      Context.add(tag("@opencode/Form"), { list: () => Effect.succeed([]) }), Context.add(tag("@opencode/Permission"), { list: () => Effect.succeed([]) }), Context.add(tag("@opencode/Shell"), { list: () => Effect.succeed([]) }))
    transactionGraph = app
    const auth = new AuthManager({ configPath: path.join(root, "auth"), username: "human", password: "offline-password", generateToken: false }, pino({ level: "silent" }) as never)
    const human = auth.createSession("human"), workspace = {}
    const deps = { auth, settings: { getProfileScope: () => ({ key: "profile" }) }, manager: { getServiceWslDistro: () => undefined,
      get: () => workspace, ownsLocation: async () => true, getSharedServiceConnection: async () => ({ assertCurrent: () => {}, client: { location: { get: async () => ({ directory }) } } }) } }
    const registration = createAutomationBridgeRegistration("http://127.0.0.1:1")
    bridge.post(AUTOMATION_BRIDGE_PATH, async (request, reply) => {
      if (request.headers["x-codenomad-automation-token"] !== registration.token) return reply.code(401).send({})
      const body = request.body as { command: unknown }
      return { result: await verifyHumanRecurrenceRequest(body.command, deps as never, new AbortController().signal) }
    })
    await bridge.listen({ host: "127.0.0.1", port: 0 })
    registration.url = `http://127.0.0.1:${(bridge.server.address() as { port: number }).port}${AUTOMATION_BRIDGE_PATH}`
    removeBridge = await publishAutomationBridge(registration)
    const request = (action: "play" | "pause" | "stop", revision: number, epoch: number) => {
      const identity = { sessionID: human.id, workspaceID: "owned", requestID: recurrenceHumanRequestID("schedule", epoch + 1, action === "play" ? "authorize" : action === "pause" ? "pause" : "revoke"),
        location: { directory }, scheduleID: "schedule", expectedRevision: revision, expectedEpoch: epoch, action, profileSource, issuedAt: originalNow() }
      const body = { ...identity, digest: recurrenceControlRequestDigest(identity) }
      return { ...body, proof: signNativeRecurrenceControl(body, registration.token) }
    }
    const initial = await Effect.runPromiseWith(app)(readNativeRecurrenceSnapshot(ctx))
    assert.equal(initial.schedules[0]?.state, "paused")
    assert.equal(initial.schedules[0]?.epoch, 0, "fresh native absence is distinct from unreadable signed authority")
    assert.deepEqual(initial.schedules[0]?.controlCapability?.actions, ["play"])
    assert.equal(jobs.size, 0, "reading CREATE never arms its first Job")
    const play = await Effect.runPromiseWith(app)(controlNativeRecurrence(ctx,
      request("play", document.revision, initial.schedules[0]!.epoch!)))
    assert.equal(play.epoch, 1)
    assert.equal(jobs.size, 1)
    assert.equal(invalidations.length, 2, "signed calendar and actual completed control receipt invalidate visible windows")
    await Effect.runPromise(Effect.scoped(RcMap.get(map, ref)))
    await Effect.runPromise(RcMap.invalidate(map, ref))
    // Advance the first UTC-minute sleep immediately after its ONE real tick.
    // Execute the actual registered Job effect, then stop at that sleep boundary.
    const first = [...jobs.values()][0]!
    const fiber = Effect.runForkWith(app)(first.run)
    const { Fiber } = await import("effect")
    const deadline = originalNow() + 45_000
    while (!(await store.read("schedule"))?.pending?.admission && originalNow() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    await Effect.runPromise(Fiber.interrupt(fiber))
    assert.equal(loads, 2)
    assert.equal(creates, 1); assert.equal(sends, 1); assert.equal(environment, "fresh")
    now = originalNow()
    const due = nativeRecurrenceDue(ctx, { projectID: "project", projectCanonical, directory, scheduleID: "schedule", profileID: "profile", executionHost: "local", epoch: 1 }, undefined, () => now)
    const journalStorage = { get: async (key: string) => get(key), set: async (key: string, value: unknown) => { put(key, value) },
      scan: async (options: { prefix: string; after?: string; limit?: number }) => Effect.runPromise(storage.scan({ ...options, limit: options.limit ?? 100 })) } as never
    const finish = async () => {
      const pending = (await store.read("schedule"))!
      assert.equal(pending.pending?.admission?.kind, "accepted")
      await recurrencePassage(journalStorage, pending, () => true).journal.append({ version: 1, id: "evt_finished", type: "mission.finished",
        missionID: pending.pending!.admission!.missionID, projectID: "project", createdAt: now, outcome: "completed", summary: "Exact succeeded native evidence" })
      assert.equal(await due(app, () => true, new AbortController().signal), "not-due")
    }
    await finish()
    now += 86_400_000
    assert.equal(await due(app, () => true, new AbortController().signal), "accepted")
    assert.equal(creates, 2); assert.equal(sends, 2)
    await finish()
    assert.equal((await store.read("schedule"))?.settledCount, 2)
    const running = await Effect.runPromiseWith(app)(readNativeRecurrenceSnapshot(ctx))
    assert.equal(running.schedules[0]?.state, "running")
    assert.deepEqual(running.schedules[0]?.controlCapability?.actions, ["pause", "stop"])
    jobs.clear() // Native service restart: durable signed schedule, no rearm.
    const snapshot = await Effect.runPromiseWith(app)(readNativeRecurrenceSnapshot(ctx))
    assert.equal(snapshot.schedules[0]?.state, "interrupted")
    assert.equal(jobs.size, 0)
    document = (await store.read("schedule"))!
    const resumed = await Effect.runPromiseWith(app)(controlNativeRecurrence(ctx, request("play", document.revision, 1)))
    assert.equal(resumed.epoch, 2); assert.equal(jobs.size, 1)
    document = (await store.read("schedule"))!
    const paused = await Effect.runPromiseWith(app)(controlNativeRecurrence(ctx, request("pause", document.revision, 2)))
    assert.equal(paused.state, "paused")
    assert.equal(jobs.size, 0)
    assert.equal(creates, 2); assert.equal(sends, 2)
    // Resume the idle calendar, then exercise Pause on a genuinely ACTIVE third
    // passage with a registered independent root, not just scheduler cancellation.
    document = (await store.read("schedule"))!
    const activePlay = await Effect.runPromiseWith(app)(controlNativeRecurrence(ctx, request("play", document.revision, 3)))
    now += 86_400_000
    const activeDue = nativeRecurrenceDue(ctx, { projectID: "project", projectCanonical, directory,
      scheduleID: "schedule", profileID: "profile", executionHost: "local", epoch: activePlay.epoch }, undefined, () => now)
    assert.equal(await activeDue(app, () => true, new AbortController().signal), "accepted")
    const active = (await store.read("schedule"))!
    const missionID = active.pending!.admission!.missionID, coordinatorID = active.pending!.admission!.conversationID
    const independentID = "ses_registered_independent"
    sessions.set(independentID, Schema.decodeUnknownSync(Session.Info)({ id: independentID, title: "Registered independent root", projectID: "project",
      location: { directory }, agent: selected.agent, model: { ...selected.model, variant: "default" },
      metadata: { "codenomad.mission": { missionID } }, time: { created: 1, updated: 1 },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }))
    const activeJournal = recurrencePassage(journalStorage, active, () => true).journal
    await activeJournal.append({ version: 1, id: "evt_registered_task", type: "task.created", missionID, projectID: "project", createdAt: now,
      task: { id: "tsk_registered", key: "registered", title: "Registered root", brief: "Existing actor", role: "research",
        executionMode: { kind: "independent", reason: "existing-root", explanation: "Existing registered root" }, blockedBy: [] } })
    await activeJournal.append({ version: 1, id: "evt_registered_root", type: "task.dispatching", missionID, projectID: "project", createdAt: now + 1,
      taskKey: "registered", actor: { sessionID: independentID, title: "Registered root", location: { directory }, managed: true },
      admissionID: "msg_registered", delivery: "queue" })
    await activeJournal.append({ version: 1, id: "evt_reused_task", type: "task.created", missionID, projectID: "project", createdAt: now + 2,
      task: { id: "tsk_reused", key: "reused", title: "Reuse registered root", brief: "Frozen reused contract", role: "prototype", execution: selected,
        executionMode: { kind: "independent", reason: "existing-root", explanation: "Reuse the same registered native root" }, blockedBy: [] } })
    await activeJournal.append({ version: 1, id: "evt_reused_root", type: "task.dispatching", missionID, projectID: "project", createdAt: now + 3,
      taskKey: "reused", actor: { sessionID: independentID, title: "Registered root", location: { directory }, managed: true },
      admissionID: "msg_reused", delivery: "queue" })
    const nativeChildID = "ses_ordinary_native_child"
    await activeJournal.append({ version: 1, id: "evt_native_task", type: "task.created", missionID, projectID: "project", createdAt: now + 4,
      task: { id: "tsk_native_child", key: "native-child", title: "Native child", brief: "Native delegated work", role: "research", blockedBy: [] } })
    await activeJournal.append({ version: 1, id: "evt_native_bound", type: "task.native-bound", missionID, projectID: "project", createdAt: now + 5,
      taskKey: "native-child", actor: { sessionID: nativeChildID, title: "Native child", location: { directory }, managed: true },
      binding: { generation: 1, parentSessionID: coordinatorID, toolCallID: "call_native", parentMessageID: "msg_native" } })
    assert.deepEqual((await activeJournal.snapshot()).missions[0]?.actors.map(actor => actor.sessionId), [coordinatorID, independentID, nativeChildID])
    failInterrupt = independentID
    const beforePause = (await store.read("schedule"))!
    const partial = await Effect.runPromiseWith(app)(controlNativeRecurrence(ctx, request("pause", beforePause.revision, 4)))
    assert.deepEqual(partial.nativeControl?.pending, [independentID], JSON.stringify(partial.nativeControl))
    assert.equal(partial.controlsComplete, false)
    assert.deepEqual(interrupted, [coordinatorID], "the scheduler cancellation also interrupts the exact owned coordinator")
    const completed = await Effect.runPromiseWith(app)(controlNativeRecurrence(ctx, request("pause", beforePause.revision, 4)))
    assert.equal(completed.epoch, 5, "explicit retry does not sign a replacement epoch")
    assert.deepEqual(completed.nativeControl?.pending, [])
    assert.equal(completed.nativeControl?.receipts?.length, 2)
    assert.equal(interrupted.filter(id => id === coordinatorID).length, 1, "known targets are never retried")
    assert.equal(interrupted.filter(id => id === independentID).length, 1)
    assert(!interrupted.includes(nativeChildID), "no recursive/native-child suspension claim or direct interrupt")
    const pinned = sessions.get(independentID) as Session.Info
    sessions.set(independentID, Schema.decodeUnknownSync(Schema.toType(Session.Info))({ ...pinned, model: { ...selected.model, variant: "high" } }))
    const stoppedDocument = (await store.read("schedule"))!
    const interruptedBeforeHigh = interrupted.filter(id => id === independentID).length
    const wrongHigh = await Effect.runPromiseWith(app)(controlNativeRecurrence(ctx, request("stop", stoppedDocument.revision, 5)))
    assert.deepEqual(wrongHigh.nativeControl?.pending, [independentID])
    assert.equal(interrupted.filter(id => id === independentID).length, interruptedBeforeHigh, "high drift cannot enter native interruption")
    sessions.set(independentID, pinned)
    const stopped = await Effect.runPromiseWith(app)(controlNativeRecurrence(ctx, request("stop", stoppedDocument.revision, 5)))
    assert.equal(stopped.state, "stopped")
    assert.deepEqual(stopped.nativeControl?.pending, [])
    assert.equal(creates, 3); assert.equal(sends, 3, "control retry never creates an actor, assignment or prompt")
    assert(invalidations.length > 12, "per-target receipts and status commits also invalidate without transcript polling")
  } finally {
    await removeBridge?.(); await bridge.close()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    db.close()
    if (originalLocal === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = originalLocal
    await rm(root, { recursive: true, force: true })
  }
})
