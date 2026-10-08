import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { Context, Effect, Exit, Fiber, RcMap, Schema, Scope } from "effect"
import { authorityDigest, authoritySignerDigest } from "../../missions/authority-protocol"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { recurrenceHumanRequestID, recurrenceStandingSigningBytes, RECURRENCE_AUTHORITY_POLICY } from "../../missions/recurrence-authority-contract"
import { physical } from "../../missions/host-authority/private-files"
import { readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { nativeDatabaseStorageID } from "./native-database-identity"
import { nativeRecurrenceDue, type ReconcileNativePending } from "./native-recurrence-due"
import { recurrenceInput, recurrenceSourceLocationDigest } from "../../missions/recurrence-input"
import type { RecurrenceChildRecord } from "../../missions/recurrence-authority-contract"
import { readNativeRecurrenceClock, startNativeRecurrenceClock } from "./native-service-clock"
import { observeNativeRecurrenceTerminalSettlement } from "./native-recurrence-settlement"

const tag = (name: string) => Context.Service<never, unknown>(name)
const dbTag = tag("@opencode/storage/Database"), locationTag = tag("@opencode/Location"), sessionTag = tag("@opencode/Session")
const jobTag = tag("@opencode/Job"), mapTag = tag("@opencode/example/LocationServiceMap")
const encoded = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`

for (const terminalOutcome of ["completed", "failed"] as const) {
test(`signed Play archives ${terminalOutcome} before calendar finish; crash never replays and the next day proceeds`, async () => {
  const root = await mkdtemp(path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir(), "missions-due-"))
  const db = new DatabaseSync(path.join(root, "service.sqlite"))
  const lifetime = await Effect.runPromise(Scope.make())
  let fiber: Fiber.Fiber<string, unknown> | undefined
  try {
    execFileSync("git", ["init", "-q", root])
    const directory = realpathSync(root), location = Schema.decodeUnknownSync(Location.Info)({ directory,
      project: { id: "project", directory, canonical: directory } })
    const ref = Schema.decodeUnknownSync(Location.Ref)({ directory })
    db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL)")
    db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,metadata TEXT,time_suspended INTEGER);
      CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY,seq INTEGER,owner_id TEXT);
      CREATE TABLE event(id TEXT,aggregate_id TEXT,seq INTEGER,type TEXT,data TEXT);
      CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,seq INTEGER,type TEXT,data TEXT);
      CREATE TABLE session_inbox(session_id TEXT);
      CREATE TABLE session_pending(session_id TEXT);`)
    let beforeTransaction: (() => void) | undefined
    const transactionService = tag("@test/TransactionService")
    const client = Object.assign(() => {}, { transactionService,
      unsafe: (sql: string, params: readonly unknown[]) => ({ withoutTransform: Effect.sync(() => {
        const statement = db.prepare(sql)
        if (sql.startsWith("UPDATE kv SET value=?") && failFinishOnce && typeof params[0] === "string"
          && JSON.parse(params[0]).pending === null) {
          failFinishOnce = false
          throw new Error("Simulated crash after authority archive")
        }
        if (failArchiveOnce && sql.startsWith("INSERT INTO kv") && typeof params[0] === "string"
          && params[0].startsWith(encoded(`${ledgerKey}/passages/`))) {
          failArchiveOnce = false
          throw new Error("Simulated crash during authority archive")
        }
        if (/^(INSERT|UPDATE)/.test(sql)) { statement.run(...params as []); return [] }
        return statement.all(...params as [])
      }) }),
    })
    const database = { db: { $client: client, transaction: <A>(callback: () => Effect.Effect<A, unknown>) =>
      Effect.promise(async () => {
        beforeTransaction?.()
        db.exec("BEGIN IMMEDIATE")
        try {
          const result = await Effect.runPromise(callback().pipe(Effect.provideService(transactionService, {}), Effect.provide(base)))
          db.exec("COMMIT")
          return result
        } catch (error) { db.exec("ROLLBACK"); throw error }
      }) } }
    const base = Context.make(dbTag, database).pipe(Context.add(locationTag, location))
    const get = (key: string) => {
      const row = db.prepare("SELECT value FROM kv WHERE key=?").get(encoded(key)) as { value: string } | undefined
      return row ? JSON.parse(row.value) as unknown : undefined
    }
    const put = (key: string, value: unknown) => db.prepare("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,time_updated=excluded.time_updated")
      .run(encoded(key), JSON.stringify(value), Date.now(), Date.now())
    const storage = { get: (key: string) => Effect.sync(() => get(key)), set: (key: string, value: unknown) => Effect.sync(() => { put(key, value) }),
      scan: ({ prefix, after, limit }: { prefix: string; after?: string; limit: number }) => Effect.sync(() => {
        const found = db.prepare("SELECT key,value FROM kv WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?")
          .all(encoded(prefix).length, encoded(prefix), encoded(after ?? prefix), limit + 1) as { key: string; value: string }[]
        const entries = found.slice(0, limit).map(row => ({ key: row.key.slice(encoded("").length), value: JSON.parse(row.value) }))
        return { entries, ...(found.length > limit ? { next: entries.at(-1)!.key } : {}) }
      }) }
    const ctx = { storage, location } as unknown as Parameters<typeof nativeRecurrenceDue>[0]
    const selection = { agent: "worker", model: { providerID: "provider", id: "model" } }
    const family = await readFamilyAuthorityIdentity(directory)
    const config = { template: "custom" as const, consigne: "Review", clock: { time: "00:00", zone: "UTC" }, profileID: "profile", executionHost: "native",
      roots: [{ mode: "git" as const, directory, checkout: physical(directory), family }],
      profiles: { coordinator: selection, roles: { specialist: selection } }, taskMode: "native" as const,
      watchedConversationIDs: [], publication: { policy: "disabled" as const, conversationIDs: [] } }
    const store = await Effect.runPromise(Effect.scoped(acquireNativeRecurrenceStore(ctx).pipe(Effect.provide(base))))
    let now = Date.now(), failFinishOnce = false, failArchiveOnce = false, terminal = false
    let document = await store.create("schedule", config, now - 2 * 86_400_000, () => true)
    document = await store.setState("schedule", document.revision, "running", () => true)
    const namespace = "9f6f590e-271d-477f-8c02-7a6a119d63b9", daemonStorageID = nativeDatabaseStorageID(path.join(root, "service.sqlite"))
    const scope = { namespace, daemonStorageID, projectID: "project", projectCanonical: directory,
      profileID: "profile", executionHost: "native", scheduleID: "schedule" }
    const keys = generateKeyPairSync("ed25519"), digest = authoritySignerDigest(keys.publicKey)
    const profile = { profileID: "profile", executionHost: "native", configYamlPath: path.join(root, "config.yaml") }
    await writeFile(profile.configYamlPath, "server:\n  environmentVariables:\n    MARKER: old\n")
    const body = { ...scope, version: 1 as const, policy: RECURRENCE_AUTHORITY_POLICY,
      action: "authorize" as const, epoch: 1, expectedRevision: null, requestID: recurrenceHumanRequestID("schedule", 1, "authorize"),
      scheduleRevision: document.scheduleRevision, authorityID: `rec_${digest.slice(0, 40)}`,
      keyID: `key_${digest.slice(0, 40)}`, provisioningGeneration: digest, signerDigest: digest,
      roots: config.roots, config: document.config, configDigest: authorityDigest(document.config), profileSource: profile,
      budgets: { effects: 3, nativeCalls: 0, inboxMessages: 0, publications: 0 } }
    const parent = { body, signature: sign(null, recurrenceStandingSigningBytes(body), keys.privateKey).toString("base64") }
    const { stableToken } = await import("../../missions/journal")
    const ledgerKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence/${stableToken(`project\0${directory}`, 24)}/${stableToken("profile\0native\0schedule", 40)}`
    put(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, namespace)
    put(`${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/profile`, keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"))
    put(`${ledgerKey}/parents/1`, parent)
    put(`${ledgerKey}/live`, { version: 1, scope, revision: 0, parent, settledSequence: 0, lastArchiveDigest: null, child: null })

    let loads = 0, creations = 0, sends = 0, sourceReads = 0, environment = ""
    let afterNativeCreate: (() => void) | undefined
    let rootSession: unknown
    const sessions = new Map<string, unknown>(), commands = new Map<string, { id: string; text: string; metadata: unknown }>()
    const replies: { id: string; text: string; completed: boolean }[] = [
      { id: "msg_one", text: "First full watched reply", completed: true },
      { id: "msg_partial", text: "Streaming partial", completed: false },
    ]
    let anchorRace: "delete" | "change" | undefined, sourceMoved = false
    const readCalls: { cursor?: { id: string }; limit: number }[] = []
    const replyInfo = (reply: typeof replies[number]) => Schema.decodeUnknownSync(SessionMessage.Info)({
      id: reply.id, type: "assistant", agent: "worker", model: selection.model,
      content: [{ type: "text", text: reply.text }], time: { created: 1, ...(reply.completed ? { completed: 3 } : {}) } })
    const watched = Schema.decodeUnknownSync(Session.Info)({ id: "ses_watched", projectID: "project", location: { directory },
      time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
    sessions.set("ses_watched", watched)
    db.prepare("INSERT INTO session_v2 VALUES(?,NULL,?,?,NULL,?,NULL)").run("ses_watched", "project", directory, "{}")
    const event = (sessionID: string, type: string, data: Record<string, unknown>) => {
      const previous = db.prepare("SELECT seq FROM event_sequence WHERE aggregate_id=?").get(sessionID) as { seq: number } | undefined
      const seq = (previous?.seq ?? -1) + 1
      db.prepare("INSERT INTO event VALUES(?,?,?,?,?)").run(`evt_${sessionID}_${seq}`, sessionID, seq, type, JSON.stringify({ sessionID, ...data }))
      db.prepare("INSERT INTO event_sequence VALUES(?,?,NULL) ON CONFLICT(aggregate_id) DO UPDATE SET seq=excluded.seq").run(sessionID, seq)
    }
    const native = { get: (id: string) => Effect.sync(() => {
      const target = sessions.get(id)
      if (!target) throw new Error("Native session missing")
      return id === "ses_watched" && sourceMoved ? { ...watched, location: { directory: `${directory}-moved` } } : target
    }),
      create: (request: Record<string, unknown>) => Effect.sync(() => {
        creations++; rootSession = Schema.decodeUnknownSync(Session.Info)({ ...request, projectID: "project",
          time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
        sessions.set(String(request.id), rootSession)
        db.prepare("INSERT INTO session_v2 VALUES(?,NULL,?,?,NULL,?,NULL)").run(String(request.id), "project", directory, JSON.stringify(request.metadata))
        event(String(request.id), "session.created.1", {})
        afterNativeCreate?.()
        return rootSession
      }), inbox: () => Effect.succeed([]), prompt: () => Effect.die("Raw prompt forbidden"),
      messages: (input: { cursor?: { id: string }; limit: number }) => Effect.sync(() => {
        sourceReads++; readCalls.push(input)
        if (anchorRace && input.cursor) {
          const index = replies.findIndex(reply => reply.id === input.cursor!.id)
          if (anchorRace === "delete") replies.splice(index, 1)
          else replies[index].text += " changed after query"
          return []
        }
        return replies.slice(input.cursor ? replies.findIndex(reply => reply.id === input.cursor!.id) + 1 : 0)
          .slice(0, input.limit).map(replyInfo)
      }),
      message: (input: { messageID: string }) => Effect.sync(() => {
        const reply = replies.find(reply => reply.id === input.messageID)
        return reply && replyInfo(reply)
      }),
      environment: (input: { variables: Record<string, string> }) => Effect.sync(() => { environment = input.variables.MARKER; return input.variables }),
      synthetic: (input: { sessionID: string; id: string; text: string; metadata: unknown; delivery: string; description: string }) => Effect.sync(() => {
        sends++
        commands.set(input.sessionID, input)
        db.prepare("INSERT INTO session_message VALUES(?,?,0,'synthetic',?)").run(input.id, input.sessionID, JSON.stringify(input))
        event(input.sessionID, "session.inbox.enqueued.1", { inboxID: input.id,
          item: { type: "synthetic", payload: { text: input.text, metadata: input.metadata } } })
        event(input.sessionID, "session.execution.started.1", {})
        event(input.sessionID, "session.inbox.delivered.1", { inboxID: input.id })
        return Schema.decodeUnknownSync(SessionInbox.Info)({ id: input.id, sessionID: input.sessionID, type: "synthetic",
          payload: { text: input.text, description: input.description, metadata: input.metadata },
          delivery: input.delivery, time: { created: Date.now() } })
      }) }
    const map = await Effect.runPromise(RcMap.make({ idleTimeToLive: Infinity, lookup: () => Effect.sync(() => {
      loads++
      return base
    }) }).pipe(Effect.provideService(Scope.Scope, lifetime)))
    const locations = { rcMap: map, contextEffect: (key: Location.Ref) => RcMap.get(map, key),
      contextEffectOption: (key: Location.Ref) => RcMap.getOption(map, key) }
    const jobs = new Map<string, { status: string; metadata: Record<string, unknown>; run: Effect.Effect<string, unknown> }>()
    const job = { get: (id: string) => Effect.sync(() => {
      const record = jobs.get(id)
      return record && { id, type: "codenomad.missions.recurrence", status: record.status, metadata: record.metadata }
    }), start: (input: { id: string; metadata: Record<string, unknown>; run: Effect.Effect<string, unknown> }) => Effect.sync(() => {
      jobs.set(input.id, { status: "running", metadata: input.metadata, run: input.run })
      return { id: input.id, type: "codenomad.missions.recurrence", status: "running", metadata: input.metadata }
    }), cancel: (id: string) => Effect.sync(() => { const found = jobs.get(id); if (found) found.status = "cancelled" }) }
    const emptyQueue = { list: () => Effect.succeed([]) }
    let pendingShells: unknown[] = []
    const app = base.pipe(Context.add(sessionTag, native), Context.add(jobTag, job), Context.add(mapTag, locations),
      Context.add(tag("@opencode/Form"), emptyQueue), Context.add(tag("@opencode/Permission"), emptyQueue),
      Context.add(tag("@opencode/Shell"), { list: () => Effect.succeed(pendingShells) }))
    const placement = { projectID: "project", projectCanonical: directory, directory, scheduleID: "schedule",
      profileID: "profile", executionHost: "native", epoch: 1 }
    const tornDocument = await store.create("torn_schedule", config, now - 2 * 86_400_000, () => true)
    const tornRunning = await store.setState(tornDocument.id, tornDocument.revision, "running", () => true)
    const tornScope = { ...scope, scheduleID: tornDocument.id }
    const tornBody = { ...body, ...tornScope, requestID: recurrenceHumanRequestID(tornDocument.id, 1, "authorize") }
    const tornParent = { body: tornBody, signature: sign(null, recurrenceStandingSigningBytes(tornBody), keys.privateKey).toString("base64") }
    const tornKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence/${store.projectToken}/${stableToken(`profile\0native\0${tornDocument.id}`, 40)}`
    const tornHead = { version: 1, scope: tornScope, revision: 0, parent: tornParent,
      settledSequence: 0, lastArchiveDigest: null, child: null }
    put(`${tornKey}/parents/1`, tornParent)
    put(`${tornKey}/live`, tornHead)
    const denialBody = { ...tornBody, action: "pause" as const, epoch: 2, expectedRevision: 0,
      requestID: recurrenceHumanRequestID(tornDocument.id, 2, "pause") }
    const denial = { body: denialBody, signature: sign(null, recurrenceStandingSigningBytes(denialBody), keys.privateKey).toString("base64") }
    const tornDue = nativeRecurrenceDue(ctx, { ...placement, scheduleID: tornDocument.id })
    let transactions = 0
    beforeTransaction = () => {
      // Provider acquisition verifies its native frame first. Publish the torn
      // denial only at calendar reserve entry, AFTER authorize's async reads.
      if (++transactions === 2) put(`${tornKey}/parents/2`, denial)
    }
    await assert.rejects(tornDue(app, () => true, new AbortController().signal))
    beforeTransaction = undefined
    assert.equal(transactions, 2, "late denial reaches the synchronous calendar CAS fence")
    assert.deepEqual(await store.read(tornDocument.id), tornRunning, "late torn denial vetoes calendar reservation")
    await assert.rejects(tornDue(app, () => true, new AbortController().signal),
      (error: unknown) => error instanceof Error
        && (error as Error & { cause?: { code?: string } }).cause?.code === "authorization-blocked")
    assert.deepEqual(await store.read(tornDocument.id), tornRunning, "torn denial cannot reserve the calendar")
    assert.deepEqual([creations, sends, environment], [0, 0, ""], "zero native create/environment/message effects")
    // Exact original denial reconciliation remains possible; it grants no replay.
    put(`${tornKey}/live`, { ...tornHead, revision: 1, parent: denial })
    await store.setState(tornDocument.id, tornRunning.revision, "paused", () => true)
    assert.equal(await tornDue(app, () => true, new AbortController().signal), "inactive")
    assert.equal((await store.read(tornDocument.id))?.pending, null)
    assert.deepEqual([creations, sends, environment], [0, 0, ""])
    await writeFile(profile.configYamlPath, "server: [malformed\n")
    await assert.rejects(nativeRecurrenceDue(ctx, placement)(app, () => true, new AbortController().signal))
    assert.deepEqual(await store.read("schedule"), document, "unreadable signed YAML cannot reserve calendar/high-water")
    assert.equal((get(`${ledgerKey}/live`) as { child: unknown }).child, null)
    assert.deepEqual([sourceReads, creations, sends, environment], [0, 0, 0, ""], "YAML preparation has no native ENV writes")
    await writeFile(profile.configYamlPath, "server:\n  environmentVariables:\n    MARKER: old\n")
    for (const [id, effects, inboxMessages, consigne] of [
      ["low_inbox", 4, 0, "Review"], ["low_effects", 3, 1, "Review"],
      ["oversized_input", 4, 1, "x".repeat(16_384)],
    ] as const) {
      const draft = await store.create(id, { ...config, consigne, watchedConversationIDs: ["ses_watched"] },
        now - 2 * 86_400_000, () => true)
      const before = await store.setState(id, draft.revision, "running", () => true)
      const budgetScope = { ...scope, scheduleID: id }
      const budgetBody = { ...body, ...budgetScope, config: before.config, configDigest: authorityDigest(before.config),
        requestID: recurrenceHumanRequestID(id, 1, "authorize"), budgets: { effects, inboxMessages, nativeCalls: 0, publications: 0 } }
      const budgetParent = { body: budgetBody,
        signature: sign(null, recurrenceStandingSigningBytes(budgetBody), keys.privateKey).toString("base64") }
      const key = `${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence/${store.projectToken}/${stableToken(`profile\0native\0${id}`, 40)}`
      const head = { version: 1, scope: budgetScope, revision: 0, parent: budgetParent,
        settledSequence: 0, lastArchiveDigest: null, child: null }
      put(`${key}/parents/1`, budgetParent)
      put(`${key}/live`, head)
      const limited = nativeRecurrenceDue(ctx, { ...placement, scheduleID: id })
      const outcome = await limited(app, () => true, new AbortController().signal).catch(() => "rejected-before-effect")
      assert.equal(outcome, "rejected-before-effect", `${id}: fail before any calendar reservation`)
      assert.deepEqual(await store.read(id), before, `${id}: no pending, high-water, history or revision change`)
      assert.deepEqual(get(`${key}/live`), head, `${id}: no child or read reservation`)
      assert.deepEqual([sourceReads, creations, sends, environment], [0, 0, 0, ""], `${id}: no native effects`)
    }
    const observer: ReconcileNativePending = async (provider, nativeStorage, child, signal) => {
      signal.throwIfAborted()
      if (terminalOutcome === "failed") return observeNativeRecurrenceTerminalSettlement(provider, nativeStorage, child, signal)
      const doc = (await store.read("schedule"))!
      const journal = recurrencePassage(nativeStorage, doc, () => true).journal
      const snapshot = await journal.snapshot()
      if (!terminal || snapshot.missions.length !== 1 || snapshot.missions[0]?.status !== "completed"
        || snapshot.missions[0].id !== child.grant.missionID
        || child.effects.length !== 3 || child.effects.some(effect => effect.receipt?.outcome !== "applied")) {
        throw new Error("Native terminal evidence incomplete")
      }
      return { settlement: { grantID: child.grant.grantID, evidenceID: "evt_native_terminal", outcome: "completed",
        effects: child.effects.map(effect => effect.receipt!), nativeIdle: true,
        controlsSettled: true, notificationsSettled: true, derivedCallsEnded: true },
      assertCurrent: () => { signal.throwIfAborted(); provider.assertCurrent()
        if (!terminal) throw new Error("Native terminal evidence withdrawn")
        return true as const },
      }
    }
    const originLocation = { directory: location.directory, workspaceID: location.workspaceID, project: { ...location.project } }
    const origin = Proxy.revocable({ storage, location: originLocation, session: { staleGraph: "must not be captured" } }, {})
    const due = nativeRecurrenceDue(origin.proxy as unknown as Parameters<typeof nativeRecurrenceDue>[0], placement, observer, () => now)
    origin.revoke() // Retired full plugin context is inaccessible after construction.
    originLocation.directory = `${directory}-retired` as typeof location.directory
    originLocation.project.canonical = `${directory}-retired` as typeof location.project.canonical
    await Effect.runPromise(Effect.scoped(RcMap.get(map, ref)))
    await Effect.runPromise(RcMap.invalidate(map, ref))
    await writeFile(profile.configYamlPath, "server:\n  environmentVariables:\n    MARKER: fresh\n")
    await Effect.runPromiseWith(app)(startNativeRecurrenceClock(placement, due))
    fiber = Effect.runForkWith(app)([...jobs.values()][0]!.run)
    // The Job sleeps after accepted. Its native synthetic is the bounded entry receipt.
    await Promise.race([new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { clearInterval(interval); reject(new Error("Due admission did not complete")) }, 30_000)
      const interval = setInterval(() => { if (sends) { clearTimeout(timeout); clearInterval(interval); resolve() } }, 5)
    }), Effect.runPromise(Fiber.await(fiber)).then(exit => { throw new Error(`Due Job ended: ${JSON.stringify(exit)}`) })])
    const deadline = Date.now() + 30_000
    while ((await store.read("schedule"))?.pending?.admission?.kind !== "accepted" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(loads, 2)
    assert.equal(creations, 1)
    assert.equal(sends, 1)
    assert.equal(environment, "fresh")
    const pending = await store.read("schedule")
    assert.equal(pending?.pending?.admission?.kind, "accepted")
    assert.equal(pending.pending.admission.conversationID, (rootSession as { id: string }).id)
    assert.equal(pending.pending.admission.messageID, pending.pending.passage.messageID)
    assert.equal(pending.history.length, 0, "native admission is not terminal archival")
    const acceptedLedger = get(`${ledgerKey}/live`) as { child: { grant: { coordinatorSessionID: string; messageID: string };
      effects: { receipt: { outcome: string } | null }[] } }
    assert.equal(acceptedLedger.child.grant.coordinatorSessionID, (rootSession as { id: string }).id)
    assert.equal(acceptedLedger.child.grant.messageID, pending.pending.passage.messageID)
    assert.deepEqual(acceptedLedger.child.effects.map(effect => effect.receipt?.outcome), ["applied", "applied", "applied"])
    // The first Job invocation is complete. Drive subsequent minute/day ticks
    // through its SAME callback without a competing fixture fiber acquiring a
    // newer native nonce while the earlier check is still in flight.
    await Effect.runPromise(Fiber.interrupt(fiber))
    assert.equal(await nativeRecurrenceDue(ctx, placement)(app, () => true, new AbortController().signal), "pending",
      "the real observer refuses unfinished native work; no invented completed receipt")
    assert.equal(await due(app, () => true, new AbortController().signal), "pending")
    assert.equal(creations, 1)
    assert.equal(sends, 1)
    const journalStorage = { get: async (key: string) => get(key) as never,
      set: async (key: string, value: unknown) => { put(key, value) },
      scan: async (options: { prefix: string; after?: string; limit?: number }) =>
        Effect.runPromise(storage.scan({ ...options, limit: options.limit ?? 100 })) as never }
    const recordTerminal = async (doc: NonNullable<Awaited<ReturnType<typeof store.read>>>) => {
      if (terminalOutcome === "completed") {
        await recurrencePassage(journalStorage, doc, () => true).journal.append({ version: 1, id: "evt_finished",
          type: "mission.finished", missionID: doc.pending!.admission!.missionID, projectID: "project",
          createdAt: now, outcome: "completed", summary: "Native terminal evidence" })
        return
      }
      const mission = (await recurrencePassage(journalStorage, doc, () => true).journal.snapshot()).missions[0]
      const acknowledgement = mission.control!.receipts![0].nativeAcknowledgement!
      assert.equal(acknowledgement.disposition, "start-admitted")
      if (acknowledgement.disposition !== "start-admitted") throw new Error("Exact start receipt missing")
      const message = acknowledgement.admission, sessionID = message.sessionID
      // Admission above already persisted the original root/input and events.
      // Append only terminal evidence; never fabricate or overwrite that entry.
      const session = db.prepare("SELECT metadata FROM session_v2 WHERE id=?").get(sessionID) as { metadata: string }
      assert.deepEqual(JSON.parse(session.metadata), { "codenomad.mission": {
        version: 1, missionID: mission.id, kind: "coordinator", role: "coordinator" } })
      const original = db.prepare("SELECT data FROM session_message WHERE id=? AND session_id=?").get(message.id, sessionID) as { data: string }
      const payload = JSON.parse(original.data)
      assert.equal(payload.text, message.payload.text)
      assert.deepEqual(payload.metadata, message.payload.metadata)
      const head = db.prepare("SELECT seq FROM event_sequence WHERE aggregate_id=?").get(sessionID) as { seq: number }
      assert.equal(head.seq, 3)
      event(sessionID, "session.execution.failed.1", { error: { type: "provider.no-route", message: "Model unavailable" } })
    }
    if (terminalOutcome === "completed") await recurrencePassage(journalStorage, pending, () => true).journal.append({ version: 1, id: "evt_finished",
      type: "mission.finished", missionID: pending.pending.admission.missionID, projectID: "project",
      createdAt: now, outcome: "completed", summary: "Native terminal evidence" })
    terminal = true
    assert.equal(await nativeRecurrenceDue(ctx, placement)(app, () => true, new AbortController().signal), "pending",
      "a completed journal without native execution/event evidence cannot settle")
    if (terminalOutcome === "failed") {
      await recordTerminal(pending)
      pendingShells = [{ id: "sh_uncorrelated", status: "running", command: "work", cwd: directory,
        shell: "pwsh", file: path.join(root, "output"), metadata: {}, time: { started: 1 } }]
      assert.equal(await due(app, () => true, new AbortController().signal), "pending", "uncorrelated running Shell is not terminal evidence")
      pendingShells = []
      failArchiveOnce = true
      assert.equal(await due(app, () => true, new AbortController().signal), "pending")
      assert.equal((get(`${ledgerKey}/live`) as { child: unknown }).child !== null, true)
      assert.equal((await recurrencePassage(journalStorage, pending, () => true).journal.snapshot()).missions[0].status,
        "active", "native transaction rollback retains original child and rolls back failure publication")
      assert.deepEqual([creations, sends], [1, 1], "archive failure grants no replay")
    }
    failFinishOnce = true
    assert.equal(await due(app, () => true, new AbortController().signal), "pending")
    assert.equal((await store.read("schedule"))?.pending?.passage.id, pending.pending.passage.id,
      "a crash after authority archive cannot silently clear the calendar")
    assert.equal((get(`${ledgerKey}/live`) as { child: unknown }).child, null)
    const archived = get(`${ledgerKey}/passages/${pending.pending.passage.id}`) as { settlement: { outcome: string } }
    assert.equal(archived.settlement.outcome, terminalOutcome, "failure is archived as failed, never green")
    assert.equal((await recurrencePassage(journalStorage, pending, () => true).journal.snapshot()).missions[0].status, terminalOutcome)
    assert.equal(await due(app, () => true, new AbortController().signal), "not-due",
      "the exact immutable archive completes metadata without observing or replaying native effects")
    const finished = (await store.read("schedule"))!
    assert.equal(finished.pending, null)
    assert.equal(finished.history.length, 1)
    assert.ok("outcome" in finished.history[0].result)
    assert.equal(finished.history[0].result.outcome, terminalOutcome)
    assert.equal(creations, 1)
    assert.equal(sends, 1)
    now += 86_400_000
    assert.equal(await due(app, () => true, new AbortController().signal), "accepted")
    assert.equal(creations, 2)
    assert.equal(sends, 2)
    const next = (await store.read("schedule"))!
    assert.equal(next.pending?.admission?.kind, "accepted")
    assert.notEqual(next.pending.passage.id, pending.pending.passage.id)
    await recordTerminal(next)
    assert.equal(await due(app, () => true, new AbortController().signal), "not-due")
    assert.equal((await store.read("schedule"))?.settledCount, 2)

    // Exercise the ACTUAL due consumer, native SQL provider and native source
    // reader. No direct reserve/admit shortcut or backend fixture is involved.
    const followed = async (id: string, cursors: typeof document.cursors = []) => {
      const draft = await store.create(id, { ...config, watchedConversationIDs: ["ses_watched"] }, now - 2 * 86_400_000, () => true)
      const running = await store.setState(id, draft.revision, "running", () => true)
      if (cursors.length) {
        // Seed an existing historical cursor through the strict metadata codec.
        // The tested due invocation below still owns all native admission/read work.
        const at = now - 86_400_000
        const historical = await store.reserve(id, running.revision, { kind: "manual", requestID: "history_seed",
          expectedRevision: running.revision, at }, at, () => true)
        const passage = historical.pending!.passage
        const receipt = { passageID: passage.id, messageID: passage.messageID,
          missionID: "msn_historical", conversationID: "ses_historical" }
        await store.recordAdmission(id, { ...receipt, kind: "accepted" }, at, () => true)
        await store.finish(id, { ...receipt, outcome: "completed", artifactMessageIDs: [], cursors }, at, () => true)
      }
      const exact = (await store.read(id))!, sourceScope = { ...scope, scheduleID: id }
      const signedBody = { ...body, ...sourceScope, config: exact.config, configDigest: authorityDigest(exact.config),
        requestID: recurrenceHumanRequestID(id, 1, "authorize"), budgets: { effects: 4, nativeCalls: 0, inboxMessages: 4, publications: 0 } }
      const signedParent = { body: signedBody, signature: sign(null, recurrenceStandingSigningBytes(signedBody), keys.privateKey).toString("base64") }
      const key = `${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence/${store.projectToken}/${stableToken(`profile\0native\0${id}`, 40)}`
      put(`${key}/parents/1`, signedParent)
      put(`${key}/live`, { version: 1, scope: sourceScope, revision: 0, parent: signedParent, settledSequence: 0, lastArchiveDigest: null, child: null })
      const callback = nativeRecurrenceDue(ctx, { ...placement, scheduleID: id }, undefined, () => now)
      const tick = () => callback(app, () => true, new AbortController().signal)
      return { id, key, tick, exact }
    }
    const source = await followed("followed")
    const sourceHead = () => get(`${source.key}/live`) as { child: RecurrenceChildRecord | null }
    const sourcePending = async () => {
      const pending = (await store.read(source.id))!
      assert.equal(pending.pending?.admission?.kind, "accepted")
      return pending
    }
    const completeSource = async (doc: typeof document, outcome: "completed" | "failed" = "completed") => {
      const accepted = doc.pending!.admission!
      event(accepted.conversationID, outcome === "completed" ? "session.execution.succeeded.1" : "session.execution.failed.1",
        outcome === "failed" ? { error: { type: "provider.no-route" } } : {})
      await recurrencePassage(journalStorage, doc, () => true).journal.append({ version: 1, id: "evt_finished", type: "mission.finished",
        missionID: accepted.missionID, projectID: "project", createdAt: now, outcome, summary: "Exact offline native terminal" })
    }
    assert.equal(await source.tick(), "accepted")
    const firstSource = await sourcePending(), firstChild = sourceHead().child!
    const firstCommand = commands.get(firstSource.pending!.admission!.conversationID)!
    assert.equal(firstCommand.text, recurrenceInput(firstChild).text, "deterministic input is identical to lifecycle ACK text")
    assert(firstCommand.text.includes("First full watched reply")); assert(!firstCommand.text.includes("Streaming partial"))
    assert.deepEqual(firstChild.effects[0].receipt!.sourceMessages!.map(message => message.id), ["msg_one"])
    assert.equal(firstChild.effects[0].effect.kind, "inbox-read")
    assert.deepEqual(firstSource.cursors, [], "a positive read ACK is not processed output")
    await completeSource(firstSource)
    failFinishOnce = true
    assert.equal(await source.tick(), "pending", "authority archive precedes calendar finish")
    assert.equal(sourceHead().child, null)
    assert.deepEqual((await store.read(source.id))!.cursors, [], "crash after authority archive cannot advance cursors")
    assert.equal(await source.tick(), "not-due", "exact source archive resumes metadata only")
    const firstArchive = (await store.read(source.id))!
    assert.deepEqual(firstArchive.cursors, [{ conversationID: "ses_watched", messageID: "msg_one",
      locationDigest: recurrenceSourceLocationDigest({ directory }) }])

    now += 86_400_000
    replies[1].completed = true; replies[1].text = "Final stable same-ID reply " + "x".repeat(4 * 1024)
    replies.push({ id: "msg_three", text: "Only new next-day reply", completed: true })
    assert.equal(await source.tick(), "accepted")
    const secondSource = await sourcePending(), secondChild = sourceHead().child!
    assert.equal(readCalls.at(-1)!.cursor?.id, "msg_one")
    assert.deepEqual(secondChild.effects[0].receipt!.sourceMessages!.map(message => message.id), ["msg_partial", "msg_three"])
    const secondCommand = commands.get(secondSource.pending!.admission!.conversationID)!
    assert(secondCommand.text.includes(replies[1].text)); assert(secondCommand.text.includes("Only new next-day reply"))
    assert(!secondCommand.text.includes("First full watched reply")); assert(secondCommand.text.length <= 16_384)
    assert.deepEqual(secondSource.cursors, firstArchive.cursors)
    await completeSource(secondSource)
    db.prepare("UPDATE session_v2 SET directory=? WHERE id='ses_watched'").run(`${directory}-moved`)
    assert.equal(await source.tick(), "pending", "moved source cannot borrow terminal read receipts")
    assert.deepEqual((await store.read(source.id))!.cursors, firstArchive.cursors)
    db.prepare("UPDATE session_v2 SET directory=? WHERE id='ses_watched'").run(directory)
    assert.equal(await source.tick(), "not-due")
    const secondArchive = (await store.read(source.id))!
    assert.equal(secondArchive.cursors[0].messageID, "msg_three")

    now += 86_400_000
    replies.push({ id: "msg_oversized", text: "z".repeat(20 * 1024), completed: true })
    assert.equal(await source.tick(), "accepted")
    const oversized = await sourcePending(), reference = sourceHead().child!.effects[0].receipt!.sourceMessages![0]
    assert.equal(reference.id, "msg_oversized"); assert.equal(reference.needsDecision, "source-input-capacity")
    assert.equal(reference.text, "")
    const oversizedCommand = commands.get(oversized.pending!.admission!.conversationID)!
    assert(oversizedCommand.text.includes("msg_oversized")); assert(!oversizedCommand.text.includes("z".repeat(1024)))
    assert(oversizedCommand.text.length <= 16_384)
    await completeSource(oversized)
    assert.equal(await source.tick(), "not-due")
    assert.deepEqual((await store.read(source.id))!.cursors, secondArchive.cursors, "oversized reference never consumes its cursor")

    now += 86_400_000
    replies.at(-1)!.text = "Now manageable full reply"
    replies.push({ id: "msg_unhandled", text: "Read before provider failure", completed: true })
    assert.equal(await source.tick(), "accepted")
    const failedSource = await sourcePending()
    await completeSource(failedSource, "failed")
    assert.equal(await source.tick(), "pending", "production observer does not invent failed terminal qualification")
    // Offline exact known-failure producer stand-in; test the real due archival
    // path without adding a new production failure-observation policy.
    const knownFailed: ReconcileNativePending = async (provider, storage, child, signal) => {
      signal.throwIfAborted()
      const native = provider.readSession(child.grant.coordinatorSessionID, child.grant.messageID)
      const terminal = native.events.at(-1)!
      assert.equal(terminal.type, "session.execution.failed.1")
      assert.equal(JSON.parse(String(terminal.data)).error.type, "provider.no-route")
      assert.equal(native.ownerID, null); assert.equal(native.inbox, 0); assert.equal(native.pending, 0)
      const snapshot = await recurrencePassage(storage, failedSource, () => true).journal.snapshot()
      assert.equal(snapshot.missions[0].status, "failed")
      assert(child.effects.every(item => item.receipt?.outcome === "applied"))
      return { settlement: { grantID: child.grant.grantID, evidenceID: String(terminal.id), outcome: "failed",
        effects: child.effects.map(item => item.receipt!), nativeIdle: true, controlsSettled: true,
        notificationsSettled: true, derivedCallsEnded: true }, assertCurrent: () => { signal.throwIfAborted(); return provider.assertCurrent() } }
    }
    const failedDue = nativeRecurrenceDue(ctx, { ...placement, scheduleID: source.id }, knownFailed, () => now)
    assert.equal(await failedDue(app, () => true, new AbortController().signal), "not-due")
    const failedResult = (await store.read(source.id))!.history.at(-1)!.result
    assert("outcome" in failedResult)
    assert.equal(failedResult.outcome, "failed")
    assert.deepEqual((await store.read(source.id))!.cursors, secondArchive.cursors, "failed read ACKs remain charged, not processed")

    now += 86_400_000
    assert.equal(await source.tick(), "accepted")
    const retryDay = await sourcePending(), retryText = commands.get(retryDay.pending!.admission!.conversationID)!.text
    assert(retryText.includes("Read before provider failure")); assert(retryText.includes("Now manageable full reply"))
    assert.equal(readCalls.at(-1)!.cursor?.id, "msg_three", "new passage reads failed passage's unprocessed source IDs")
    await completeSource(retryDay)
    assert.equal(await source.tick(), "not-due")
    const finalArchive = (await store.read(source.id))!
    assert.equal(finalArchive.cursors[0].messageID, "msg_unhandled")

    // Moved and deleted/changed ORIGINAL anchors park only the original read,
    // never clear the cursor, create a coordinator or retry the native query.
    for (const kind of ["moved", "change", "delete"] as const) {
      const unknownSource = await followed(`anchor_${kind}`, finalArchive.cursors)
      const before: [number, number, number] = [sourceReads, creations, sends]
      if (kind === "moved") sourceMoved = true
      else anchorRace = kind
      assert.equal(await unknownSource.tick(), "unknown")
      assert.deepEqual((await store.read(unknownSource.id))!.cursors, finalArchive.cursors)
      assert.equal((await store.read(unknownSource.id))!.pending!.admission, null)
      assert.deepEqual([creations, sends], before.slice(1), "unknown source never creates/adopts a root")
      const after = sourceReads
      assert.equal(await unknownSource.tick(), "pending")
      assert.equal(sourceReads, after, "uncertain source read is never replayed")
      sourceMoved = false; anchorRace = undefined
    }
    const beforePause = [creations, sends]
    now += 86_400_000
    const cancelledDispatch = new AbortController()
    afterNativeCreate = () => {
      // This native create already passed its single-use call-entry fence.
      // Commit signed Pause BEFORE returning its typed positive native ACK.
      const hot = get(`${ledgerKey}/live`) as Record<string, unknown>
      const paused = { ...body, action: "pause" as const, epoch: 2, expectedRevision: hot.revision as number,
        requestID: recurrenceHumanRequestID("schedule", 2, "pause") }
      const pausedParent = { body: paused, signature: sign(null, recurrenceStandingSigningBytes(paused), keys.privateKey).toString("base64") }
      const sourceKey = `${"codenomad-missions/recurrence-v1"}/project/${store.projectToken}/schedule`
      const fresh = get(sourceKey) as Record<string, unknown>
      db.exec("BEGIN IMMEDIATE")
      try {
        put(`${ledgerKey}/parents/2`, pausedParent)
        put(`${ledgerKey}/live`, { ...hot, revision: (hot.revision as number) + 1, parent: pausedParent })
        put(sourceKey, { ...fresh, revision: (fresh.revision as number) + 1, state: "paused" })
        db.exec("COMMIT")
      } catch (error) { db.exec("ROLLBACK"); throw error }
      queueMicrotask(() => cancelledDispatch.abort("Pause cancelled the due Job"))
    }
    assert.equal(await due(app, () => true, cancelledDispatch.signal), "unknown",
      "Pause after native entry blocks subsequent start/message, not the positive create ACK")
    assert.equal(cancelledDispatch.signal.aborted, true)
    afterNativeCreate = undefined
    const pausedSource = (await store.read("schedule"))!
    assert.equal(pausedSource.state, "paused")
    assert.equal(pausedSource.pending?.admission, null)
    const pausedLedger = get(`${ledgerKey}/live`) as { child: { effects: { effect: { kind: string }; receipt: { outcome: string } | null }[] } }
    assert.deepEqual(pausedLedger.child.effects.map(effect => [effect.effect.kind, effect.receipt?.outcome ?? null]),
      [["create", "applied"]], "the original positive native return is committed under the advanced signed epoch")
    terminal = false
    assert.equal(await due(app, () => true, new AbortController().signal), "pending")
    assert.equal(creations, beforePause[0] + 1)
    assert.equal(sends, beforePause[1])
    await Effect.runPromise(Fiber.interrupt(fiber))
    jobs.clear() // The native service restarted: in-memory Job is gone; no startup auto-arm.
    assert.equal(await Effect.runPromiseWith(app)(readNativeRecurrenceClock(placement)), false)
    assert.equal(jobs.size, 0)
  } finally {
    if (fiber) await Effect.runPromise(Fiber.interrupt(fiber))
    await Effect.runPromise(Scope.close(lifetime, Exit.void))
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
}
