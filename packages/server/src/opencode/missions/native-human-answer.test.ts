import assert from "node:assert/strict"
import test from "node:test"
import http from "node:http"
import { generateKeyPairSync, sign } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import Fastify from "fastify"
import pino from "pino"
import { Context, Effect, DateTime } from "effect"
import { AuthManager } from "../../auth/manager"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { authorityDigest, authoritySignerDigest, canonicalAuthority } from "../../missions/authority-protocol"
import { stableToken } from "../../missions/journal"
import { MissionJournal, type MissionStorage } from "../../missions/journal"
import { MissionControl } from "../../missions/control"
import type { MissionJsonValue } from "../../missions/model"
import { deriveRecurrenceChild, recurrenceHumanRequestID, recurrenceStandingSigningBytes, RECURRENCE_AUTHORITY_POLICY } from "../../missions/recurrence-authority-contract"
import { recurrenceMessageID, recurrencePassageID, type RecurrenceDocument } from "../../missions/recurrence-contract"
import { NativeRecurrenceAuthorityStore } from "../../missions/recurrence-authority-store"
import { humanAnswerIdentity, humanAnswerProof, type HumanAnswerProof, type HumanAnswerReservation } from "../../missions/human-answer"
import { createAutomationBridgeRegistration, publishAutomationBridge } from "../automation-plugin"
import { registerAutomationPluginRoute } from "../../server/routes/automation-plugin"
import { registerInstanceProxyRoutes } from "../../server/http-server"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { NativeDecisionEvidenceRequest } from "../../missions/native-human-evidence"
import { readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import { physical } from "../../missions/host-authority/private-files"
import { nativeDatabaseStorageID } from "./native-database-identity"
import { acquireNativeHumanAnswers } from "./native-human-answer"
import { admitNativeRecurrencePassage } from "./native-recurrence-admission"
import type { NativeRecurrenceAuthorityProvider } from "./native-authority-provider"
import type { NativeStandingSigner } from "./native-recurrence-adapter"
import type { MissionNativeService } from "./native-service-adapter"

const encode = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(options: { watched?: boolean; nested?: boolean } = {}) {
  const temporary = await mkdtemp(path.join(process.env.TEMP ?? process.cwd(), "human-answer-offline-"))
  const oldLocal = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = temporary
  execFileSync("git", ["init", "-q", temporary])
  if (options.nested) await mkdir(path.join(temporary, "packages", "server"), { recursive: true })
  const directory = realpathSync(options.nested ? path.join(temporary, "packages", "server") : temporary)
  const checkout = realpathSync(temporary), file = path.join(directory, "offline.sqlite")
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,metadata TEXT,title TEXT,agent TEXT,model TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,data TEXT);
    CREATE TABLE event(id TEXT,seq INTEGER,type TEXT,aggregate_id TEXT,data TEXT);`)
  const put = (key: string, value: unknown) => db.prepare("INSERT OR REPLACE INTO kv VALUES(?,?,1,1)").run(encode(key), JSON.stringify(value))
  const get = (key: string) => { const row = db.prepare("SELECT value FROM kv WHERE key=?").get(encode(key)) as { value: string } | undefined; return row && JSON.parse(row.value) }
  const family = await readFamilyAuthorityIdentity(directory)
  const root = { mode: "git" as const, directory, checkout: physical(checkout), family }
  const location = { directory, project: { id: "project", canonical: checkout, directory: checkout } }
  const keys = generateKeyPairSync("ed25519"), signerDigest = authoritySignerDigest(keys.publicKey)
  const scope = { namespace: "9f6f590e-271d-477f-8c02-7a6a119d63b9", projectID: "project", projectCanonical: checkout,
    profileID: "profile", executionHost: "local", scheduleID: "watch", daemonStorageID: nativeDatabaseStorageID(file) }
  const config = { template: "custom" as const, consigne: "Choose a boundary", clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "local",
    roots: [root], profiles: { coordinator: { agent: "worker", model: { providerID: "provider", id: "model" } },
      roles: { specialist: { agent: "worker", model: { providerID: "provider", id: "model" } } } },
    taskMode: "native" as const, watchedConversationIDs: options.watched ? ["ses_watched"] : [], publication: { policy: "disabled" as const, conversationIDs: [] } }
  const parentBody = { ...scope, authorityID: `rec_${signerDigest.slice(0, 40)}`, keyID: `key_${signerDigest.slice(0, 40)}`,
    roots: [root], version: 1 as const, policy: RECURRENCE_AUTHORITY_POLICY, action: "authorize" as const,
    scheduleRevision: 0, epoch: 1, expectedRevision: null, requestID: recurrenceHumanRequestID("watch", 1, "authorize"),
    provisioningGeneration: signerDigest, signerDigest, config, configDigest: authorityDigest(config),
    profileSource: { profileID: "profile", executionHost: "local", configYamlPath: path.join(directory, "config.yaml") },
    budgets: { effects: 8, nativeCalls: 2, inboxMessages: options.watched ? 1 : 0, publications: 0 } }
  const parent = { body: parentBody, signature: sign(null, recurrenceStandingSigningBytes(parentBody), keys.privateKey).toString("base64") }
  const due = { kind: "manual" as const, requestID: "manual", expectedRevision: 0, at: 1 }
  const passageID = recurrencePassageID(stableToken(`project\0${checkout}`, 24), "watch", 0, due)
  const document: RecurrenceDocument = { version: 1, projectID: "project", projectCanonical: checkout, id: "watch",
    revision: 1, scheduleRevision: 0, createdAt: 1, state: "running", config,
    lastDaily: null, settledCount: 0, cursors: [], history: [], pending: { passage: { id: passageID,
      messageID: recurrenceMessageID(passageID), scheduleRevision: 0, createdAt: 1, due }, admission: null } }
  const grant = deriveRecurrenceChild(parent, document, 1)
  const storage: MissionStorage = {
    get: async key => get(key), set: async (key, value, current) => { current?.(); put(key, value) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const rows = db.prepare("SELECT key,value FROM kv WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?")
        .all(encode(prefix).length, encode(prefix), encode(after ?? prefix), limit + 1) as { key: string; value: string }[]
      const entries = rows.slice(0, limit).map(row => ({ key: row.key.slice(encode("").length), value: JSON.parse(row.value) }))
      return { entries, ...(rows.length > limit ? { next: entries.at(-1)!.key } : {}) }
    },
  }
  const store = new NativeRecurrenceAuthorityStore(storage, scope)
  put(store.key, { version: 1, scope, revision: 0, parent, child: null, settledSequence: 0, lastArchiveDigest: null })
  put(`${store.parentKey}/parents/1`, parent)
  put(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, scope.namespace)
  put(`${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/profile`, keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"))
  const sourceKey = "fixture-source"
  put(sourceKey, document)
  let ownerLive = true, created = 0, admitted = 0
  const owner = { namespace: scope.namespace, daemonStorageID: scope.daemonStorageID,
    assertCurrent: (): true => { assert(ownerLive); assert.equal(get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`), scope.namespace); return true } }
  const provider = { store, sourceKey, location: { directory, projectID: scope.projectID, projectCanonical: checkout },
    daemonStorageID: scope.daemonStorageID, readCurrent: get, read: () => store.read(), assertCurrent: owner.assertCurrent,
    assertSourcePlacement: (sessionID: string, expected: { directory: string }) => {
      const row = db.prepare("SELECT directory FROM session_v2 WHERE id=?").get(sessionID) as { directory: string }
      assert.equal(row.directory, expected.directory); assert.equal(row.directory, directory); return true as const
    },
    transact: async (current: () => true, operation: () => Promise<unknown>) => {
      current(); db.exec("BEGIN IMMEDIATE")
      try { const result = await operation(); current(); db.exec("COMMIT"); return result }
      catch (error) { db.exec("ROLLBACK"); throw error }
    } } as unknown as NativeRecurrenceAuthorityProvider
  const signer: NativeStandingSigner = {
    readSigners: async () => [{ ...parentBody, publicKey: keys.publicKey, policy: "codenomad.missions.authority/signed-v1", qualification: "qualified" }],
    assertSignerCurrent: snapshot => { owner.assertCurrent(); assert.equal(snapshot.signerDigest, signerDigest); return true },
    assertProtectedCurrent: request => { owner.assertCurrent(); assert.deepEqual(request.parent, parent);
      assert.deepEqual(request.ledger, get(store.key)); return true },
    captureHumanIntent: () => { throw new Error("No human Play during passage execution") },
  }
  const nativeGet = async ({ sessionID }: { sessionID: string }) => {
    const row = db.prepare("SELECT * FROM session_v2 WHERE id=?").get(sessionID) as { id: string; parent_id: string | null; directory: string; metadata: string; title: string; agent: string; model: string }
    if (!row) throw new Error("Session not found")
    return { id: row.id, projectID: "project", location: { directory: row.directory }, metadata: JSON.parse(row.metadata),
      title: row.title, agent: row.agent, model: JSON.parse(row.model), ...(row.parent_id ? { parentID: row.parent_id } : {}) }
  }
  await writeFile(parentBody.profileSource.configYamlPath, "server:\n  environmentVariables:\n    MARKER: offline\n")
  if (options.watched) db.prepare("INSERT INTO session_v2 VALUES(?,NULL,?,?,NULL,'{}','Source','worker',?)")
    .run("ses_watched", "project", directory, JSON.stringify(config.profiles.coordinator.model))
  const service = { location, assertCurrent: owner.assertCurrent, get: nativeGet,
    sourceMessages: async (_input: unknown, _options: unknown, before: () => true, current: () => true) => {
      before(); current()
      return [{ id: "msg_source", type: "assistant", text: "A complete followed reply", completedAt: 1,
        nativeDigest: authorityDigest("A complete followed reply") }]
    },
    create: async (input: { id: string; title: string; agent: string; model: unknown; metadata: unknown }, _options: unknown, current: () => true) => {
      current(); created++
      db.prepare("INSERT INTO session_v2 VALUES(?,NULL,?,?,NULL,?,?,?,?)").run(input.id, "project", directory,
        JSON.stringify(input.metadata), input.title, input.agent, JSON.stringify(input.model))
      return nativeGet({ sessionID: input.id })
    }, environment: async (_input: unknown, _options: unknown, current: () => true) => { current() },
    admit: async (command: { input: { sessionID: string; id: string; text: string; description: string; delivery: "queue"; metadata: unknown } },
      _options: unknown, current: () => true) => {
      current(); admitted++
      const input = command.input, payload = { text: input.text, description: input.description, metadata: input.metadata }
      db.prepare("INSERT INTO session_message VALUES(?,?,?,?)").run(input.id, input.sessionID, "synthetic", JSON.stringify(payload))
      db.prepare("INSERT INTO event VALUES(?,0,'session.inbox.enqueued.1',?,?)").run("event_start", input.sessionID,
        JSON.stringify({ sessionID: input.sessionID, inboxID: input.id, item: { type: "synthetic", payload } }))
      return { id: input.id, sessionID: input.sessionID, type: "synthetic", delivery: input.delivery, payload,
        time: { created: DateTime.makeUnsafe(1) } }
    } } as unknown as MissionNativeService
  const passage = await admitNativeRecurrencePassage({ document, provider, storage, signer, owner, native: service,
    profile: parentBody.profileSource, signal: new AbortController().signal, settlementSignal: new AbortController().signal,
    beforeEffect: async () => owner.assertCurrent })
  assert.equal(passage.conversationID, grant.coordinatorSessionID); assert.equal(created, 1); assert.equal(admitted, 1)
  const rootCreated = await nativeGet({ sessionID: grant.coordinatorSessionID })
  assert.deepEqual(rootCreated.metadata, { "codenomad.mission": { version: 1, missionID: grant.missionID, kind: "coordinator", role: "coordinator" } })
  for (const id of ["ses_child", "ses_sibling"]) db.prepare("INSERT INTO session_v2 VALUES(?,?,?, ?,NULL,'{}','Child','worker',?)")
    .run(id, grant.coordinatorSessionID, "project", directory, JSON.stringify(config.profiles.roles.specialist.model))
  const input = { questions: [{ question: "Choose the seam?", header: "Seam", options: [{ label: "Module", description: "Own the boundary" }] }] }
  const form = { id: "frm_actual", sessionID: "ses_child", title: "Questions", metadata: { kind: "question", tool: { messageID: "msg_question", id: "call_question" } },
    fields: [{ key: "q0", type: "string", title: "Seam", description: "Choose the seam?", custom: true,
      options: [{ value: "Module", label: "Module", description: "Own the boundary" }] }] }
  let state: { status: string; answer?: unknown } = { status: "pending" }, replies = 0, complete = true, lostNativeReturn = false, cacheExpired = false
  let delayReply = false, loseRpcAck = false
  const replyStarted = deferred(), replyRelease = deferred(), rpcFinished = deferred(), observerClosed = deferred()
  const part = { type: "tool", name: "question", id: "call_question", executed: false, state: { status: "running", input } }
  const message = () => db.prepare("INSERT OR REPLACE INTO session_message VALUES(?,?,?,?)").run("msg_question", "ses_child", "assistant", JSON.stringify({ content: [part] }))
  message()
  db.prepare("INSERT INTO session_message VALUES(?,?,?,?)").run("msg_delegate", grant.coordinatorSessionID, "assistant", JSON.stringify({
    content: [{ type: "tool", name: "subagent", id: "call_delegate", executed: false, state: { status: "running", input: {}, metadata: { sessionID: "ses_child" } } }] }))
  db.prepare("INSERT INTO event VALUES(?,?,?, ?,?)").run("event_called", 1, "session.tool.called.1", "ses_child",
    JSON.stringify({ sessionID: "ses_child", assistantMessageID: "msg_question", id: "call_question", executed: false, input }))
  const finish = () => {
    const answer = state.answer as { q0: string }
    const result = { answers: [[answer.q0]] }, content = [{ type: "text", text: "Original native answer content" }]
    Object.assign(part.state, { status: "completed", metadata: result, content }); message()
    db.prepare("INSERT INTO event VALUES(?,?,?, ?,?)").run("event_success", 2, "session.tool.success.2", "ses_child",
      JSON.stringify({ sessionID: "ses_child", assistantMessageID: "msg_question", id: "call_question", executed: false, metadata: result, content }))
  }
  const forms = { get: () => Effect.sync(() => { if (cacheExpired) throw new Error("Form.NotFoundError"); return form }),
    state: () => Effect.sync(() => { if (cacheExpired) throw new Error("Form.NotFoundError"); return state }),
    reply: (value: { id: string; answer: unknown }) => Effect.gen(function* () {
      if (delayReply) { replyStarted.resolve(); yield* Effect.promise(() => replyRelease.promise) }
      assert.equal(value.id, form.id); assert.equal(state.status, "pending"); replies++
      state = { status: "answered", answer: structuredClone(value.answer) }; if (complete) finish()
      if (lostNativeReturn) throw new Error("Unknown native return")
    }) }
  const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
  const locationTag = Context.Service<never, unknown>("@opencode/Location"), formTag = Context.Service<never, unknown>("@opencode/Form")
  const client = Object.assign(() => {}, { unsafe: (sql: string, args: readonly unknown[]) => ({ withoutTransform: Effect.sync(() => db.prepare(sql).all(...args as [])) }) })
  const nativeDb = { db: { $client: client, transaction: (callback: () => Effect.Effect<unknown>) => Effect.promise(async () => {
    db.exec("BEGIN IMMEDIATE")
    try { const result = await Effect.runPromise(Effect.provide(callback(), graph)); db.exec("COMMIT"); return result }
    catch (error) { db.exec("ROLLBACK"); throw error }
  }) } }
  const graph = Context.make(databaseTag, nativeDb).pipe(Context.add(locationTag, location), Context.add(formTag, forms))
  const auth = new AuthManager({ configPath: path.join(directory, "auth-config.yaml"), username: "human", generateToken: true }, pino({ level: "silent" }) as never)
  const cookie = auth.createSession("human")
  const sessionClient = { get: nativeGet }
  let owned = true
  const connection = { endpoint: { url: "http://127.0.0.1:1" }, client: { session: sessionClient }, assertCurrent: () => { if (!owned) throw new Error("Connection retired") } }
  const workspace = { id: "workspace" }
  const manager = { get: () => workspace, getSharedServiceConnection: async () => connection,
    ownsLocation: async () => owned, getServiceWslDistro: () => undefined }
  const settings = { getProfileScope: () => ({ key: "profile" }) }
  const app = Fastify()
  const registration = createAutomationBridgeRegistration("http://127.0.0.1:1")
  registerAutomationPluginRoute(app, { authManager: auth, bridgeToken: registration.token,
    workspaceManager: manager, settings, nativeParent: {}, developerCdp: {} } as never)
  const native = await Effect.runPromise(Effect.provide(acquireNativeHumanAnswers({ location } as never), graph))
  let ordinaryReplies = 0, settleOrdinary = false
  Object.assign(connection.client, { rpc: () => ({ ...native, reply: async (input: unknown, options?: { signal?: AbortSignal }) => {
    assert.equal(options?.signal, undefined, "dispatched native answer is not cancelled by its HTTP observer")
    try {
      const result = await native.reply(input)
      if (loseRpcAck) throw new Error("Lost RPC ACK")
      return result
    } finally { rpcFinished.resolve() }
  } }) })
  Object.assign(connection, { endpoint: { url: "http://127.0.0.1:1" }, fetch: async (_url: unknown, init?: { body?: string }) => {
    ordinaryReplies++
    if (settleOrdinary) await Effect.runPromise(Effect.provide(forms.reply({ id: form.id, answer: JSON.parse(init!.body!).answer }), graph))
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }, profile: async () => "modern", invalidate: () => {} })
  Object.assign(workspace, { path: directory })
  Object.assign(manager, { getSharedServiceEndpoint: async () => connection.endpoint, getSharedServiceClient: async () => connection.client,
    getServiceDirectory: () => directory, getInstanceAuthorizationHeader: () => "Basic fixture",
    getServiceDirectoryForPath: async (_: string, requested: string) => requested === directory ? directory : undefined,
    getWorktreeIdentityForPath: async (_: string, requested: string) => requested === directory ? "fixture-checkout" : undefined,
    ownsDirectory: async (_: string, requested: string) => requested === directory, ownsPath: async () => false })
  const fence = new WorktreeDeletionFence(80)
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/workspaces/")) reply.raw.once("close", () => observerClosed.resolve())
  })
  registerInstanceProxyRoutes(app, { workspaceManager: manager, worktreeDeletionFence: fence, logger: pino({ level: "silent" }),
    humanAnswers: { auth, manager, settings, bridgeToken: registration.token } } as never)
  await app.listen({ host: "127.0.0.1", port: 0 })
  registration.url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/opencode-plugin/automation`
  const disposeBridge = await publishAutomationBridge(registration)
  const binding = { sessionID: "ses_child", formID: form.id, coordinatorSessionID: grant.coordinatorSessionID,
    scheduleID: "watch", passageID, grantID: grant.grantID, epoch: 1, projectID: "project", projectCanonical: checkout,
    location: { directory }, profileID: "profile", executionHost: "local", workspaceID: "workspace",
    namespace: scope.namespace, daemonStorageID: scope.daemonStorageID }
  const body: HumanAnswerProof = { ...binding, cookieSessionID: cookie.id, username: "human", answer: { q0: "Module" }, issuedAt: Date.now() }
  const submit = () => { body.issuedAt = Date.now(); return native.reply({ body, proof: humanAnswerProof(body, registration.token) }) }
  const receiptKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/human-answers/${stableToken("project", 24)}/${humanAnswerIdentity(binding)}`
  const decision: NativeDecisionEvidenceRequest = { kind: "native-form-answer", contract: { missionID: grant.missionID, taskKey: "decision", generation: 1 },
    nativeCall: { generation: 1, parentSessionID: grant.coordinatorSessionID, parentMessageID: "msg_delegate", toolCallID: "call_delegate" },
    sessionID: "ses_child", formID: form.id, messageID: "msg_question", toolCallID: "call_question", fieldKey: "q0",
    projectID: "project", directory, delegationToolName: "subagent", question: "Choose the seam?", answer: "Module" }
  const requestUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/workspaces/workspace/instance/api/session/ses_child/form/${form.id}/reply`
  return { native, body, binding, grant, parent, form, db, submit, get, receiptKey, cookie, part, finish, decision, sessionClient, fence, store,
    beginHttpAnswer: () => {
      const request = http.request(requestUrl, { method: "POST", agent: false, headers: { "content-type": "application/json",
        cookie: `${auth.getCookieName()}=${cookie.id}`, "x-codenomad-human-answer": "1" } })
      request.on("error", () => {})
      request.end(JSON.stringify({ answer: body.answer }))
      return request
    },
    replyStarted: replyStarted.promise, rpcFinished: rpcFinished.promise, observerClosed: observerClosed.promise,
    delay: () => { delayReply = true }, releaseReply: replyRelease.resolve, loseRpcAck: () => { loseRpcAck = true },
    proxySubmit: (human = true) => app.inject({ method: "POST", url: `/workspaces/workspace/instance/api/session/ses_child/form/${form.id}/reply`,
      headers: { cookie: `${auth.getCookieName()}=${cookie.id}`, ...(human ? { "x-codenomad-human-answer": "1" } : {}) }, payload: { answer: body.answer } }),
    ordinaryReplies: () => ordinaryReplies,
    settleOrdinary: () => { settleOrdinary = true },
    counts: () => ({ replies }), defer: () => { complete = false }, expire: () => { cacheExpired = true },
    loseNativeReturn: () => { lostNativeReturn = true }, disconnect: () => { owned = false },
    closeBackend: async () => { await disposeBridge(); await app.close() },
    dispose: async () => { replyRelease.resolve(); await disposeBridge(); await app.close(); ownerLive = false; db.close(); process.env.LOCALAPPDATA = oldLocal; await rm(temporary, { recursive: true, force: true }) } }
}

test("actual authenticated answer reserves before native reply and retains exact signed evidence after backend/cache expiry", async () => {
  const f = await fixture()
  try {
    assert.equal((await f.submit()).status, "settled")
    const receipt = f.get(f.receiptKey) as HumanAnswerReservation
    assert.equal(receipt.state, "settled"); assert.equal(receipt.principal.kind, "codenomad-human")
    const field = receipt.form.fields[0]
    assert(field.type === "string"); assert.equal(field.options?.[0].description, "Own the boundary")
    assert.equal(JSON.stringify(receipt).includes(f.cookie.id), false)
    const original = structuredClone(receipt)
    await f.closeBackend(); f.expire()
    assert.equal((await f.native.reconcile(f.binding)).status, "settled")
    assert.deepEqual(await f.native.verify(f.decision), original)
    for (const request of [{ ...f.decision, toolCallID: "wrong_question" },
      { ...f.decision, sessionID: "ses_sibling" }, { ...f.decision, nativeCall: { ...f.decision.nativeCall, toolCallID: "wrong_delegate" } }])
      await assert.rejects(f.native.verify(request))
    assert.deepEqual(f.get(f.receiptKey), original)
    assert.deepEqual(f.counts(), { replies: 1 })
  } finally { await f.dispose() }
})

for (const nested of [false, true]) test(`watched passage human evidence validates composed input${nested ? " at a nested Location" : ""}`, async () => {
  const f = await fixture({ watched: true, nested })
  try {
    const row = f.db.prepare("SELECT data FROM session_message WHERE id=?").get(f.grant.messageID) as { data: string }
    const original = JSON.parse(row.data)
    assert.notEqual(original.text, f.parent.body.config.consigne)
    assert(original.text.includes("A complete followed reply"))
    const response = await f.proxySubmit()
    assert.equal(response.statusCode, 200, response.body)
    const receipt = f.get(f.receiptKey) as HumanAnswerReservation
    await f.closeBackend(); f.expire()
    assert.deepEqual(await f.native.verify(f.decision), receipt)
    assert.equal(f.counts().replies, 1)
    // Historical verification must not fall back to the bare consigne either.
    f.db.prepare("UPDATE session_message SET data=? WHERE id=?").run(
      JSON.stringify({ ...original, text: f.parent.body.config.consigne }), f.grant.messageID)
    await assert.rejects(f.native.verify(f.decision), /Original native passage message mismatch/)
    assert.equal(f.counts().replies, 1)
  } finally { await f.dispose() }
})

test("real owned proxy routes dock answers to native fixed RPC; programmatic reply cannot produce human proof", async () => {
  const f = await fixture()
  try {
    assert.equal((await f.proxySubmit(false)).statusCode, 200)
    assert.equal(f.get(f.receiptKey), undefined); assert.equal(f.ordinaryReplies(), 1)
    const response = await f.proxySubmit()
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(f.get(f.receiptKey).state, "settled"); assert.equal(f.ordinaryReplies(), 1)
    assert.equal(f.counts().replies, 1)
    assert.equal((await f.proxySubmit()).statusCode, 200)
    assert.equal(f.counts().replies, 1)
  } finally { await f.dispose() }
})

test("disconnected HTTP observer cannot release the original permit while native Form.reply runs", async () => {
  const f = await fixture()
  try {
    f.delay()
    const request = f.beginHttpAnswer()
    await f.replyStarted
    request.destroy(); await f.observerClosed
    let deleted = false
    await assert.rejects(f.fence.run("fixture-checkout", ["fixture-checkout"], async () => { deleted = true }), /Timed out/)
    assert.equal(deleted, false); assert.equal(f.counts().replies, 0)
    f.releaseReply(); await f.rpcFinished
    await f.fence.run("fixture-checkout", ["fixture-checkout"], async () => { deleted = true })
    assert.equal(deleted, true); assert.equal(f.counts().replies, 1)
    assert.equal(f.get(f.receiptKey).state, "settled")
  } finally { await f.dispose() }
})

test("ordinary programmatic native answer actually settles the Form without any human receipt or retroactive upgrade", async () => {
  const f = await fixture()
  try {
    f.settleOrdinary()
    assert.equal((await f.proxySubmit(false)).statusCode, 200)
    assert.equal(f.counts().replies, 1); assert.equal(f.get(f.receiptKey), undefined)
    await assert.rejects(f.native.verify(f.decision), /receipt unavailable/)
    assert.equal((await f.proxySubmit()).statusCode, 409)
    assert.equal(f.counts().replies, 1); assert.equal(f.get(f.receiptKey), undefined)
  } finally { await f.dispose() }
})

test("lost RPC ACK parks deletion until exact receipt-only reconciliation, with no second answer", async () => {
  const f = await fixture()
  try {
    f.loseRpcAck()
    assert.equal((await f.proxySubmit()).statusCode, 409)
    assert.equal(f.counts().replies, 1); assert.equal(f.get(f.receiptKey).state, "settled")
    await assert.rejects(f.fence.run("fixture-checkout", ["fixture-checkout"], async () => {}), /Timed out/)
    assert.equal((await f.proxySubmit()).statusCode, 200)
    await f.fence.run("fixture-checkout", ["fixture-checkout"], async () => {})
    assert.equal(f.counts().replies, 1)
  } finally { await f.dispose() }
})

test("suspected passage with a missing ledger or wrong original lifecycle message never silently ordinary-forwards", async () => {
  for (const mutation of ["ledger", "lifecycle"] as const) {
    const f = await fixture()
    try {
      if (mutation === "ledger") f.db.prepare("DELETE FROM kv WHERE key=?").run(encode(f.store.key))
      else f.db.prepare("UPDATE session_message SET data=? WHERE id=?")
        .run(JSON.stringify({ text: "Wrong passage", metadata: {} }), f.grant.messageID)
      assert.equal((await f.proxySubmit()).statusCode, 409)
      assert.equal(f.ordinaryReplies(), 0); assert.equal(f.counts().replies, 0)
    } finally { await f.dispose() }
  }
})

test("native receipt preserves verbatim custom text and denies altered signed schema", async () => {
  const f = await fixture()
  try {
    f.body.answer = { q0: "  Own this seam\nexactly.  " }
    assert.equal((await f.submit()).status, "settled")
    const receipt = f.get(f.receiptKey) as HumanAnswerReservation
    assert.deepEqual(receipt.answer, f.body.answer)
    f.decision.answer = f.body.answer.q0
    assert.deepEqual(await f.native.verify(f.decision), receipt)
    receipt.form = { ...receipt.form, title: "Tampered" }
    f.db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify(receipt), encode(f.receiptKey))
    await assert.rejects(f.native.verify(f.decision), /signature mismatch/)
  } finally { await f.dispose() }
})

test("Wayfinder business report consumes the exact stored native receipt, not artifact prose or reply ACK", async () => {
  const f = await fixture()
  try {
    const values = new Map<string, MissionJsonValue>()
    const storage: MissionStorage = { get: async key => values.get(key), set: async (key, value, current) => { current?.(); values.set(key, value) },
      scan: async ({ prefix, after, limit = 100 }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => ({ key, value })) }) }
    const call = f.decision.nativeCall, project = { id: "project", canonical: f.binding.projectCanonical, location: f.binding.location }
    let sequence = 1, guards = 0
    const control = new MissionControl({ storage, project, now: () => sequence++, sessions: {
      get: f.sessionClient.get, create: async () => { throw new Error("No birth") },
      prompt: async () => { throw new Error("No prompt") }, synthetic: async () => { throw new Error("No model wake") } },
      authorizeNativeReport: async () => ({ call, current: () => { guards++; return true } }), humanGate: request => f.native.verify(request) })
    const { mission } = await control.create({ requestID: f.grant.passage.id, objective: "Choose the seam", template: "wayfinder",
      coordinatorSessionID: f.grant.coordinatorSessionID })
    assert.equal(mission.id, f.grant.missionID)
    const journal = new MissionJournal(storage, project.id, project.canonical, () => sequence++)
    const base = () => ({ version: 1 as const, missionID: mission.id, projectID: project.id, createdAt: sequence++ })
    // An independently accepted task/invocation fixture, as in native-report-control.test.ts.
    await journal.append({ ...base(), id: "decision-contract", type: "task.created", task: {
      id: "tsk_decision", key: "decision", title: "Decision", brief: "Ask the human", role: "decision", blockedBy: [],
      executionMode: { kind: "native", parentTaskKey: null } } })
    await journal.append({ ...base(), id: "bound", type: "task.native-bound", taskKey: "decision", binding: call,
      actor: { sessionID: "ses_child", title: "Child", location: project.location, managed: true } })
    const request = { contract: f.decision.contract, sessionID: "ses_child", toolCallID: "call_report", messageID: "msg_report" }
    const { projectID: _, directory: _directory, delegationToolName: _name, question, answer, ...provenance } = f.decision
    const report = { outcome: "completed" as const, summary: "Decision received", evidence: [], next: [], final: false,
      artifact: { kind: "decision", question, answer, provenance } }
    await assert.rejects(control.reportNative(request, report), /receipt unavailable/)
    f.defer(); await f.submit()
    await assert.rejects(control.reportNative(request, report), /receipt unavailable/)
    f.finish(); await f.native.reconcile(f.binding); await f.closeBackend(); f.expire()
    assert.equal((await control.reportNative(request, report)).disposition, "reported")
    assert(guards >= 4)
  } finally { await f.dispose() }
})

test("lost proxy ACK uses original reservation and receipt-only reconcile, never duplicate native answer", async () => {
  const f = await fixture()
  try {
    f.defer()
    await assert.rejects((async () => { await f.submit(); throw new Error("Lost HTTP ACK") })(), /Lost HTTP ACK/)
    assert.equal(f.get(f.receiptKey).state, "replied")
    f.finish(); f.expire()
    assert.equal((await f.submit()).status, "settled")
    assert.equal(f.counts().replies, 1)
  } finally { await f.dispose() }
})

test("unknown native return remains reserved even with same completed answer; no reply replay or human proof", async () => {
  const f = await fixture()
  try {
    f.loseNativeReturn(); await assert.rejects(f.submit(), /Unknown native return/)
    assert.equal(f.get(f.receiptKey).state, "reserved")
    assert.equal((await f.submit()).status, "pending")
    assert.equal(f.counts().replies, 1)
  } finally { await f.dispose() }
})

test("Auto/Yolo/programmatic, wrong question call, moved/sibling and expired auth cannot mint human evidence", async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.native.reply({ body: { ...f.body, cookieSessionID: "auth-disabled" }, proof: "0".repeat(64) }))
    await assert.rejects(f.native.reply({ body: f.body, proof: "0".repeat(64) }))
    const expired = { ...f.body, issuedAt: Date.now() - 30000 }
    await assert.rejects(f.native.reply({ body: expired, proof: humanAnswerProof(expired, "wrong") }))
    f.part.id = "wrong_call"
    f.db.prepare("UPDATE session_message SET data=? WHERE id='msg_question'").run(JSON.stringify({ content: [f.part] }))
    await assert.rejects(f.submit(), /call mismatch/)
    assert.equal(f.get(f.receiptKey), undefined)
    f.db.prepare("UPDATE session_v2 SET directory='foreign' WHERE id='ses_child'").run()
    await assert.rejects(f.submit())
    await assert.rejects(f.native.reconcile({ ...f.binding, sessionID: "ses_sibling" }))
    assert.equal(f.counts().replies, 0)
  } finally { await f.dispose() }
})
