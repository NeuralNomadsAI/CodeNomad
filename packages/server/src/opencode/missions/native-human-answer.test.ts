import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import Fastify from "fastify"
import pino from "pino"
import { Context, Effect } from "effect"
import { AuthManager } from "../../auth/manager"
import { stableToken, MissionJournal, type MissionStorage } from "../../missions/journal"
import { MissionControl } from "../../missions/control"
import { buildAssignmentPrompt } from "../../missions/recipes"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { createAutomationBridgeRegistration, publishAutomationBridge } from "../automation-plugin"
import { registerAutomationPluginRoute } from "../../server/routes/automation-plugin"
import { registerInstanceProxyRoutes } from "../../server/http-server"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { NativeDecisionEvidenceRequest } from "../../missions/native-human-evidence"
import { acquireNativeHumanAnswers } from "./native-human-answer"

const encode = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
async function fixture() {
  const temporaryRoot = path.join(tmpdir(), "opencode")
  await mkdir(temporaryRoot, { recursive: true })
  const directory = await mkdtemp(path.join(temporaryRoot, "human-mark-"))
  const db = new DatabaseSync(path.join(directory, "offline.sqlite"))
  db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,metadata TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,data TEXT);
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
  const input = { questions: [{ question: "Choose the seam?", header: "Seam", options: [{ label: "Module", description: "Own the boundary" }] }] }
  const form = { id: "frm_actual", sessionID: "ses_child", title: "Questions", metadata: { kind: "question", tool: { messageID: "msg_question", id: "call_question" } },
    fields: [{ key: "q0", type: "string", title: "Seam", description: "Choose the seam?", custom: true,
      options: [{ value: "Module", label: "Module", description: "Own the boundary" }] }] }
  let state: { status: string; answer?: { q0: string } } = { status: "pending" }, replies = 0, expired = false, failReply = false, loseReply = false, complete = true
  const part = { type: "tool", name: "question", id: "call_question", executed: false, state: { status: "running", input } }
  const message = () => db.prepare("INSERT OR REPLACE INTO session_message VALUES(?,?,?,?)").run("msg_question", "ses_child", "assistant", JSON.stringify({ content: [part] }))
  message()
  const delegation = { type: "tool", name: "subagent", id: "call_delegate", executed: false, state: { status: "running", input: {}, metadata: { sessionID: "ses_child" } } }
  db.prepare("INSERT INTO session_message VALUES(?,?,?,?)").run("msg_delegate", "ses_root", "assistant", JSON.stringify({ content: [delegation] }))
  const event = (id: string, seq: number, type: string, data: unknown) => db.prepare("INSERT INTO event VALUES(?,?,?,?,?)").run(id, seq, type, "ses_child",
    JSON.stringify({ sessionID: "ses_child", assistantMessageID: "msg_question", id: "call_question", executed: false, ...data as object }))
  event("event_called", 1, "session.tool.called.1", { input })
  const finish = () => {
    const metadata = { answers: [[state.answer!.q0]] }, content = [{ type: "text", text: "Native question answer" }]
    Object.assign(part.state, { status: "completed", metadata, content }); message()
    event("event_success", 2, "session.tool.success.2", { metadata, content })
  }
  const cache = <T>(value: () => T) => expired ? Effect.fail({ _tag: "Form.NotFoundError", id: form.id }) : Effect.sync(value)
  const forms = { get: () => cache(() => form), state: () => cache(() => state), reply: (value: { id: string; answer: { q0: string } }) => Effect.sync(() => {
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
  const native = await Effect.runPromise(Effect.provide(acquireNativeHumanAnswers({ location } as never), graph))
  const markKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/human-marks/${stableToken(`project\0${directory}`, 24)}/ses_child/${form.id}`
  const auth = new AuthManager({ configPath: path.join(directory, "auth.yaml"), username: "human", generateToken: true }, pino({ level: "silent" }) as never)
  const cookie = auth.createSession("human")
  let ordinary = false
  const connection = { endpoint: { url: "http://127.0.0.1:1" }, client: { session: { get: nativeGet }, rpc: () => native }, assertCurrent: () => {},
    fetch: async (_url: unknown, init: { body: string }) => {
      ordinary = true
      await Effect.runPromise(Effect.provide(forms.reply({ id: form.id, answer: JSON.parse(init.body).answer }), graph))
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
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
  registerAutomationPluginRoute(app, { authManager: auth, bridgeToken: registration.token, workspaceManager: manager, settings, nativeParent: {}, developerCdp: {} } as never)
  registerInstanceProxyRoutes(app, { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence(80), logger: pino({ level: "silent" }),
    humanAnswers: { auth, manager, settings, bridgeToken: registration.token } } as never)
  await app.listen({ host: "127.0.0.1", port: 0 })
  registration.url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/opencode-plugin/automation`
  const disposeBridge = await publishAutomationBridge(registration)
  const decision: NativeDecisionEvidenceRequest = { kind: "native-form-answer", contract: { missionID: "msn_test", taskKey: "decision", generation: 1 },
    nativeCall: { generation: 1, parentSessionID: "ses_root", parentMessageID: "msg_delegate", toolCallID: "call_delegate" },
    sessionID: "ses_child", formID: form.id, messageID: "msg_question", toolCallID: "call_question", fieldKey: "q0",
    projectID: "project", directory, delegationToolName: "subagent", question: "Choose the seam?", answer: "Module" }
  const storage: MissionStorage = { get: async key => get(key), set: async (key, value, current) => { current?.(); put(key, value) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const rows = db.prepare("SELECT key,value FROM kv WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?")
        .all(encode(prefix).length, encode(prefix), encode(after ?? prefix), limit + 1) as { key: string; value: string }[]
      const entries = rows.slice(0, limit).map(row => ({ key: row.key.slice(encode("").length), value: JSON.parse(row.value) }))
      return { entries, ...(rows.length > limit ? { next: entries.at(-1)!.key } : {}) }
    } }
  return { native, db, get, put, markKey, decision, form, part, storage, nativeGet, directory, finish,
    secrets: [cookie.id, registration.token],
    counts: () => replies, expire: () => { expired = true }, fail: (value = true) => { failReply = value }, lose: () => { loseReply = true }, defer: () => { complete = false },
    changeState: (status: string) => { state.status = status },
    submit: (human = true, answer = "Module", cookieID = cookie.id) => app.inject({ method: "POST", url: `/workspaces/workspace/instance/api/session/ses_child/form/${form.id}/reply`,
      headers: { cookie: `${auth.getCookieName()}=${encodeURIComponent(cookieID)}`, ...(human ? { "x-codenomad-human-answer": "1" } : {}) }, payload: { answer: { q0: answer } } }),
    dispose: async () => { await disposeBridge(); await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) } }
}

test("dock header writes a secret-free mark before native reply and gate accepts", async () => {
  const f = await fixture()
  try {
    assert.equal((await f.submit()).statusCode, 200)
    const mark = await f.native.verify(f.decision)
    assert.deepEqual(Object.keys(mark).sort(), ["answer", "answeredAt", "form", "formID", "sessionID", "via"])
    assert.equal(mark.via, "ui"); assert.equal(f.counts(), 1)
    assert.equal(mark.form.fields[0].type, "string")
    if (mark.form.fields[0].type === "string") assert.deepEqual(mark.form.fields[0].options, f.form.fields[0].options)
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM kv WHERE key LIKE '%recurrence-signer%'").get()!.count, 0)
    assert.equal(JSON.stringify(mark).includes("cookie"), false)
    assert.equal(JSON.stringify(mark).includes("signature"), false)
    for (const secret of f.secrets) assert.equal(JSON.stringify(mark).includes(secret), false)
  } finally { await f.dispose() }
})

test("Windows native SQL slash-separated session directories still bind the dock answer and gate", async () => {
  const f = await fixture()
  try {
    // Observed natively (2.0.26, hF44ln): session_v2 stores `/`, Location keeps host `\` separators.
    f.db.prepare("UPDATE session_v2 SET directory=?").run(f.directory.replaceAll("\\", "/"))
    assert.equal((await f.submit()).statusCode, 200)
    assert.equal(f.get(f.markKey)?.state, "confirmed")
    assert.equal((await f.native.verify(f.decision)).via, "ui")
  } finally { await f.dispose() }
})

test("the gate reads the durable message projection; an empty native event table (2.0.26 serve) still qualifies", async () => {
  const f = await fixture()
  try {
    assert.equal((await f.submit()).statusCode, 200)
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
    assert.equal((await f.submit()).statusCode, 200)
    delegate({ agent: "worker", description: "Decision", prompt: "Unrelated work" })
    await assert.rejects(control.report("ses_root", report()), /not this assignment/)
    delegate({ agent: "worker", description: "Decision", prompt: assignment, sessionID: "ses_child" })
    await assert.rejects(control.report("ses_root", report()), /not this assignment/, "a continuation is not a fresh assignment child")
    delegate({ agent: "worker", description: "Decision", prompt: `Context first.\n${assignment}` })
    await assert.rejects(control.report("ses_root", report({ ...provenance.nativeCall, parentSessionID: "ses_other" })), /invocation unavailable/)
    assert.equal((await control.report("ses_root", report())).disposition, "reported")
    assert.equal((await control.snapshot()).missions[0].tasks[0].status, "completed")
  } finally { await f.dispose() }
})

test("the same native answer without a human header produces no mark and gate refuses", async () => {
  const f = await fixture()
  try { assert.equal((await f.submit(false)).statusCode, 200); assert.equal(f.counts(), 1)
    assert.equal(f.get(f.markKey), undefined); await assert.rejects(f.native.verify(f.decision))
  } finally { await f.dispose() }
})

test("an ordinary conversation's dock answer is an ordinary native reply: no mark, never blocked", async () => {
  const f = await fixture()
  try { f.db.prepare("UPDATE session_v2 SET metadata='{}' WHERE id='ses_root'").run()
    assert.equal((await f.submit()).statusCode, 200); assert.equal(f.counts(), 1)
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
      f.fail(false); assert.equal((await f.submit(false)).statusCode, 200); assert.equal(f.counts(), 1)
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
      assert.equal((await f.submit()).statusCode, 200); assert.equal(f.get(f.markKey)?.state, "confirmed")
      assert.equal((await f.native.verify(f.decision)).via, "ui")
    } finally { await f.dispose() }
  })
}

test("answered mark survives native Form cache expiry and preserves verbatim free text and descriptions", async () => {
  const f = await fixture()
  try { const answer = "  A custom seam\nwith free text  "
    assert.equal((await f.submit(true, answer)).statusCode, 200); f.expire()
    const mark = await f.native.verify({ ...f.decision, answer })
    assert.equal(mark.answer.q0, answer); assert.equal(mark.form.fields[0].type, "string")
    if (mark.form.fields[0].type === "string") assert.equal(mark.form.fields[0].options?.[0].description, "Own the boundary")
  } finally { await f.dispose() }
})

test("native answer alone waits for exact completed question evidence", async () => {
  const f = await fixture()
  try { f.defer(); assert.equal((await f.submit()).statusCode, 200)
    await assert.rejects(f.native.verify(f.decision)); f.finish(); assert.equal((await f.native.verify(f.decision)).via, "ui")
  } finally { await f.dispose() }
})

test("a cached pending or cancelled Form refuses a mark even with completed native tool evidence", async () => {
  const f = await fixture()
  try { assert.equal((await f.submit()).statusCode, 200)
    for (const status of ["pending", "cancelled"]) { f.changeState(status); await assert.rejects(f.native.verify(f.decision)) }
  } finally { await f.dispose() }
})

test("the origin header without a live authenticated UI session cannot mint a mark", async () => {
  const f = await fixture()
  // The answer itself still goes through the ordinary native reply; it just never qualifies.
  try { assert.equal((await f.submit(true, "Module", "invalid-cookie")).statusCode, 200)
    assert.equal(f.get(f.markKey), undefined); assert.equal(f.counts(), 1)
    await assert.rejects(f.native.verify(f.decision))
  } finally { await f.dispose() }
})

test("recurring passage decisions use the same mark gate without recurrence ledger or signer lookups", async () => {
  const f = await fixture()
  try {
    f.db.prepare("UPDATE session_v2 SET metadata=? WHERE id='ses_root'").run(JSON.stringify({
      "codenomad.mission": { version: 1, kind: "coordinator", role: "coordinator", missionID: "msn_test", recurrence: { passageID: "passage" } } }))
    assert.equal((await f.submit()).statusCode, 200); f.expire()
    assert.equal((await f.native.verify(f.decision)).via, "ui")
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM kv").get()!.count, 1, "only the mark, no passage ledger or key")
  } finally { await f.dispose() }
})

test("gate refuses foreign Form/session/message/tool/field and provider-hosted execution", async () => {
  const f = await fixture()
  try { assert.equal((await f.submit()).statusCode, 200)
    for (const mutation of [{ sessionID: "ses_other" }, { formID: "frm_other" }, { messageID: "msg_other" },
      { toolCallID: "call_other" }, { fieldKey: "q1" }, { answer: "Other" }, { directory: "D:/foreign" }])
      await assert.rejects(f.native.verify({ ...f.decision, ...mutation }))
    f.part.executed = true
    f.db.prepare("UPDATE session_message SET data=? WHERE id='msg_question'").run(JSON.stringify({ content: [f.part] }))
    await assert.rejects(f.native.verify(f.decision))
  } finally { await f.dispose() }
})

test("one-time Wayfinder finalizes through the same dock mark without signing keys or passage ledger", async () => {
  const f = await fixture()
  try {
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
    assert.equal((await f.submit()).statusCode, 200); f.expire()
    assert.equal((await control.report("ses_root", report)).disposition, "reported")
    const current = (await control.snapshot()).missions[0]
    await journal.append({ version: 1, id: "decision_returned", type: "task.native-returned", missionID: mission.id, projectID: "project", createdAt: current.updatedAt + 1,
      taskKey: "decision", childSessionID: "ses_child", binding: f.decision.nativeCall })
    assert.equal((await control.report("ses_root", { ...report, final: true })).disposition, "finished")
  } finally { await f.dispose() }
})
