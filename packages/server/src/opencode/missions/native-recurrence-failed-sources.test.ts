import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { realpathSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Context, Effect, Exit, Schema, Scope } from "effect"
import { Location } from "@opencode/schema/location"
import { authorityDigest, authoritySignerDigest, MISSION_AUTHORITY_POLICY } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { RecurrenceAuthority } from "../../missions/recurrence-authority-core"
import { deriveRecurrenceChild, recurrenceAuthorityDigest, recurrenceEffectID, recurrenceHumanRequestID, recurrenceStandingSigningBytes,
  RECURRENCE_AUTHORITY_POLICY, type RecurrenceChildRecord, type RecurrenceEffect } from "../../missions/recurrence-authority-contract"
import { recurrenceInput, recurrenceReadEvidence, recurrenceSources, recurrenceSourceCursors,
  recurrenceSourceLocationDigest } from "../../missions/recurrence-input"
import { recurrenceSourceContextLimit } from "../../missions/recurrence-read-budget"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"
import { MissionRecurrenceRunner } from "../../missions/recurrence-runner"
import { controlOperationID, controlReceiptID } from "../../missions/receipt-identity"
import { stableToken, type MissionStorage } from "../../missions/journal"
import { physical } from "../../missions/host-authority/private-files"
import { readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import { acquireNativeRecurrenceAuthorityProvider } from "./native-authority-provider"
import { nativeRecurrenceAdapter, type NativeStandingSigner } from "./native-recurrence-adapter"
import { nativeDatabaseStorageID } from "./native-database-identity"
import { observeNativeRecurrenceTerminalSettlement } from "./native-recurrence-settlement"
import { nativeRecurrenceDue } from "./native-recurrence-due"

const tag = (name: string) => Context.Service<never, unknown>(name)
const nativeKey = (key: string) => `plugin:${Array.from("codenomad.missions").map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
const current = () => true as const

for (const failure of [
  { type: "provider.no-route", status: undefined, modelStep: false, retry: false },
  { type: "provider.auth", status: 401, modelStep: true, retry: false },
  { type: "provider.rate-limit", status: 429, modelStep: true, retry: true },
] as const) {
test(`actual native ${failure.type} failure archives charged sources and ended Steps without consuming cursors`, async () => {
  const temporary = await mkdtemp(path.join(process.env.LOCALAPPDATA!, "Temp", "opencode", "failed-sources-offline-"))
  execFileSync("git", ["init", "-q", temporary])
  const directory = realpathSync(temporary), family = await readFamilyAuthorityIdentity(directory)
  const db = new DatabaseSync(path.join(directory, "offline.sqlite")), lifetime = await Effect.runPromise(Scope.make())
  try {
    db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL);
      CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,metadata TEXT,time_suspended INTEGER);
      CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY,seq INTEGER,owner_id TEXT);
      CREATE TABLE event(id TEXT,aggregate_id TEXT,seq INTEGER,type TEXT,data TEXT);
      CREATE TABLE session_inbox(session_id TEXT); CREATE TABLE session_pending(session_id TEXT);
      CREATE TABLE session_message(id TEXT,session_id TEXT,seq INTEGER,type TEXT,data TEXT);`)
    const get = (key: string) => {
      const row = db.prepare("SELECT value FROM kv WHERE key=?").get(nativeKey(key)) as { value: string } | undefined
      return row ? JSON.parse(row.value) : undefined
    }
    const put = (key: string, value: unknown) => {
      db.prepare("INSERT INTO kv VALUES(?,?,1,1) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(nativeKey(key), JSON.stringify(value))
    }
    // Only storage/service graph and pre-existing native records are fixture data.
    // Provider, source/input validation, failure observer, journal and authority core are real.
    const storage: MissionStorage = {
      get: async key => get(key), set: async (key, value, fence) => { fence?.(); put(key, value); fence?.() },
      scan: async ({ prefix, after, limit = 100 }) => {
        const rows = db.prepare("SELECT key,value FROM kv WHERE key>=? AND key>? ORDER BY key")
          .all(nativeKey(prefix), nativeKey(after ?? prefix)) as { key: string; value: string }[]
        const owned = rows.filter(row => row.key.startsWith(nativeKey(prefix)))
        const entries = owned.slice(0, limit).map(row => ({ key: row.key.slice(nativeKey("").length), value: JSON.parse(row.value) }))
        return { entries, ...(owned.length > limit ? { next: entries.at(-1)!.key } : {}) }
      },
    }
    const tx = tag("@test/failed-sources/Transaction")
    const client = Object.assign(() => {}, { transactionService: tx,
      unsafe: (sql: string, params: readonly unknown[] = []) => ({ withoutTransform: Effect.sync(() => {
        const statement = db.prepare(sql)
        if (/^(INSERT|UPDATE)/.test(sql)) { statement.run(...params as []); return [] }
        return statement.all(...params as [])
      }) }),
    })
    const database = { db: { $client: client, transaction: <A>(callback: () => Effect.Effect<A, unknown>) => Effect.promise(async () => {
      db.exec("BEGIN IMMEDIATE")
      try {
        const result = await Effect.runPromise(callback().pipe(Effect.provideService(tx, {}), Effect.provide(graph)))
        db.exec("COMMIT"); return result
      } catch (error) { db.exec("ROLLBACK"); throw error }
    }) } }
    const location = Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: "project", directory, canonical: directory } })
    const emptyQueue = { list: () => Effect.succeed([]) }
    const noNativeReplay = () => Effect.die("Native send/read must not run during archive-only recovery")
    const session = { get: noNativeReplay, create: noNativeReplay, environment: noNativeReplay,
      inbox: noNativeReplay, prompt: noNativeReplay, synthetic: noNativeReplay }
    const graph = Context.make(tag("@opencode/storage/Database"), database).pipe(Context.add(tag("@opencode/Location"), location),
      Context.add(tag("@opencode/Form"), emptyQueue), Context.add(tag("@opencode/Permission"), emptyQueue), Context.add(tag("@opencode/Shell"), emptyQueue),
      Context.add(tag("@opencode/Session"), session))
    const ctx = { location, storage: { get: (key: string) => Effect.sync(() => get(key)),
      set: (key: string, value: unknown) => Effect.sync(() => put(key, value)),
      scan: (options: Parameters<MissionStorage["scan"]>[0]) => Effect.promise(() => storage.scan(options)) } } as unknown as Parameters<typeof acquireNativeRecurrenceAuthorityProvider>[0]
    const scope = { namespace: "9f6f590e-271d-477f-8c02-7a6a119d63b9", daemonStorageID: nativeDatabaseStorageID(path.join(directory, "offline.sqlite")),
      projectID: "project", projectCanonical: directory, scheduleID: "schedule", profileID: "profile", executionHost: "host" }
    put(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, scope.namespace)
    const owner = { namespace: scope.namespace, daemonStorageID: scope.daemonStorageID, assertCurrent: current }
    const provider = await Effect.runPromise(acquireNativeRecurrenceAuthorityProvider(ctx, scope, owner)
      .pipe(Effect.provide(graph), Effect.provideService(Scope.Scope, lifetime)))
    const root = { mode: "git" as const, directory, checkout: physical(directory), family }
    const config = { template: "custom" as const, consigne: "  Review watched replies\n", clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "host",
      roots: [root], profiles: { coordinator: { agent: "build", model: { providerID: "fixture", id: "model" } },
        roles: { specialist: { agent: "build", model: { providerID: "fixture", id: "model" } } } }, taskMode: "native" as const,
      watchedConversationIDs: ["ses_watched"], publication: { policy: "disabled" as const, conversationIDs: [] } }
    const calendar = new NativeMissionRecurrenceStore(storage, scope.projectID, directory)
    let created = await calendar.create(scope.scheduleID, config, 1, current)
    created = await calendar.setState(scope.scheduleID, created.revision, "running", current)
    const oldCursor = { conversationID: "ses_watched", messageID: "msg_old", locationDigest: recurrenceSourceLocationDigest({ directory }) }
    // Bootstrap a known historical calendar result through its real codec, not a
    // fabricated new cursor or this failure's read acknowledgement.
    const previous = await calendar.reserve(scope.scheduleID, created.revision,
      { kind: "manual", requestID: "run_previous", expectedRevision: created.revision, at: 2 }, 2, current)
    const previousMissionID = `msn_${stableToken(`${scope.projectID}\0${previous.pending!.passage.id}`, 24)}`
    const previousConversationID = `ses_${stableToken(`${previousMissionID}\0coordinator`, 26)}`
    await calendar.recordAdmission(scope.scheduleID, { kind: "accepted", passageID: previous.pending!.passage.id,
      messageID: previous.pending!.passage.messageID, missionID: previousMissionID, conversationID: previousConversationID }, 2, current)
    created = await calendar.finish(scope.scheduleID, { passageID: previous.pending!.passage.id, messageID: previous.pending!.passage.messageID,
      missionID: previousMissionID, conversationID: previousConversationID, outcome: "completed", artifactMessageIDs: [], cursors: [oldCursor] }, 3, current)
    const pending = await calendar.reserve(scope.scheduleID, created.revision,
      { kind: "manual", requestID: "run_original", expectedRevision: created.revision, at: 10 }, 10, current)
    const keys = generateKeyPairSync("ed25519"), signerDigest = authoritySignerDigest(keys.publicKey)
    const authorityID = `rec_${signerDigest.slice(0, 40)}`, keyID = `key_${signerDigest.slice(0, 40)}`
    put(`${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/profile`, keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"))
    const body = { ...scope, version: 1 as const, policy: RECURRENCE_AUTHORITY_POLICY, authorityID, keyID,
      signerDigest, provisioningGeneration: signerDigest, roots: [root], action: "authorize" as const,
      requestID: recurrenceHumanRequestID(scope.scheduleID, 1, "authorize"), epoch: 1, expectedRevision: null,
      scheduleRevision: pending.scheduleRevision, config: pending.config, configDigest: authorityDigest(pending.config),
      profileSource: { profileID: "profile", executionHost: "host", configYamlPath: path.join(directory, "config.yaml") },
      budgets: { effects: 4, nativeCalls: 0, inboxMessages: 2, publications: 0 } }
    const parent = { body, signature: sign(null, recurrenceStandingSigningBytes(body), keys.privateKey).toString("base64") }
    const grant = deriveRecurrenceChild(parent, pending, 2)
    const read: RecurrenceEffect = { kind: "inbox-read", conversationID: "ses_watched", messageIDs: [], read: {
      directory, afterMessageID: "msg_old", limit: 2, contextLimit: recurrenceSourceContextLimit(pending.config, []) } }
    const sourceMessages = [{ id: "msg_new", type: "assistant", text: "  Native source reply\n" + "x".repeat(4096),
      completedAt: 5, nativeDigest: authorityDigest({ id: "msg_new", text: "completed native fixture reply" }) }]
    const operation = (effect: RecurrenceEffect, evidenceID: string, target = grant) => ({ operationID: recurrenceEffectID(target, effect), effect,
      receipt: { operationID: recurrenceEffectID(target, effect), outcome: "applied" as const, evidenceID } })
    const readOperation = { ...operation(read, recurrenceReadEvidence(read, sourceMessages)),
      receipt: { ...operation(read, recurrenceReadEvidence(read, sourceMessages)).receipt, sourceMessages } }
    const child: RecurrenceChildRecord = { parent, grant, effects: [readOperation,
      operation({ kind: "create" }, grant.coordinatorSessionID), operation({ kind: "start" }, grant.coordinatorSessionID)] }
    const input = recurrenceInput(child)
    child.effects.push(operation({ kind: "coordinator-message", messageID: grant.messageID, contentDigest: authorityDigest(input.text) }, grant.messageID))
    const originalEffects = structuredClone(child.effects)
    // Seed the corresponding historical authority archive as well. The real
    // native store verifies the permanent sequence/digest chain on every read.
    const previousGrant = deriveRecurrenceChild(parent, previous, 1)
    assert.ok(read.kind === "inbox-read" && read.read)
    const previousRead: RecurrenceEffect = { ...read, read: { ...read.read, afterMessageID: null } }
    const previousMessages = [{ id: "msg_old", type: "user", text: "Previously handled native reply", nativeDigest: authorityDigest("previous native input") }]
    const previousReadOperation = operation(previousRead, recurrenceReadEvidence(previousRead, previousMessages), previousGrant)
    const previousChild: RecurrenceChildRecord = { parent, grant: previousGrant, effects: [{ ...previousReadOperation,
      receipt: { ...previousReadOperation.receipt, sourceMessages: previousMessages } },
      operation({ kind: "create" }, previousGrant.coordinatorSessionID, previousGrant), operation({ kind: "start" }, previousGrant.coordinatorSessionID, previousGrant)] }
    const previousInput = recurrenceInput(previousChild)
    previousChild.effects.push(operation({ kind: "coordinator-message", messageID: previousGrant.messageID,
      contentDigest: authorityDigest(previousInput.text) }, previousGrant.messageID, previousGrant))
    const previousArchive = { version: 1 as const, child: previousChild, previousArchiveDigest: null,
      settlement: { grantID: previousGrant.grantID, evidenceID: "evt_previous_completed", outcome: "completed" as const,
        effects: previousChild.effects.map(item => item.receipt!), nativeIdle: true as const, controlsSettled: true as const,
        notificationsSettled: true as const, derivedCallsEnded: true as const } }
    const lastArchiveDigest = recurrenceAuthorityDigest(previousArchive)
    put(`${provider.store.parentKey}/passages/${previousGrant.passage.id}`, previousArchive)
    put(`${provider.store.parentKey}/settled/1`, { passageID: previousGrant.passage.id, digest: lastArchiveDigest })
    const ledger = { version: 1, scope, revision: 0, parent, child, settledSequence: 1, lastArchiveDigest }
    put(provider.store.key, ledger); put(`${provider.store.parentKey}/parents/1`, parent)
    const admitted = await calendar.recordAdmission(scope.scheduleID, { kind: "accepted", passageID: grant.passage.id,
      messageID: grant.messageID, missionID: grant.missionID, conversationID: grant.coordinatorSessionID }, 10, current)
    const journal = recurrencePassage(storage, admitted, current).journal, operationID = controlOperationID(grant.missionID, grant.passage.id)
    const recurrence = { grantID: grant.grantID, passageID: grant.passage.id, messageID: grant.messageID, coordinatorSessionID: grant.coordinatorSessionID }
    await journal.append({ version: 1, id: "evt_created", type: "mission.created", projectID: scope.projectID, missionID: grant.missionID,
      projectCanonical: directory, objective: pending.config.consigne, template: "custom", requestID: grant.passage.id, prepared: true, createdAt: 10,
      coordinator: { sessionID: grant.coordinatorSessionID, title: "Coordinator", location: { directory } } })
    await journal.append({ version: 1, id: operationID, type: "mission.control-requested", projectID: scope.projectID, missionID: grant.missionID,
      requestID: grant.passage.id, expectedRevision: 1, action: "start", recurrence, createdAt: 10, targets: [{ sessionID: grant.coordinatorSessionID, location: { directory } }] })
    const payload = { text: input.text, description: input.description, metadata: input.metadata }
    await journal.append({ version: 1, id: controlReceiptID(operationID, grant.coordinatorSessionID), type: "mission.control-applied",
      projectID: scope.projectID, missionID: grant.missionID, operationID, sessionID: grant.coordinatorSessionID, createdAt: 10,
      nativeAcknowledgement: { missionID: grant.missionID, operationID, sessionID: grant.coordinatorSessionID, action: "start", disposition: "start-admitted",
        admission: { id: input.id, sessionID: input.sessionID, type: "synthetic", delivery: "queue", payload, time: { created: 10 } } } })
    for (const [id, metadata] of [[grant.coordinatorSessionID, { "codenomad.mission": { version: 1, missionID: grant.missionID, kind: "coordinator", role: "coordinator" } }],
      ["ses_watched", {}]] as const) db.prepare("INSERT INTO session_v2 VALUES(?,NULL,?,?,NULL,?,NULL)").run(id, scope.projectID, directory, JSON.stringify(metadata))
    const error = { type: failure.type, message: "Native provider failed at https://private.example/?token=private-token",
      ...(failure.status === undefined ? {} : { status: failure.status }) }
    const model = { providerID: "fixture", id: "model" }, assistantMessageID = "msg_native_assistant"
    const events: { type: string; data: Record<string, unknown> }[] = [
      { type: "session.created.1", data: { sessionID: input.sessionID } },
      { type: "session.inbox.enqueued.1", data: { sessionID: input.sessionID, inboxID: input.id, item: { type: "synthetic", payload } } },
      { type: "session.execution.started.1", data: { sessionID: input.sessionID } },
      { type: "session.inbox.delivered.1", data: { sessionID: input.sessionID, inboxID: input.id } },
    ]
    if (failure.modelStep) {
      const start = (started: number) => ({ type: "session.step.started.1", data: { sessionID: input.sessionID,
        assistantMessageID, agent: "build", model, started } })
      events.push(start(11))
      if (failure.retry) events.push({ type: "session.retry.scheduled.1", data: { sessionID: input.sessionID,
        assistantMessageID, attempt: 2, at: 12, error } }, start(13))
      events.push({ type: "session.step.streamed.1", data: { sessionID: input.sessionID, assistantMessageID } },
        { type: "session.step.failed.1", data: { sessionID: input.sessionID, assistantMessageID, error, files: [] } })
      db.prepare("INSERT INTO session_message VALUES(?,?,4,'assistant',?)").run(assistantMessageID, input.sessionID, JSON.stringify({
        agent: "build", model, content: [], error, finish: "error", snapshot: { files: [] },
        time: { created: failure.retry ? 13 : 11, streamed: 14, completed: 15 } }))
    }
    events.push({ type: "session.execution.failed.1", data: { sessionID: input.sessionID, error } })
    const terminalSeq = events.length - 1
    db.prepare("INSERT INTO event_sequence VALUES(?,?,NULL)").run(input.sessionID, terminalSeq)
    events.forEach((event, seq) => db.prepare("INSERT INTO event VALUES(?,?,?,?,?)").run(`evt_native_${seq}`, input.sessionID, seq, event.type, JSON.stringify(event.data)))
    db.prepare("INSERT INTO session_message VALUES(?,?,3,'synthetic',?)").run(input.id, input.sessionID, JSON.stringify(payload))
    db.prepare("INSERT INTO session_message VALUES(?, ?, ?, 'idle', ?)").run(`msg_native_${terminalSeq}`, input.sessionID, terminalSeq,
      JSON.stringify({ outcome: "failed", time: { created: 16 } }))
    const observe = (candidate: RecurrenceChildRecord = child) => provider.transact(current,
      () => observeNativeRecurrenceTerminalSettlement(provider, storage, candidate, new AbortController().signal))
    const unknownRead = structuredClone(child); unknownRead.effects[0].receipt = null
    await assert.rejects(observe(unknownRead), /observation-unavailable/)
    const changedRead = structuredClone(child); changedRead.effects[0].receipt!.sourceMessages![0].text += " altered"
    await assert.rejects(observe(changedRead), /observation-unavailable/)
    const oldRead = structuredClone(child); oldRead.effects[0].effect = { kind: "inbox-read", conversationID: "ses_watched", messageIDs: ["msg_new"] }
    await assert.rejects(observe(oldRead), /observation-unavailable/)
    const publication = structuredClone(child); publication.effects.push(operation({ kind: "publish", conversationID: "ses_watched",
      messageID: "msg_unpermitted", contentDigest: authorityDigest("publication") }, "msg_unpermitted"))
    await assert.rejects(observe(publication), /observation-unavailable/)
    const wrongDigest = structuredClone(child), messageEffect = wrongDigest.effects.at(-1)!.effect
    assert.ok(messageEffect.kind === "coordinator-message")
    messageEffect.contentDigest = authorityDigest(pending.config.consigne)
    await assert.rejects(observe(wrongDigest), /binding-mismatch/, "charged input digest must include exact shared source context")
    db.prepare("UPDATE session_message SET data=? WHERE id=?").run(JSON.stringify({ ...payload, text: pending.config.consigne }), input.id)
    await assert.rejects(observe(), /observation-unavailable/, "hardcoded consigne cannot replace the exact source-bearing input")
    db.prepare("UPDATE session_message SET data=? WHERE id=?").run(JSON.stringify(payload), input.id)
    db.prepare("UPDATE session_v2 SET directory=? WHERE id='ses_watched'").run(`${directory}-moved`)
    await assert.rejects(observe(), /binding-mismatch/)
    db.prepare("UPDATE session_v2 SET directory=? WHERE id='ses_watched'").run(directory)
    db.prepare("UPDATE event SET type='session.tool.called.1' WHERE aggregate_id=? AND seq=?").run(input.sessionID, terminalSeq)
    await assert.rejects(observe(), /observation-unavailable/, "a running/partial tool is not a provider execution terminal")
    db.prepare("UPDATE event SET type='session.execution.failed.1' WHERE aggregate_id=? AND seq=?").run(input.sessionID, terminalSeq)
    const withRunningTool = [...events.slice(0, -1), { type: "session.tool.called.1", data: { sessionID: input.sessionID,
      assistantMessageID, id: "call_running", input: { command: "work" }, executed: false } }, events.at(-1)!]
    db.prepare("DELETE FROM event WHERE aggregate_id=?").run(input.sessionID)
    withRunningTool.forEach((event, seq) => db.prepare("INSERT INTO event VALUES(?,?,?,?,?)")
      .run(`evt_native_${seq}`, input.sessionID, seq, event.type, JSON.stringify(event.data)))
    db.prepare("UPDATE event_sequence SET seq=? WHERE aggregate_id=?").run(withRunningTool.length - 1, input.sessionID)
    await assert.rejects(observe(), /observation-unavailable/, "positive execution failure cannot retire a partial native tool")
    db.prepare("DELETE FROM event WHERE aggregate_id=?").run(input.sessionID)
    events.forEach((event, seq) => db.prepare("INSERT INTO event VALUES(?,?,?,?,?)")
      .run(`evt_native_${seq}`, input.sessionID, seq, event.type, JSON.stringify(event.data)))
    db.prepare("UPDATE event_sequence SET seq=? WHERE aggregate_id=?").run(terminalSeq, input.sessionID)
    assert.equal((await journal.snapshot()).missions[0].status, "active", "refusals invent no result")
    const signer: NativeStandingSigner = { readSigners: async () => [{ ...scope, authorityID, keyID, roots: [root],
      publicKey: keys.publicKey, provisioningGeneration: signerDigest, policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" }],
      assertSignerCurrent: current, captureHumanIntent: () => { throw Error("No new human intent") },
      assertProtectedCurrent: request => { assert.deepEqual(request.parent, parent); assert.deepEqual(request.ledger, get(provider.store.key)); return true } }
    const authority = new RecurrenceAuthority(provider.store, nativeRecurrenceAdapter({ provider, signer, owner, settlementStorage: storage }))
    const archive = await provider.transact(current, () => authority.settle(grant.grantID, 0, new AbortController().signal))
    assert.equal(archive.settlement.outcome, "failed")
    assert.deepEqual(archive.child.effects, originalEffects, "all original read/startup operations remain charged and unchanged")
    assert.equal(recurrenceSources(archive.child)[0].messages[0].text, sourceMessages[0].text)
    assert.deepEqual(recurrenceSourceCursors(archive), [], "positive reads are not processed source work")
    const recordedFailure = (await journal.events()).events.find(event => event.type === "mission.finished")
    assert.ok(recordedFailure?.type === "mission.finished")
    assert.equal(recordedFailure.summary, error.type, "private native URLs/tokens are not copied into the Mission result")
    assert.equal(recordedFailure.nativeFailure?.inputDigest, authorityDigest(input.text))
    assert.notEqual(recordedFailure.nativeFailure?.inputDigest, authorityDigest(pending.config.consigne))
    assert.equal((await provider.read())!.child, null)
    assert.deepEqual((await calendar.read(scope.scheduleID))!.cursors, [oldCursor])
    const runner = new MissionRecurrenceRunner(calendar, { authorize: async () => { throw Error("Archive-only pending must not dispatch") },
      admit: async () => { throw Error("No native replay") } }, () => 20)
    assert.equal(await runner.tick(scope.scheduleID), "pending")
    // The real due callback must also accept watched-source archives after a
    // crash between authority and calendar. Pause prevents any fresh dispatch.
    const coldPending = (await calendar.read(scope.scheduleID))!
    await calendar.setState(scope.scheduleID, coldPending.revision, "paused", current)
    const placement = { projectID: scope.projectID, projectCanonical: directory, directory, scheduleID: scope.scheduleID,
      profileID: scope.profileID, executionHost: scope.executionHost, epoch: 1 }
    const due = nativeRecurrenceDue(ctx, placement, observeNativeRecurrenceTerminalSettlement, () => 20)
    assert.equal(await due(graph, current, new AbortController().signal), "inactive")
    const finished = (await calendar.read(scope.scheduleID))!
    assert.equal(finished.pending, null)
    assert.deepEqual(finished.cursors, [oldCursor])
    assert.deepEqual((await provider.store.readPassage(grant.passage.id))!.child.effects, originalEffects)
    const freshProvider = await Effect.runPromise(acquireNativeRecurrenceAuthorityProvider(ctx, scope, owner)
      .pipe(Effect.provide(graph), Effect.provideService(Scope.Scope, lifetime)))
    const freshAuthority = new RecurrenceAuthority(freshProvider.store, nativeRecurrenceAdapter({ provider: freshProvider, signer, owner, settlementStorage: storage }))
    await assert.rejects(freshProvider.transact(current, () => freshAuthority.settle(grant.grantID, 1, new AbortController().signal)), /binding-mismatch/)
    const next = await calendar.reserve(scope.scheduleID, finished.revision,
      { kind: "manual", requestID: "run_next_day", expectedRevision: finished.revision, at: 86_410 }, 86_410, current)
    assert.notEqual(next.pending!.passage.id, grant.passage.id)
    assert.deepEqual(next.cursors, [oldCursor], "next passage retains the old cursor so it can read unprocessed replies again")
  } finally {
    await Effect.runPromise(Scope.close(lifetime, Exit.void))
    db.close(); await rm(temporary, { recursive: true, force: true })
  }
})
}
