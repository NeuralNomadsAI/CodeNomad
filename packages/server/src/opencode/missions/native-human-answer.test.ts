import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import Fastify from "fastify"
import { OpenCode } from "@opencode/client"
import pino from "pino"
import { Context, Effect } from "effect"
import { AuthManager } from "../../auth/manager"
import { stableToken, MissionJournal, type MissionStorage } from "../../missions/journal"
import { MissionControl } from "../../missions/control"
import { buildAssignmentPrompt } from "../../missions/recipes"
import { HUMAN_MARK_STORAGE_PREFIX } from "../../missions/human-answer"
import { decisionQuestionTag } from "../../missions/decision-question-tag"
import { createAutomationBridgeRegistration, publishAutomationBridge } from "../automation-plugin"
import { registerAutomationPluginRoute } from "../../server/routes/automation-plugin"
import { registerInstanceProxyRoutes } from "../../server/http-server"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { NativeDecisionEvidenceRequest } from "../../missions/native-human-evidence"
import { acquireNativeHumanAnswers, nativeHumanAnswerGate } from "./native-human-answer"
import { attachRemoteDevice, markRemoteSocket } from "../../remote-control/request-origin"

const encode = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
/** `asker`: the conversation holding the question; `ses_root` is the coordinator asking from its own conversation.
 * `questions`: one native question call's questions, one Form field each (`q0`, `q1`…). */
async function fixture(asker: "ses_child" | "ses_root" = "ses_child", questions: string | string[] = "Choose the seam?") {
  const asked = Array.isArray(questions) ? questions : [questions], question = asked[0]
  const temporaryRoot = path.join(tmpdir(), "opencode")
  await mkdir(temporaryRoot, { recursive: true })
  const directory = await mkdtemp(path.join(temporaryRoot, "human-mark-"))
  const db = new DatabaseSync(path.join(directory, "offline.sqlite"))
  db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,metadata TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,data TEXT);
    CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,data TEXT);
    CREATE TABLE event(id TEXT,seq INTEGER,type TEXT,aggregate_id TEXT,data TEXT);`)
  const put = (key: string, value: unknown) => db.prepare("INSERT OR REPLACE INTO kv VALUES(?,?,1,1)").run(encode(key), JSON.stringify(value))
  const get = (key: string) => { const row = db.prepare("SELECT value FROM kv WHERE key=?").get(encode(key)) as { value: string } | undefined; return row && JSON.parse(row.value) }
  const location = { directory, project: { id: "project", canonical: directory, directory } }
  // A one-time Mission coordinator root, as MissionControl creates it; only Mission families take the mark path.
  const oneTime = JSON.stringify({ "codenomad.mission": { version: 1, missionID: "msn_test", kind: "coordinator" } })
  for (const [id, parent] of [["ses_root", null], ["ses_child", "ses_root"], ["ses_other", "ses_root"]])
    db.prepare("INSERT INTO session_v2 VALUES(?,?,?, ?,NULL,?)").run(id, parent, "project", directory, parent ? "{}" : oneTime)
  const nativeGet = async ({ sessionID }: { sessionID: string }) => {
    const row = db.prepare("SELECT * FROM session_v2 WHERE id=?").get(sessionID) as { id: string; parent_id: string | null; directory: string; metadata: string }
    if (!row) throw new Error("Session not found")
    // The native API returns host separators even when SQL stores `/` (Windows).
    return { id: row.id, projectID: "project", location: { directory: path.normalize(row.directory) }, metadata: JSON.parse(row.metadata), title: "Decision", agent: "worker",
      model: { providerID: "provider", id: "model" }, ...(row.parent_id ? { parentID: row.parent_id } : {}) }
  }
  const input = { questions: asked.map(text => ({ question: text, header: "Seam", options: [{ label: "Module", description: "Own the boundary" }] })) }
  const form = { id: "frm_actual", sessionID: asker, title: "Questions", metadata: { kind: "question", tool: { messageID: "msg_question", id: "call_question" } },
    fields: asked.map((text, index) => ({ key: `q${index}`, type: "string", title: "Seam", description: text, custom: true,
      options: [{ value: "Module", label: "Module", description: "Own the boundary" }] })) }
  let state: { status: string; answer?: Record<string, string> } = { status: "pending" }, replies = 0, expired = false, failReply = false, loseReply = false, complete = true
  const part = { type: "tool", name: "question", id: "call_question", executed: false, state: { status: "running", input } }
  const message = () => db.prepare("INSERT OR REPLACE INTO session_message VALUES(?,?,?,?)").run("msg_question", asker, "assistant", JSON.stringify({ content: [part] }))
  message()
  const delegation = { type: "tool", name: "subagent", id: "call_delegate", executed: false, state: { status: "running", input: {}, metadata: { sessionID: "ses_child" } } }
  db.prepare("INSERT INTO session_message VALUES(?,?,?,?)").run("msg_delegate", "ses_root", "assistant", JSON.stringify({ content: [delegation] }))
  const event = (id: string, seq: number, type: string, data: unknown) => db.prepare("INSERT INTO event VALUES(?,?,?,?,?)").run(id, seq, type, asker,
    JSON.stringify({ sessionID: asker, assistantMessageID: "msg_question", id: "call_question", executed: false, ...data as object }))
  event("event_called", 1, "session.tool.called.1", { input })
  const finish = () => {
    const metadata = { answers: form.fields.map(field => [state.answer![field.key]]) }, content = [{ type: "text", text: "Native question answer" }]
    Object.assign(part.state, { status: "completed", metadata, content }); message()
    event("event_success", 2, "session.tool.success.2", { metadata, content })
  }
  const cache = <T>(value: () => T) => expired ? Effect.fail({ _tag: "Form.NotFoundError", id: form.id }) : Effect.sync(value)
  const forms = { get: () => cache(() => form), state: () => cache(() => state), reply: (value: { id: string; answer: Record<string, string> }) => Effect.sync(() => {
    assert.equal(value.id, form.id); assert.equal(state.status, "pending")
    // The write-ahead mark is already committed when native forwarding begins.
    assert.ok(get(markKey) || ordinary, "UI mark committed before native reply")
    if (failReply) throw new Error("Native reply failed")
    replies++; state = { status: "answered", answer: structuredClone(value.answer) }; if (complete) finish()
    // A lost reply: native state changed, but the caller only sees an error.
    if (loseReply) throw new Error("Native reply lost")
  }) }
  const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
  const locationTag = Context.Service<never, unknown>("@opencode/Location"), formTag = Context.Service<never, unknown>("@opencode/Form")
  const sql = Object.assign(() => {}, { unsafe: (query: string, args: readonly unknown[]) => ({ withoutTransform: Effect.sync(() => db.prepare(query).all(...args as [])) }) })
  const database = { db: { $client: sql, transaction: (callback: () => Effect.Effect<unknown>) => Effect.promise(async () => {
    db.exec("BEGIN IMMEDIATE")
    try { const result = await Effect.runPromise(Effect.provide(callback(), graph)); db.exec("COMMIT"); return result }
    catch (error) { db.exec("ROLLBACK"); throw error }
  }) } }
  const graph = Context.make(databaseTag, database).pipe(Context.add(locationTag, location), Context.add(formTag, forms))
  const storage: MissionStorage = { get: async key => get(key), set: async (key, value, current) => { current?.(); put(key, value) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const rows = db.prepare("SELECT key,value FROM kv WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?")
        .all(encode(prefix).length, encode(prefix), encode(after ?? prefix), limit + 1) as { key: string; value: string }[]
      const entries = rows.slice(0, limit).map(row => ({ key: row.key.slice(encode("").length), value: JSON.parse(row.value) }))
      return { entries, ...(rows.length > limit ? { next: entries.at(-1)!.key } : {}) }
    } }
  // Native plugin storage is Effect-based; the journal membership read uses it read-only.
  let journalScans = 0
  const nativeStorage = { get: (key: string) => Effect.promise(() => storage.get(key)),
    scan: (options: Parameters<MissionStorage["scan"]>[0]) => Effect.promise(() => { journalScans++; return storage.scan(options) }) }
  const native = await Effect.runPromise(Effect.provide(acquireNativeHumanAnswers({ location, storage: nativeStorage } as never), graph))
  const markKey = `${HUMAN_MARK_STORAGE_PREFIX}/${stableToken(`project\0${directory}`, 24)}/${asker}/${form.id}`
  const auth = new AuthManager({ configPath: path.join(directory, "auth.yaml"), username: "human", generateToken: true }, pino({ level: "silent" }) as never)
  const cookie = auth.createSession("human")
  let ordinary = false
  const connection = { endpoint: { url: "http://127.0.0.1:1" }, client: { session: { get: nativeGet },
    rpc: () => ({ ...native, scheduleCarrierRead: async () => ({ owned: false }) }) }, assertCurrent: () => {},
    fetch: async (_url: unknown, init: { body: string }) => {
      ordinary = true
      await Effect.runPromise(Effect.provide(forms.reply({ id: form.id, answer: JSON.parse(init.body).answer }), graph))
      // Native form replies answer an empty 204 (the generated client's successStatus).
      return new Response(null, { status: 204 })
    }, profile: async () => "modern", invalidate: () => {} }
  const workspace = { id: "workspace", path: directory }
  const manager = { get: () => workspace, getSharedServiceConnection: async () => connection,
    ownsLocation: async () => true, getServiceWslDistro: () => undefined,
    getSharedServiceEndpoint: async () => connection.endpoint, getSharedServiceClient: async () => connection.client,
    getServiceDirectory: () => directory, getInstanceAuthorizationHeader: () => "Basic fixture",
    getServiceDirectoryForPath: async (_: string, requested: string) => requested === directory ? directory : undefined,
    getWorktreeIdentityForPath: async (_: string, requested: string) => requested === directory ? "fixture-checkout" : undefined,
    ownsDirectory: async (_: string, requested: string) => requested === directory, ownsPath: async () => false }
  const settings = { getProfileScope: () => ({ key: "profile" }) }
  const app = Fastify(), registration = createAutomationBridgeRegistration("http://127.0.0.1:1")
  // Stand-in for the Remote Control ingress + gate: socket membership and the
  // authenticated device, never a header the proxy itself trusts.
  const devices = { authorized: true }
  const remoteDevices = { isDeviceAuthorized: (id: string) => id === "device-1" && devices.authorized }
  app.addHook("onRequest", async request => {
    const device = request.headers["x-fixture-remote-device"]
    if (typeof device !== "string") return
    markRemoteSocket(request.raw.socket)
    if (device) attachRemoteDevice(request, device)
  })
  registerAutomationPluginRoute(app, { authManager: auth, bridgeToken: registration.token, workspaceManager: manager, settings, nativeParent: {}, developerCdp: {}, remoteDevices } as never)
  registerInstanceProxyRoutes(app, { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence(80), logger: pino({ level: "silent" }),
    humanAnswers: { auth, manager, settings, bridgeToken: registration.token, remoteDevices } } as never)
  await app.listen({ host: "127.0.0.1", port: 0 })
  const baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
  registration.url = `${baseUrl}/api/opencode-plugin/automation`
  const disposeBridge = await publishAutomationBridge(registration)
  const decision: NativeDecisionEvidenceRequest = { kind: "native-form-answer", contract: { missionID: "msn_test", taskKey: "decision", generation: 1 },
    nativeCall: { generation: 1, parentSessionID: "ses_root", parentMessageID: "msg_delegate", toolCallID: "call_delegate" },
    sessionID: "ses_child", formID: form.id, messageID: "msg_question", toolCallID: "call_question", fieldKey: "q0",
    projectID: "project", directory, delegationToolName: "subagent", question, answer: "Module" }
  return { native, db, get, put, markKey, decision, form, part, storage, nativeGet, directory, finish,
    secrets: [cookie.id, registration.token],
    counts: () => replies, journalScans: () => journalScans, expire: () => { expired = true }, fail: (value = true) => { failReply = value }, lose: () => { loseReply = true }, defer: () => { complete = false },
    changeState: (status: string) => { state.status = status },
    submit: (human = true, answer: string | Record<string, string> = "Module", cookieID = cookie.id) => app.inject({ method: "POST", url: `/workspaces/workspace/instance/api/session/${asker}/form/${form.id}/reply`,
      headers: { cookie: `${auth.getCookieName()}=${encodeURIComponent(cookieID)}`, ...(human ? { "x-codenomad-human-answer": "1" } : {}) },
      payload: { answer: typeof answer === "string" ? { q0: answer } : answer } }),
    devices,
    /** The dock's actual call: the generated client against the proxy, which enforces the native success status. */
    submitClient: (human = true) => OpenCode.make({ baseUrl: `${baseUrl}/workspaces/workspace/instance`,
      headers: { cookie: `${auth.getCookieName()}=${encodeURIComponent(cookie.id)}`, ...(human ? { "x-codenomad-human-answer": "1" } : {}) } })
      .session.form.reply({ sessionID: "ses_child", formID: form.id, answer: { q0: "Module" } }),
    /** A Remote Control dock answer: no local cookie, only the ingress device identity ("" = unpaired). */
    submitRemote: (device = "device-1") => app.inject({ method: "POST", url: `/workspaces/workspace/instance/api/session/ses_child/form/${form.id}/reply`,
      headers: { "x-codenomad-human-answer": "1", "x-fixture-remote-device": device }, payload: { answer: { q0: "Module" } } }),
    dispose: async () => { await disposeBridge(); await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) } }
}

test("dock header writes a secret-free mark before native reply and gate accepts", async () => {
  const f = await fixture()
  try {
    assert.equal((await f.submit()).statusCode, 204)
    const mark = await f.native.verify(f.decision)
    assert.deepEqual(Object.keys(mark).sort(), ["answer", "answeredAt", "form", "formID", "sessionID", "via"])
    assert.equal(mark.via, "ui"); assert.equal(f.counts(), 1)
    assert.equal(mark.form.fields[0].type, "string")
    if (mark.form.fields[0].type === "string") assert.deepEqual(mark.form.fields[0].options, f.form.fields[0].options)
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM kv WHERE key LIKE '%recurrence-signer%'").get()!.count, 0)
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM kv WHERE key LIKE '%codenomad-missions/authority-%'").get()!.count, 0, "no retired authority-v2 key")
    assert.ok(f.get(f.markKey), "the mark lives under its own simple namespace")
    assert.equal(JSON.stringify(mark).includes("cookie"), false)
    assert.equal(JSON.stringify(mark).includes("signature"), false)
    for (const secret of f.secrets) assert.equal(JSON.stringify(mark).includes(secret), false)
  } finally { await f.dispose() }
})

test("human proof reads split tool parts ahead of stale inline content", async () => {
  const f = await fixture()
  try {
    assert.equal((await f.submit()).statusCode, 204)
    for (const row of f.db.prepare("SELECT id,session_id,data FROM session_message").all()) {
      const data = JSON.parse(String(row.data))
      for (const [ordinal, part] of data.content.entries())
        f.db.prepare("INSERT INTO session_part VALUES(?,?,?,?,?)").run(row.id, row.session_id, ordinal, part.type, JSON.stringify(part))
      f.db.prepare("UPDATE session_message SET data=? WHERE id=?").run(JSON.stringify({ ...data, content: [] }), row.id)
    }
    assert.equal((await f.native.verify(f.decision)).via, "ui")
    f.db.exec("UPDATE session_part SET data=json_set(data,'$.state.status','running') WHERE message_id='msg_question'")
    await assert.rejects(f.native.verify(f.decision), /answer mismatch/)
  } finally { await f.dispose() }
})

test("the generated client accepts both marked and ordinary dock answers as native successes", async () => {
  for (const human of [true, false]) {
    const f = await fixture()
    try {
      // The dock settles its queue only when this resolves; any non-204 status rejects as UnexpectedStatus.
      await f.submitClient(human)
      assert.equal(f.counts(), 1)
      assert.equal(f.get(f.markKey)?.state, human ? "confirmed" : undefined)
      // The Form is answered: a replay must fail rather than double-answer.
      await assert.rejects(f.submitClient(human))
    } finally { await f.dispose() }
  }
})

test("Windows native SQL slash-separated session directories still bind the dock answer and gate", async () => {
  const f = await fixture()
  try {
    // Observed natively (2.0.26, hF44ln): session_v2 stores `/`, Location keeps host `\` separators.
    f.db.prepare("UPDATE session_v2 SET directory=?").run(f.directory.replaceAll("\\", "/"))
    assert.equal((await f.submit()).statusCode, 204)
    assert.equal(f.get(f.markKey)?.state, "confirmed")
    assert.equal((await f.native.verify(f.decision)).via, "ui")
  } finally { await f.dispose() }
})

test("the gate reads the durable message projection; an empty native event table (serve, minimum supported OpenCode) still qualifies", async () => {
  const f = await fixture()
  try {
    assert.equal((await f.submit()).statusCode, 204)
    f.db.exec("DELETE FROM event")
    assert.equal((await f.native.verify(f.decision)).via, "ui")
  } finally { await f.dispose() }
})

test("Wayfinder without a published binding accepts only the exact fresh assignment child with a UI mark", async () => {
  const f = await fixture()
  try {
    f.db.exec("DELETE FROM event")
    // Same Effect.tryPromise wrapping as the passage Job's production gate.
    const control = new MissionControl({ storage: f.storage, project: { id: "project", canonical: f.directory, location: { directory: f.directory } },
      sessions: { get: f.nativeGet, create: async () => { throw new Error("No ghost root") }, prompt: async () => {}, synthetic: async () => {} },
      humanGate: request => Effect.runPromise(Effect.tryPromise(() => f.native.verify(request))) })
    const made = await control.create({ requestID: "wayfinder-unbound", objective: "Choose the seam", template: "wayfinder", coordinatorSessionID: "ses_root" })
    f.decision.contract.missionID = made.mission.id
    // Simple native passages publish no task.native-bound event: only the declaration exists.
    await new MissionJournal(f.storage, "project", f.directory).append({ version: 1, id: "decision_created", type: "task.created", missionID: made.mission.id,
      projectID: "project", createdAt: made.mission.createdAt + 1, task: { id: "tsk_decision", key: "decision", title: "Decision", brief: "Ask the human",
        role: "decision", executionMode: { kind: "native", parentTaskKey: null }, blockedBy: [] } })
    const mission = (await control.snapshot()).missions[0], assignment = buildAssignmentPrompt(mission, mission.tasks[0])
    const delegate = (input: Record<string, unknown>) => f.db.prepare("UPDATE session_message SET data=? WHERE id='msg_delegate'").run(JSON.stringify({ content: [
      { type: "tool", name: "subagent", id: "call_delegate", executed: false, state: { status: "running", input, metadata: { sessionID: "ses_child" } } }] }))
    const { question, answer, projectID: _, directory: _directory, delegationToolName: _name, ...provenance } = f.decision
    const report = (nativeCall = provenance.nativeCall) => ({ missionID: mission.id, taskKey: "decision", outcome: "completed" as const, summary: "Human chose the seam",
      evidence: [], next: [], final: false, artifact: { kind: "decision", question, answer, provenance: { ...provenance, nativeCall } } })
    delegate({ agent: "worker", description: "Decision", prompt: assignment })
    // Without a UI mark the model gets an actionable refusal, not the opaque Effect wrapper.
    await assert.rejects(control.report("ses_root", report()), (error: Error) =>
      /^Human decision required: the user must answer this question from the CodeNomad interface\./.test(error.message)
      && !error.message.includes("Effect.tryPromise"), "no UI mark yet")
    assert.equal((await f.submit()).statusCode, 204)
    delegate({ agent: "worker", description: "Decision", prompt: "Unrelated work" })
    await assert.rejects(control.report("ses_root", report()), /not this assignment/)
    delegate({ agent: "worker", description: "Decision", prompt: assignment, sessionID: "ses_child" })
    await assert.rejects(control.report("ses_root", report()), /not this assignment/, "a continuation is not a fresh assignment child")
    delegate({ agent: "worker", description: "Decision", prompt: `Context first.\n${assignment}` })
    await assert.rejects(control.report("ses_root", report({ ...provenance.nativeCall, parentSessionID: "ses_other" })), /Wayfinder decision evidence unavailable/)
    assert.equal((await control.report("ses_root", report())).disposition, "reported")
    assert.equal((await control.snapshot()).missions[0].tasks[0].status, "completed")
  } finally { await f.dispose() }
})

test("a decision readout discovers the human's exact answer from native structure, then the gate verifies it", async () => {
  const f = await fixture()
  try {
    f.db.exec("DELETE FROM event")
    const control = new MissionControl({ storage: f.storage, project: { id: "project", canonical: f.directory, location: { directory: f.directory } },
      sessions: { get: f.nativeGet, create: async () => { throw new Error("No ghost root") }, prompt: async () => {}, synthetic: async () => {} },
      humanGate: nativeHumanAnswerGate(use => use(f.native)) })
    const made = await control.create({ requestID: "wayfinder-discovered", objective: "Choose the seam", template: "wayfinder", coordinatorSessionID: "ses_root" })
    await new MissionJournal(f.storage, "project", f.directory).append({ version: 1, id: "decision_created", type: "task.created", missionID: made.mission.id,
      projectID: "project", createdAt: made.mission.createdAt + 1, task: { id: "tsk_decision", key: "decision", title: "Decision", brief: "Ask the human",
        role: "decision", executionMode: { kind: "native", parentTaskKey: null }, blockedBy: [] } })
    const mission = (await control.snapshot()).missions[0], assignment = buildAssignmentPrompt(mission, mission.tasks[0])
    const delegate = (prompt: string) => f.db.prepare("UPDATE session_message SET data=? WHERE id='msg_delegate'").run(JSON.stringify({ content: [
      { type: "tool", name: "subagent", id: "call_delegate", executed: false, state: { status: "running", input: { prompt }, metadata: { sessionID: "ses_child" } } }] }))
    delegate(assignment)
    const candidates = () => control.decisionCandidates("ses_root", mission.id, "decision")
    const readout = { taskKey: "decision", outcome: "completed" as const, summary: "The human chose the module seam", evidence: [], next: [], final: false }
    assert.deepEqual(await candidates(), { candidates: [], complete: true }, "no UI mark yet")
    await assert.rejects(control.report("ses_root", readout), /Decision outcome required/)
    assert.equal((await f.submit()).statusCode, 204)
    delegate("Unrelated work")
    assert.deepEqual(await candidates(), { candidates: [], complete: true }, "a child born for other work never qualifies")
    delegate(assignment)
    const discovery = (await candidates())!
    assert.equal(discovery.complete, true)
    const [found, ...others] = discovery.candidates
    assert.deepEqual(others, [])
    assert.deepEqual(found, { question: "Choose the seam?", answer: "Module", askedBy: "decision-task", artifact: { kind: "decision", question: "Choose the seam?", answer: "Module",
      provenance: { kind: "native-form-answer", contract: { missionID: mission.id, taskKey: "decision", generation: 1 },
        nativeCall: { generation: 1, parentSessionID: "ses_root", parentMessageID: "msg_delegate", toolCallID: "call_delegate" },
        sessionID: "ses_child", formID: f.form.id, messageID: "msg_question", toolCallID: "call_question", fieldKey: "q0" } } })
    // An unreadable confirmed mark cannot be excluded: the visible answer is listed but never auto-chosen.
    f.put(f.markKey.replace(f.form.id, "frm_broken"), { state: "confirmed", via: "ui", sessionID: "ses_child", answer: { q0: "Adapter" }, form: { invalid: true } })
    assert.deepEqual(await candidates(), { candidates: [found], complete: false })
    await assert.rejects(control.report("ses_root", readout), /Not every answered question could be checked/)
    f.db.prepare("DELETE FROM kv WHERE key LIKE ?").run("%frm_broken")
    // A confirmed answer the gate cannot verify (here: the native Form now disagrees) leaves the discovery incomplete.
    f.changeState("cancelled")
    assert.deepEqual(await candidates(), { candidates: [], complete: false })
    await assert.rejects(control.report("ses_root", readout), /Not every answered question could be checked/)
    f.changeState("answered")
    assert.equal((await control.report("ses_root", readout)).disposition, "reported")
    assert.deepEqual((await control.snapshot()).missions[0].tasks[0].report?.artifact, found.artifact)
  } finally { await f.dispose() }
})

/** A Wayfinder mission on the fixture's root, with the real native gate; its ID is known before creation. */
const coordinatorMission = (requestID: string) => ({ requestID, missionID: `msn_${stableToken(`project\0${requestID}`, 24)}` })
async function wayfinderOnRoot(f: Awaited<ReturnType<typeof fixture>>, requestID: string, taskKey: string) {
  const control = new MissionControl({ storage: f.storage, project: { id: "project", canonical: f.directory, location: { directory: f.directory } },
    sessions: { get: f.nativeGet, create: async () => { throw new Error("No ghost root") }, prompt: async () => {}, synthetic: async () => {} },
    humanGate: nativeHumanAnswerGate(use => use(f.native)) })
  const made = await control.create({ requestID, objective: "Approve the production database deletion", template: "wayfinder", coordinatorSessionID: "ses_root" })
  await control.declare("ses_root", { taskKey, title: "Decision", brief: "Return a decision brief", role: "decision", blockedBy: [] })
  const mission = (await control.snapshot()).missions.find(value => value.id === made.mission.id)!
  const readout = { taskKey, outcome: "completed" as const, summary: "The human decided", evidence: [], next: [], final: false }
  return { control, mission, readout, candidates: () => control.decisionCandidates("ses_root", mission.id, taskKey) }
}
const relabelled = (missionID: string, taskKey: string, question: string, answer = "Module") => ({ kind: "decision", decidedBy: "human", question, answer,
  provenance: { kind: "coordinator-form-answer", contract: { missionID, taskKey, generation: 1 }, sessionID: "ses_root", formID: "frm_actual",
    messageID: "msg_question", toolCallID: "call_question", fieldKey: "q0" } })

test("the coordinator's own question naming its task: the dock mark proves the exact answer, which settles that task", async () => {
  const { requestID, missionID } = coordinatorMission("wayfinder-coordinator")
  const question = `Choose the seam? ${decisionQuestionTag(missionID, "decision")}`
  const f = await fixture("ses_root", question)
  try {
    f.db.exec("DELETE FROM event")
    const { control, mission, readout, candidates } = await wayfinderOnRoot(f, requestID, "decision")
    assert.equal(mission.id, missionID)
    assert.deepEqual(await candidates(), { candidates: [], complete: true }, "no UI mark yet")
    assert.equal((await f.submit()).statusCode, 204)
    assert.equal(f.get(f.markKey)?.state, "confirmed", "the coordinator's own Form takes the mark path")
    const [found, ...others] = (await candidates())!.candidates
    assert.deepEqual(others, [])
    assert.deepEqual(found, { question, answer: "Module", askedBy: "coordinator", artifact: { kind: "decision", decidedBy: "human",
      question, answer: "Module", provenance: { kind: "coordinator-form-answer", contract: { missionID, taskKey: "decision", generation: 1 },
        sessionID: "ses_root", formID: f.form.id, messageID: "msg_question", toolCallID: "call_question", fieldKey: "q0" } } })
    await assert.rejects(control.report("ses_root", { ...readout, artifact: { ...found.artifact, answer: "Adapter" } }), /Human decision required/,
      "a model-written answer never borrows the human's mark")
    // The answer names this task, so an artifact-free readout settles it with the verified answer.
    assert.equal((await control.report("ses_root", readout)).disposition, "reported")
    assert.deepEqual((await control.snapshot()).missions[0].tasks[0].report?.artifact, found.artifact)
    f.expire()
    assert.equal((await control.report("ses_root", { ...readout, final: true })).disposition, "finished", "the saved Form snapshot re-verifies")
  } finally { await f.dispose() }
})

test("an answer confirmed before the mission existed never settles a new task, even relabelled", async () => {
  const f = await fixture("ses_root")
  try {
    // The human answers an unrelated question first.
    assert.equal((await f.submit()).statusCode, 204)
    const { control, mission, readout, candidates } = await wayfinderOnRoot(f, "review-old-answer", "delete-production")
    assert.deepEqual(await candidates(), { candidates: [], complete: true }, "the old answer is never offered")
    await assert.rejects(control.report("ses_root", { ...readout, artifact: relabelled(mission.id, "delete-production", "Choose the seam?") }),
      /does not settle this decision task/)
    await assert.rejects(control.report("ses_root", readout), /Decision outcome required.*\[decision delete-production /)
    assert.equal((await control.snapshot()).missions[0].reports.length, 0)
  } finally { await f.dispose() }
})

test("an answer to a question naming one task cannot be relabelled to another task", async () => {
  const { requestID, missionID } = coordinatorMission("review-relabel")
  const question = `Choose the seam? ${decisionQuestionTag(missionID, "choose-seam")}`
  const f = await fixture("ses_root", question)
  try {
    const { control, readout, candidates } = await wayfinderOnRoot(f, requestID, "delete-production")
    assert.equal((await f.submit()).statusCode, 204)
    assert.deepEqual(await candidates(), { candidates: [], complete: true }, "not offered to the task its question does not name")
    await assert.rejects(control.report("ses_root", { ...readout, artifact: relabelled(missionID, "delete-production", question) }),
      /does not settle this decision task/)
    // The gate itself refuses the relabelled contract, whatever the caller checked.
    const { nativeCall: _call, delegationToolName: _name, ...request } = f.decision
    await assert.rejects(f.native.verify({ ...request, kind: "coordinator-form-answer", sessionID: "ses_root",
      contract: { missionID, taskKey: "delete-production", generation: 1 } }), /does not name this decision task/)
    assert.equal((await f.native.verify({ ...request, kind: "coordinator-form-answer", sessionID: "ses_root",
      contract: { missionID, taskKey: "choose-seam", generation: 1 } })).via, "ui")
  } finally { await f.dispose() }
})

/** Confirmed, internally consistent earlier coordinator Forms that sort before `frm_actual`: one question each,
 * whose text is `question(index)`; `answer` and `option` may quote decision tags, which never bind. Call after `submit`. */
function history(f: Awaited<ReturnType<typeof fixture>>, indexes: Iterable<number>,
  { question = (index: number) => `Earlier question ${index}?`, answer = "Earlier answer", option = "Own the boundary" } = {}) {
  for (const index of indexes) {
    const formID = `frm_${String(index).padStart(3, "0")}`, messageID = `msg_old_${index}`, text = question(index)
    const mark = structuredClone(f.get(f.markKey))
    mark.formID = formID; mark.form.id = formID; mark.form.metadata.tool.messageID = messageID
    mark.form.fields = [{ ...mark.form.fields[0], key: "q0", description: text, options: [{ value: "Module", label: "Module", description: option }] }]
    mark.answer = { q0: answer }
    f.put(f.markKey.replace("frm_actual", formID), mark)
    const part = structuredClone(f.part)
    part.state.input.questions = [{ ...part.state.input.questions[0], question: text, options: [{ label: "Module", description: option }] }]
    ;(part.state as { metadata?: unknown }).metadata = { answers: [[answer]] }
    f.db.prepare("INSERT INTO session_message VALUES(?,?,?,?)").run(messageID, "ses_root", "assistant", JSON.stringify({ content: [part] }))
  }
}

test("40 earlier coordinator Forms quoting the tag only in answers or options never hide this decision's answer; many bound answers stay fail-closed", async () => {
  const { requestID, missionID } = coordinatorMission("review-history")
  const tag = decisionQuestionTag(missionID, "decision"), question = `Choose the seam? ${tag}`
  const f = await fixture("ses_root", question)
  try {
    const { control, readout, candidates } = await wayfinderOnRoot(f, requestID, "decision")
    assert.equal((await f.submit()).statusCode, 204)
    f.expire()
    // Unrelated questions whose answers and options mention the tag as a background reference.
    history(f, Array.from({ length: 40 }, (_, index) => index), { answer: `Background reference: ${tag}`, option: `See ${tag}` })
    const found = (await candidates())!
    assert.deepEqual(found.candidates.map(item => item.artifact.provenance.formID), ["frm_actual"])
    assert.equal(found.complete, true)
    assert.equal((await control.report("ses_root", readout)).disposition, "reported")
    // Beyond the bound, questions that do bind this decision leave the discovery incomplete rather than picking one.
    history(f, Array.from({ length: 40 }, (_, index) => 100 + index), { question: () => question, answer: "Module" })
    assert.equal((await candidates())!.complete, false)
  } finally { await f.dispose() }
})

test("a question quoting a second decision's tag settles neither decision, even at final verification", async () => {
  const { requestID, missionID } = coordinatorMission("review-r2-quoted-tag")
  const seam = decisionQuestionTag(missionID, "choose-seam"), deletion = decisionQuestionTag(missionID, "delete-production")
  const question = `Which module seam? ${seam} Background only, NOT a deletion approval: the blocked task is "${deletion}".`
  const f = await fixture("ses_root", question)
  try {
    const { control, readout } = await wayfinderOnRoot(f, requestID, "choose-seam")
    await control.declare("ses_root", { taskKey: "delete-production", title: "Approve deleting production", brief: "Ask for deletion consent", role: "decision", blockedBy: [] })
    assert.equal((await f.submit()).statusCode, 204)
    for (const taskKey of ["delete-production", "choose-seam"]) {
      assert.deepEqual(await control.decisionCandidates("ses_root", missionID, taskKey), { candidates: [], complete: true }, `${taskKey} is not offered`)
      await assert.rejects(control.report("ses_root", { ...readout, taskKey }), /Decision outcome required/)
      await assert.rejects(control.report("ses_root", { ...readout, taskKey, artifact: relabelled(missionID, taskKey, question) }), /does not settle this decision task/)
      const { nativeCall: _call, delegationToolName: _name, ...request } = f.decision
      await assert.rejects(f.native.verify({ ...request, kind: "coordinator-form-answer", sessionID: "ses_root",
        contract: { missionID, taskKey, generation: 1 } }), /does not name this decision task/, "the gate refuses the ambiguous field itself")
    }
    assert.equal((await control.snapshot()).missions[0].reports.length, 0)
  } finally { await f.dispose() }
})

test("one batched question call settles two decisions, each from its own field, behind history quoting both tags", async () => {
  const { requestID, missionID } = coordinatorMission("review-r2-batch")
  const seam = decisionQuestionTag(missionID, "choose-seam"), deletion = decisionQuestionTag(missionID, "delete-production")
  const f = await fixture("ses_root", [`Which module seam? ${seam}`, `May we delete the production database? ${deletion}`])
  try {
    const { control, readout } = await wayfinderOnRoot(f, requestID, "choose-seam")
    await control.declare("ses_root", { taskKey: "delete-production", title: "Approve deleting production", brief: "Ask for deletion consent", role: "decision", blockedBy: [] })
    assert.equal((await f.submit(true, { q0: "Module", q1: "Not yet" })).statusCode, 204)
    f.expire()
    history(f, Array.from({ length: 40 }, (_, index) => index), { answer: `About ${seam} and ${deletion}`, option: `${seam} ${deletion}` })
    for (const [taskKey, fieldKey, answer] of [["choose-seam", "q0", "Module"], ["delete-production", "q1", "Not yet"]]) {
      const found = (await control.decisionCandidates("ses_root", missionID, taskKey))!
      assert.equal(found.complete, true, taskKey)
      assert.deepEqual(found.candidates.map(item => [item.artifact.provenance.formID, item.artifact.provenance.fieldKey, item.answer]), [["frm_actual", fieldKey, answer]])
      assert.equal((await control.report("ses_root", { ...readout, taskKey })).disposition, "reported")
    }
    const tasks = (await control.snapshot()).missions[0].tasks
    assert.deepEqual(tasks.map(task => [task.key, (task.report?.artifact as { answer?: string }).answer]), [["choose-seam", "Module"], ["delete-production", "Not yet"]])
    // A field never settles the other task, even relabelled.
    await assert.rejects(control.report("ses_root", { ...readout, taskKey: "delete-production",
      artifact: { ...relabelled(missionID, "delete-production", `Which module seam? ${seam}`), answer: "Module" } }), /already has different|does not settle/)
    assert.equal((await control.report("ses_root", { ...readout, final: true })).disposition, "finished", "both fields re-verify")
  } finally { await f.dispose() }
})

test("a coordinator-asked answer qualifies only from a root conversation", async () => {
  const f = await fixture()
  try {
    assert.equal((await f.submit()).statusCode, 204)
    const { nativeCall: _call, delegationToolName: _name, ...request } = f.decision
    await assert.rejects(f.native.verify({ ...request, kind: "coordinator-form-answer" }), /outside a root conversation/)
    assert.equal((await f.native.verify(f.decision)).via, "ui")
  } finally { await f.dispose() }
})

test("the same native answer without a human header produces no mark and gate refuses", async () => {
  const f = await fixture()
  try { assert.equal((await f.submit(false)).statusCode, 204); assert.equal(f.counts(), 1)
    assert.equal(f.get(f.markKey), undefined); await assert.rejects(f.native.verify(f.decision))
  } finally { await f.dispose() }
})

test("an ordinary conversation's dock answer is an ordinary native reply: no mark, never blocked", async () => {
  const f = await fixture()
  try { f.db.prepare("UPDATE session_v2 SET metadata='{}' WHERE id='ses_root'").run()
    assert.equal((await f.submit()).statusCode, 204); assert.equal(f.counts(), 1)
    assert.equal(f.get(f.markKey), undefined); await assert.rejects(f.native.verify(f.decision))
  } finally { await f.dispose() }
})

const recurring = (f: Awaited<ReturnType<typeof fixture>>) => f.db.prepare("UPDATE session_v2 SET metadata=? WHERE id='ses_root'").run(JSON.stringify({
  "codenomad.mission": { version: 1, kind: "coordinator", role: "coordinator", missionID: "msn_test", recurrence: { passageID: "passage" } } }))

for (const mode of ["one-time", "recurring"] as const) {
  test(`${mode}: failed dock forward removes the pending mark; a later ordinary reply never qualifies`, async () => {
    const f = await fixture()
    try { if (mode === "recurring") recurring(f)
      f.fail(); assert.equal((await f.submit()).statusCode, 409); assert.equal(f.counts(), 0)
      assert.equal(f.get(f.markKey), undefined, "a definitely failed attempt leaves no mark")
      f.fail(false); assert.equal((await f.submit(false)).statusCode, 204); assert.equal(f.counts(), 1)
      await assert.rejects(f.native.verify(f.decision)); f.expire(); await assert.rejects(f.native.verify(f.decision))
    } finally { await f.dispose() }
  })

  test(`${mode}: a lost native reply stays pending and never qualifies`, async () => {
    const f = await fixture()
    try { if (mode === "recurring") recurring(f)
      f.lose(); assert.equal((await f.submit()).statusCode, 409); assert.equal(f.counts(), 1)
      assert.equal(f.get(f.markKey)?.state, "pending")
      await assert.rejects(f.native.verify(f.decision)); f.expire(); await assert.rejects(f.native.verify(f.decision))
    } finally { await f.dispose() }
  })

  test(`${mode}: a successful dock reply confirms its exact attempt and qualifies`, async () => {
    const f = await fixture()
    try { if (mode === "recurring") recurring(f)
      assert.equal((await f.submit()).statusCode, 204); assert.equal(f.get(f.markKey)?.state, "confirmed")
      assert.equal((await f.native.verify(f.decision)).via, "ui")
    } finally { await f.dispose() }
  })
}

test("answered mark survives native Form cache expiry and preserves verbatim free text and descriptions", async () => {
  const f = await fixture()
  try { const answer = "  A custom seam\nwith free text  "
    assert.equal((await f.submit(true, answer)).statusCode, 204); f.expire()
    const mark = await f.native.verify({ ...f.decision, answer })
    assert.equal(mark.answer.q0, answer); assert.equal(mark.form.fields[0].type, "string")
    if (mark.form.fields[0].type === "string") assert.equal(mark.form.fields[0].options?.[0].description, "Own the boundary")
  } finally { await f.dispose() }
})

test("native answer alone waits for exact completed question evidence", async () => {
  const f = await fixture()
  try { f.defer(); assert.equal((await f.submit()).statusCode, 204)
    await assert.rejects(f.native.verify(f.decision)); f.finish(); assert.equal((await f.native.verify(f.decision)).via, "ui")
  } finally { await f.dispose() }
})

test("a cached pending or cancelled Form refuses a mark even with completed native tool evidence", async () => {
  const f = await fixture()
  try { assert.equal((await f.submit()).statusCode, 204)
    for (const status of ["pending", "cancelled"]) { f.changeState(status); await assert.rejects(f.native.verify(f.decision)) }
  } finally { await f.dispose() }
})

test("the origin header without a live authenticated UI session cannot mint a mark", async () => {
  const f = await fixture()
  // The answer itself still goes through the ordinary native reply; it just never qualifies.
  try { assert.equal((await f.submit(true, "Module", "invalid-cookie")).statusCode, 204)
    assert.equal(f.get(f.markKey), undefined); assert.equal(f.counts(), 1)
    await assert.rejects(f.native.verify(f.decision))
  } finally { await f.dispose() }
})

test("recurring passage decisions use the same mark gate without recurrence ledger or signer lookups", async () => {
  const f = await fixture()
  try {
    f.db.prepare("UPDATE session_v2 SET metadata=? WHERE id='ses_root'").run(JSON.stringify({
      "codenomad.mission": { version: 1, kind: "coordinator", role: "coordinator", missionID: "msn_test", recurrence: { passageID: "passage" } } }))
    assert.equal((await f.submit()).statusCode, 204); f.expire()
    assert.equal((await f.native.verify(f.decision)).via, "ui")
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM kv").get()!.count, 1, "only the mark, no passage ledger or key")
  } finally { await f.dispose() }
})

test("a recurring passage coordinator's own question takes the same mark gate and task binding", async () => {
  const f = await fixture("ses_root", `Choose the seam? ${decisionQuestionTag("msn_test", "decision")}`)
  try {
    recurring(f)
    assert.equal((await f.submit()).statusCode, 204); f.expire()
    const { nativeCall: _call, delegationToolName: _name, ...request } = f.decision
    assert.equal((await f.native.verify({ ...request, kind: "coordinator-form-answer", sessionID: "ses_root" })).via, "ui")
    await assert.rejects(f.native.verify({ ...request, kind: "coordinator-form-answer", sessionID: "ses_root",
      contract: { ...request.contract, taskKey: "other" } }), /does not name this decision task/)
  } finally { await f.dispose() }
})

test("gate refuses foreign Form/session/message/tool/field and provider-hosted execution", async () => {
  const f = await fixture()
  try { assert.equal((await f.submit()).statusCode, 204)
    for (const mutation of [{ sessionID: "ses_other" }, { formID: "frm_other" }, { messageID: "msg_other" },
      { toolCallID: "call_other" }, { fieldKey: "q1" }, { answer: "Other" }, { directory: "D:/foreign" }])
      await assert.rejects(f.native.verify({ ...f.decision, ...mutation }))
    f.part.executed = true
    f.db.prepare("UPDATE session_message SET data=? WHERE id='msg_question'").run(JSON.stringify({ content: [f.part] }))
    await assert.rejects(f.native.verify(f.decision))
  } finally { await f.dispose() }
})

const attached = (f: Awaited<ReturnType<typeof fixture>>) => f.db.prepare("UPDATE session_v2 SET metadata='{}' WHERE id='ses_root'").run()

for (const [name, setup, answer] of [
  ["a new metadata root, local login", () => {}, (f: Awaited<ReturnType<typeof fixture>>) => f.submit()],
  ["an attached existing root without metadata, local login", attached, (f: Awaited<ReturnType<typeof fixture>>) => f.submit()],
  ["a new metadata root, paired Remote Control device", () => {}, (f: Awaited<ReturnType<typeof fixture>>) => f.submitRemote()],
  ["an attached existing root, paired Remote Control device", attached, (f: Awaited<ReturnType<typeof fixture>>) => f.submitRemote()],
] as const) test(`one-time Wayfinder finalizes through the dock mark: ${name}`, async () => {
  const f = await fixture()
  try {
    setup(f)
    await finalizeWayfinder(f, () => answer(f))
    assert.equal(f.get(f.markKey)?.state, "confirmed")
  } finally { await f.dispose() }
})

test("a metadata-less root outside the durable journal is an ordinary conversation, locally and remotely", async () => {
  for (const submit of ["local", "remote"] as const) {
    const f = await fixture()
    try {
      attached(f)
      assert.equal((await (submit === "local" ? f.submit() : f.submitRemote())).statusCode, 204)
      assert.equal(f.counts(), 1, "the human answer still lands through the ordinary native reply")
      assert.equal(f.get(f.markKey), undefined, submit)
    } finally { await f.dispose() }
  }
})

test("an unrelated metadata-less root answers without reading a populated Mission journal", async () => {
  const f = await fixture()
  try {
    attached(f)
    // Another Mission's coordinator populates this project's journal.
    await new MissionJournal(f.storage, "project", f.directory).append({ version: 1, id: "evt_elsewhere", type: "mission.created",
      missionID: "msn_elsewhere", projectID: "project", projectCanonical: f.directory, createdAt: 1, objective: "Elsewhere", template: "custom",
      coordinator: { sessionID: "ses_elsewhere", title: "Elsewhere", location: { directory: f.directory } } })
    assert.equal((await f.submit()).statusCode, 204)
    assert.equal(f.counts(), 1, "the ordinary native reply still lands")
    assert.equal(f.get(f.markKey), undefined)
    assert.equal(f.journalScans(), 0, "the bounded identity probe skips the journal read")
  } finally { await f.dispose() }
})

test("an attached journal coordinator still pays the exact membership read and gets its mark", async () => {
  const f = await fixture()
  try {
    attached(f)
    await new MissionJournal(f.storage, "project", f.directory).append({ version: 1, id: "evt_attached", type: "mission.created",
      missionID: "msn_attached", projectID: "project", projectCanonical: f.directory, createdAt: 1, objective: "Attached", template: "custom",
      coordinator: { sessionID: "ses_root", title: "Attached", location: { directory: f.directory } } })
    const scans = f.journalScans()
    assert.equal((await f.submit()).statusCode, 204)
    assert(f.journalScans() > scans, "a probe hit is confirmed by the exact snapshot")
    assert.equal(f.get(f.markKey)?.state, "confirmed")
  } finally { await f.dispose() }
})

test("unpaired or revoked Remote Control requests answer ordinarily and never mint a mark", async () => {
  for (const mode of ["unpaired", "revoked", "unknown-device"] as const) {
    const f = await fixture()
    try {
      if (mode === "revoked") f.devices.authorized = false
      const response = await f.submitRemote(mode === "unpaired" ? "" : mode === "unknown-device" ? "device-2" : "device-1")
      assert.equal(response.statusCode, 204, mode); assert.equal(f.counts(), 1)
      assert.equal(f.get(f.markKey), undefined, mode)
      await assert.rejects(f.native.verify(f.decision))
    } finally { await f.dispose() }
  }
})

async function finalizeWayfinder(f: Awaited<ReturnType<typeof fixture>>, respond: () => Promise<{ statusCode: number }>) {
  {
    const control = new MissionControl({ storage: f.storage, project: { id: "project", canonical: f.directory, location: { directory: f.directory } },
      sessions: { get: f.nativeGet, create: async () => { throw new Error("No ghost root") }, prompt: async () => {}, synthetic: async () => {} }, humanGate: request => f.native.verify(request) })
    const made = await control.create({ requestID: "wayfinder", objective: "Choose the seam", template: "wayfinder", coordinatorSessionID: "ses_root" })
    f.decision.contract.missionID = made.mission.id
    const journal = new MissionJournal(f.storage, "project", f.directory), mission = made.mission
    await journal.append({ version: 1, id: "decision_created", type: "task.created", missionID: mission.id, projectID: "project", createdAt: mission.createdAt + 1,
      task: { id: "tsk_decision", key: "decision", title: "Decision", brief: "Ask the human", role: "decision", executionMode: { kind: "native", parentTaskKey: null }, blockedBy: [] } })
    await journal.append({ version: 1, id: "decision_bound", type: "task.native-bound", missionID: mission.id, projectID: "project", createdAt: mission.createdAt + 2,
      taskKey: "decision", binding: f.decision.nativeCall, actor: { sessionID: "ses_child", title: "Decision", location: { directory: f.directory }, managed: true } })
    const { question, answer, projectID: _, directory: _directory, delegationToolName: _name, ...provenance } = f.decision
    const report = { missionID: mission.id, taskKey: "decision", outcome: "completed" as const, summary: "Human chose the seam", evidence: [], next: [], final: false,
      artifact: { kind: "decision", question, answer, provenance } }
    await assert.rejects(control.report("ses_root", report))
    assert.equal((await respond()).statusCode, 204); f.expire()
    assert.equal((await control.report("ses_root", report)).disposition, "reported")
    const current = (await control.snapshot()).missions[0]
    await journal.append({ version: 1, id: "decision_returned", type: "task.native-returned", missionID: mission.id, projectID: "project", createdAt: current.updatedAt + 1,
      taskKey: "decision", childSessionID: "ses_child", binding: f.decision.nativeCall })
    assert.equal((await control.report("ses_root", { ...report, final: true })).disposition, "finished")
  }
}
