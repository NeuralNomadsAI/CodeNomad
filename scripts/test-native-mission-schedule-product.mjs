// PREPARED ONLY: build/run after the parent's explicit integrated final-ready message.
// node --import tsx scripts/test-native-mission-schedule-product.mjs <cli> <fresh-scratch> --parent-ready --kinds=at,in
// --kinds=every --natural-every uses the real >=15-minute product interval.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

const { positionals: [cli, scratch], values } = parseArgs({ allowPositionals: true, options: {
  "parent-ready": { type: "boolean" }, kinds: { type: "string", default: "at,in" }, "natural-every": { type: "boolean" },
  "delay-ms": { type: "string", default: "30000" }, "grace-ms": { type: "string", default: "45000" },
  "controlled-settlement": { type: "boolean" },
  "arm-only": { type: "boolean" },
  "first-admission-race": { type: "boolean" }, "crash-pending": { type: "boolean" },
  live: { type: "boolean" },
  "diagnose-stop": { type: "boolean" },
  "diagnose-product-stop": { type: "boolean" },
} })
assert(values["parent-ready"], "Wait for the parent's explicit final-ready message, then pass --parent-ready")
assert(cli && scratch && path.isAbsolute(cli) && path.isAbsolute(scratch) && !existsSync(scratch), "Absolute CLI and fresh approved scratch child required")
const approved = ["impl/core/product-native", "impl/fix-core/native", "impl/fix-core-2/native", "impl/adopt-223/native"].map(part => path.resolve(process.env.LOCALAPPDATA, `codenomad-agent-scratch/issue-926/${part}`))
assert(approved.some(base => { const relative = path.relative(base, path.resolve(scratch)); return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }), "Use an approved native scratch child")
const kinds = values.kinds.split(","), delayMs = Number(values["delay-ms"]), graceMs = Number(values["grace-ms"])
const controlsKinds = ["paused-manual", "stop-pending", "flag-off-pause", "stop-preparing", "delete-preparing"]
assert(kinds.length && new Set(kinds).size === kinds.length && kinds.every(kind => ["at", "in", "every", ...controlsKinds].includes(kind)))
assert(!kinds.some(kind => controlsKinds.includes(kind)) || values["controlled-settlement"], "Control journeys require the explicit native Clock observer")
assert(!kinds.some(kind => controlsKinds.includes(kind)) || !values.live && !values["crash-pending"] && !values["first-admission-race"] && !values["arm-only"], "Use separate runs for control journeys and baseline mode flags")
assert(Number.isSafeInteger(delayMs) && delayMs >= 6000 && delayMs <= 120000)
assert(Number.isSafeInteger(graceMs) && graceMs >= 10000 && graceMs <= 180000)
assert(!kinds.includes("every") || values["natural-every"], "Natural every requires --natural-every and a real 900000 ms wait")
assert(!values["first-admission-race"] || !values["crash-pending"], "Use separate fresh runs for race and crash")
assert(!values["arm-only"] || !values["first-admission-race"] && !values["crash-pending"])
assert(!values["diagnose-stop"] || kinds.length === 1 && kinds[0] === "stop-pending", "The narrow diagnostic owns one Stop-pending case only")
assert(!values["diagnose-product-stop"] || kinds.length === 1 && kinds[0] === "stop-pending" && !values["diagnose-stop"], "The product-context trace owns one separate Stop-pending case")
await mkdir(scratch, { recursive: true })
const originalEnvironment = { ...process.env }, hash = bytes => createHash("sha256").update(bytes).digest("hex")
const receipt = { preparedContract: 1, cliSHA256: hash(await readFile(cli)), kinds, cases: [], outcome: "running", gates: [
  "No deterministic lost-ACK/admission-before-count fault injection in this natural fixture",
  "Concurrent replay qualifies dedupe of an actual admitted wake, not simultaneous first dispatch",
  "Paused-before-Play has no native wake to replay; its cold no-admission assertion is separate",
] }

// Managed sibling of native-product-fixture.mjs: that helper's standalone
// process has no registration/restart contract. Never share its live DB with a
// second process. This driver keeps the same private-root/local-provider policy.
async function journey(kind) {
  const root = path.join(scratch, kind), project = path.join(root, "project"), databaseFile = path.join(root, "fixture.db")
  await mkdir(project, { recursive: true })
  const env = Object.fromEntries(Object.entries(originalEnvironment).filter(([key]) => /^(SystemRoot|WINDIR|ComSpec|PATHEXT|PATH)$/i.test(key)))
  Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"),
    ProgramData: path.join(root, "ProgramData"), TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"),
    OPENCODE_TEST_HOME: root, OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: databaseFile,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
    npm_config_userconfig: path.join(root, ".npmrc"), npm_config_globalconfig: path.join(root, "global.npmrc"), npm_config_cache: path.join(root, "npm-cache") })
  for (const name of ["CONFIG", "DATA", "STATE", "CACHE"]) env[`XDG_${name}_HOME`] = path.join(root, `xdg-${name.toLowerCase()}`)
  env.XDG_RUNTIME_DIR = path.join(root, "runtime")
  for (const [name, directory] of Object.entries(env)) if (/^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|TEMP|TMP|OPENCODE_CONFIG_DIR|XDG_.*)$/.test(name)) await mkdir(directory, { recursive: true })
  for (const name of Object.keys(process.env)) if (/^(OPENCODE_|CODENOMAD_|XDG_|WSL_|npm_config_|GIT_)/i.test(name)) delete process.env[name]
  Object.assign(process.env, env)
  process.env.CLI_CONFIG = path.join(root, "profile.yaml")
  const [{ default: Fastify }, { default: pino }, { OpenCode }, { Service },
    { WorkspaceManager }, { EventBus }, { rememberRuntime }, { DesktopPluginLifecycle }, { resolveDesktopPluginPaths },
    { createAutomationBridgeRegistration, publishAutomationBridge }, { registerAutomationPluginRoute }, { registerMissionRoutes },
    { WorktreeDeletionFence }, { PluginControls }, { NativeScheduleSettingsActivation }, { missionDocumentPassage },
    { NativeScheduleTransportRpc, nativeScheduleWakeKey }, { readNativeScheduleIncarnation }, { nativeScheduleCarrierLookupKey }, experimentalEditor] = await Promise.all([
    import("fastify"), import("pino"), import("@opencode/client"), import("@opencode/client/service"),
    import("../packages/server/src/workspaces/manager.ts"), import("../packages/server/src/events/bus.ts"),
    import("../packages/server/src/opencode/compatibility/runtime.ts"), import("../packages/server/src/opencode/desktop-plugin-lifecycle.ts"),
    import("../packages/server/src/opencode/desktop-plugin-paths.ts"), import("../packages/server/src/opencode/automation-plugin.ts"),
    import("../packages/server/src/server/routes/automation-plugin.ts"), import("../packages/server/src/server/routes/missions.ts"),
    import("../packages/server/src/workspaces/worktree-session-evacuation.ts"), import("../packages/server/src/opencode/plugin-controls.ts"),
    import("../packages/server/src/opencode/native-schedule-settings-activation.ts"), import("../packages/server/src/missions/mission-document-passage-storage.ts"),
    import("../packages/server/src/opencode/missions/native-schedule-transport-contract.ts"), import("../packages/server/src/opencode/missions/native-schedule-transport-identity.ts"),
    import("../packages/server/src/opencode/missions/native-schedule-carrier-binding.ts"),
    import("../packages/server/src/opencode/native-experimental-settings.ts"),
  ])
  const bundled = new URL("../packages/server/dist/plugins/missions/plugin.mjs", import.meta.url)
  const providerBundle = new URL("../packages/server/dist/plugins/missions/provider.mjs", import.meta.url)
  const result = { kind, root, status: "running", armOnly: !!values["arm-only"], firstAdmissionRaceMode: !!values["first-admission-race"], crashPendingMode: !!values["crash-pending"], productBundleSHA256: hash(await readFile(bundled)), providerBundleSHA256: hash(await readFile(providerBundle)), serviceStarts: [], http: [] }
  if (values["diagnose-stop"]) assert.equal(result.productBundleSHA256, "3578b0357396e1834221a0f37159a8fe2d6a8a63f81fcad11b3d364b1dca0c10", "Diagnostic requires the unchanged failing qualification bundle")
  receipt.cases.push(result)
  const prefix = `plugin:${Array.from("codenomad.missions").map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`
  const registrationFile = path.join(env.XDG_STATE_HOME, "opencode/service.json"), children = [], releases = new Set()
  const maintenanceLog = path.join(root, "maintenance-events.jsonl")
  let ownedTechnical = []
  let controlTrace
  let child, client, endpoint, manager, app, plugin, removeBridge, baseURL, workspace, providerError, holdBusiness = true
  const calls = [], reported = new Set(), providerOpen = new Set(), secrets = new Set(["fixture-only"])
  const barrierToken = randomUUID(); secrets.add(barrierToken)
  let heldOriginal, pendingHandoff, releaseOriginal, barrierDone = false
  const releaseBarrier = reason => { if (heldOriginal && !heldOriginal.releasedAt) { heldOriginal.releasedAt = Date.now(); heldOriginal.releaseReason = reason }; releaseOriginal?.() }
  const barrier = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || !["/original", "/pending"].includes(request.url) || request.headers["x-fixture-barrier"] !== barrierToken) return response.writeHead(403).end()
      let raw = ""; for await (const bytes of request) { raw += bytes; if (raw.length > 32768) throw Error("barrier-input-bound") }
      const input = JSON.parse(raw)
      assert.equal(input.document?.missionID, result.documentID)
      assert.equal(input.request?.registrationFile, registrationFile); assert.equal(input.request?.incarnation?.pid, child.pid)
      assert.equal(input.request?.wake?.missionID, result.documentID)
      assert(!input.sessionID.startsWith("ses_cn_schedule_"), "Only the original business admission may be held")
      if (request.url === "/pending") { pendingHandoff = { ...input, enteredAt: Date.now() }; return response.writeHead(200, { "content-type": "application/json" }).end('{"observed":true}') }
      if (barrierDone) return response.writeHead(200, { "content-type": "application/json" }).end('{"resume":true,"alreadyReleased":true}')
      assert(!heldOriginal, "Only one original admission barrier is allowed")
      heldOriginal = { ...input, enteredAt: Date.now(), releasedAt: null }; barrierDone = true
      const timer = setTimeout(() => releaseBarrier("barrier-budget-expired"), 6000)
      response.once("close", () => releaseBarrier(heldOriginal?.releasedAt ? heldOriginal.releaseReason : "barrier-client-aborted"))
      try { await new Promise(resolve => { releaseOriginal = resolve }) } finally { clearTimeout(timer) }
      if (!response.destroyed) response.writeHead(200, { "content-type": "application/json" }).end('{"resume":true}')
    } catch { providerError = "fixture-original-barrier-contract"; if (!response.destroyed) response.writeHead(400).end() }
  })
  const provider = createServer(async (request, response) => {
    let callRecord
    providerOpen.add(response)
    try {
      let raw = ""; for await (const bytes of request) { raw += bytes; if (raw.length > 2 * 1024 * 1024) throw Error("provider-input-bound") }
      const input = JSON.parse(raw), sessionID = request.headers["x-fixture-session"]
      assert.equal(request.headers["x-fixture-kind"], "primary", "A technical/auxiliary turn reached the business provider")
      assert.equal(typeof sessionID, "string")
      const tools = (input.tools ?? []).map(tool => tool.function?.name), first = !reported.has(sessionID)
      if (first) assert(tools.includes("mission_report"), "Actual native mission_report tool unavailable")
      callRecord = { sessionID, first, at: Date.now() }; calls.push(callRecord)
      if (holdBusiness) await new Promise(resolve => { releases.add(resolve); response.once("close", resolve) })
      if (response.destroyed) { callRecord.closedBeforeResponse = true; return }
      const call = { index: 0, id: `fixture_${randomUUID().replaceAll("-", "")}`, type: "function", function: { name: "mission_report",
        arguments: JSON.stringify({ outcome: "completed", summary: "Owned native product passage completed", final: true }) } }
      reported.add(sessionID)
      callRecord.reportStreamed = first
      response.writeHead(200, { "content-type": "text/event-stream" })
      for (const [delta, finish_reason] of [[first ? { role: "assistant", tool_calls: [call] } : { role: "assistant", content: "Done" }, null], [{}, first ? "tool_calls" : "stop"]])
        response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      response.end("data: [DONE]\n\n")
    } catch { providerError = "fixture-provider-contract"; if (!response.destroyed) { response.writeHead(400, { "content-type": "application/json" }); response.end('{"error":{"type":"invalid_request_error","message":"fixture-provider-contract"}}') } }
    finally { providerOpen.delete(response) }
  })
  const save = (name, value) => writeFile(path.join(root, `${name}.json`), JSON.stringify(value, null, 2))
  const readSQL = use => {
    const db = new DatabaseSync(databaseFile, { readOnly: true })
    try { db.exec("BEGIN"); const value = use(db); db.exec("COMMIT"); return value } finally { db.close() }
  }
  const readOnlyStorage = { get: async key => readSQL(db => { const row = db.prepare("SELECT value FROM kv WHERE key=?").get(`${prefix}${key}`); return row && JSON.parse(row.value) }),
    scan: async ({ prefix: key, after, limit = 100 }) => readSQL(db => {
      const entries = db.prepare("SELECT key,value FROM kv WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?").all(`${prefix}${key}`, `${prefix}${key}\uffff`, `${prefix}${after ?? ""}`, limit)
        .map(row => ({ key: row.key.slice(prefix.length), value: JSON.parse(row.value) }))
      return { entries, ...(entries.length === limit ? { next: entries.at(-1).key } : {}) }
    }), set: async () => { throw Error("qualification-read-only") } }
  const document = (db, id) => {
    const rows = db.prepare("SELECT value FROM kv WHERE instr(key,?)=1 AND instr(key,'/project/')>0 AND json_extract(value,'$.id')=? LIMIT 2")
      .all(`${prefix}codenomad-missions/documents-v1/`, id)
    assert.equal(rows.length, 1, "Exact unified document unavailable")
    assert(Buffer.byteLength(rows[0].value) <= 256 * 1024)
    return JSON.parse(rows[0].value)
  }
  const snapshot = id => readSQL(db => {
    const doc = document(db, id), passage = doc.pending ?? doc.history?.at(-1)
    const start = passage ? db.prepare("SELECT id,type FROM session_message WHERE session_id=? AND type IN ('user','synthetic') ORDER BY seq LIMIT 16").all(passage.coordinatorSessionID) : []
    const sessions = db.prepare("SELECT id,parent_id,metadata,time_suspended FROM session_v2 WHERE json_extract(metadata,'$.\"codenomad.mission\".document.missionID')=? LIMIT 16").all(id)
    const schedules = (doc.calendarOwner?.slots ?? []).filter(slot => slot.scheduleID).map(slot => ({ role: slot.role,
      ...db.prepare('SELECT id,session_id,status,next_due_at,run_count,time_created,"when" AS native_when FROM schedule WHERE id=?').get(slot.scheduleID) }))
    const startDetails = passage ? db.prepare("SELECT id,type,data FROM session_message WHERE session_id=? AND type IN ('user','synthetic') ORDER BY seq LIMIT 64").all(passage.coordinatorSessionID)
      .map(row => { const data = JSON.parse(row.data); return { id: row.id, type: row.type, textSHA256: hash(data.text ?? ""),
        metadataKeys: Object.keys(data.metadata ?? {}), missionDocument: data.metadata?.["codenomad.mission"]?.document,
        description: typeof data.description === "string" && /^[A-Za-z0-9 .,:_-]{1,128}$/.test(data.description) ? data.description : undefined } }) : []
    return { document: doc, start, startDetails, sessions: sessions.map(({ id, parent_id }) => ({ id, parent_id })),
      claims: sessions.map(({ id, time_suspended }) => ({ id, time_suspended })),
      inboxCount: passage ? db.prepare("SELECT count(*) AS count FROM session_inbox WHERE session_id=?").get(passage.coordinatorSessionID).count : 0, schedules }
  })
  const technicalRows = () => readSQL(db => ownedTechnical.map(item => {
    const session = db.prepare("SELECT time_suspended FROM session_v2 WHERE id=?").get(item.sessionID)
    return { ...item, sessionPresent: !!session, nativeClaim: session?.time_suspended,
      inboxCount: db.prepare("SELECT count(*) AS count FROM session_inbox WHERE session_id=?").get(item.sessionID).count,
      schedulePresent: !!db.prepare("SELECT 1 FROM schedule WHERE id=?").get(item.scheduleID), reverseIndexPresent: !!db.prepare("SELECT 1 FROM kv WHERE key=?").get(item.lookupKey) }
  }))
  const learnTechnical = state => {
    const location = { project: { id: state.document.projectID, canonical: state.document.projectCanonical } }
    ownedTechnical = state.document.calendarOwner.slots.map(slot => ({ role: slot.role, sessionID: slot.sessionID, scheduleID: slot.scheduleID,
      lookupKey: `${prefix}${nativeScheduleCarrierLookupKey({ location }, slot.sessionID)}` }))
  }
  const maintenanceEvents = async () => {
    const bytes = await readFile(maintenanceLog).catch(error => { if (error.code !== "ENOENT") throw error; return Buffer.alloc(0) })
    assert(bytes.length <= 1024 * 1024, "Qualification maintenance evidence overflow")
    const events = bytes.toString("utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    assert(!events.some(event => event.kind === "observer-overflow"))
    return events
  }
  const until = async (check, timeout = graceMs) => {
    for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
      if (providerError) throw Error(providerError)
      const value = await check(); if (value) return value
      assert(!child || child.exitCode === null, "Owned native process exited")
      await delay(100)
    }
    throw Error("bounded-product-qualification-deadline")
  }
  const launch = async (cold = false) => {
    assert(!child || child.exitCode !== null || child.signalCode !== null, "Never run two service incarnations against this DB")
    child = spawn(cli, ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    const current = { child, closed: new Promise(resolve => child.once("close", resolve)) }; children.push(current)
    child.stdout.resume(); child.stderr.resume()
    const publicInfo = await until(async () => {
      try { const info = readNativeScheduleIncarnation(registrationFile); return info.pid === child.pid ? info : false } catch { return false }
    }, 40000)
    assert.notEqual(new URL(publicInfo.url).port, "28894")
    result.serviceStarts.push({ ...publicInfo, cold, at: Date.now() })
    client = undefined; endpoint = undefined
    if (!cold) await connect()
  }
  const connect = async signal => {
    signal?.throwIfAborted()
    endpoint = await Service.discover({ file: registrationFile })
    signal?.throwIfAborted()
    assert(endpoint && endpoint.url === readNativeScheduleIncarnation(registrationFile).url)
    client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    if (endpoint.auth?.password) { secrets.add(endpoint.auth.password); secrets.add(Buffer.from(`${endpoint.auth.username}:${endpoint.auth.password}`).toString("base64")) }
    const info = await client.server.info({ signal }); assert.equal(info.version, "2.2.3"); assert.equal(info.pid, child.pid)
    rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  }
  const stop = async () => {
    const owned = children.find(entry => entry.child === child)
    if (owned && child.exitCode === null && child.signalCode === null) await stopFixtureChild(child, owned.closed)
    client = undefined; endpoint = undefined
  }
  const yaml = path.join(root, "profile.yaml"), human = { sessionId: randomUUID(), username: "fixture-human" }
  const scope = { channel: "native-fixture", configIdentity: yaml, key: hash(`native-fixture\0${yaml}`) }
  const settings = { getProfileScope: () => scope, configYamlPathForAuthority: () => yaml, getOwner: () => ({ environmentVariables: {} }), readEnvironmentForAdmission: async () => ({}) }
  const cookie = `session=${human.sessionId}`, auth = { isAuthEnabled: () => true,
    isLoopbackRequest: request => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip), getCookieName: () => "session",
    getSessionFromHeaders: headers => headers.cookie === cookie ? human : null, getSessionFromRequest: request => request.headers.cookie === cookie ? human : null }
  secrets.add(cookie); secrets.add(human.sessionId)
  const closeBackend = async () => {
    await plugin?.stop(); plugin = undefined
    await removeBridge?.(); removeBridge = undefined
    await app?.close(); app = undefined
    await manager?.shutdown(); manager = undefined
    client = undefined; endpoint = undefined
  }
  const http = async (suffix, payload, allowPending = false) => {
    const response = await fetch(`${baseURL}/api/workspaces/${workspace.id}/missions${suffix}`, { method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(95_000) })
    const raw = await response.text()
    let body
    try { body = JSON.parse(raw) } catch { throw Error(`Product HTTP ${response.status}: non-json-response`) }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Error(`Product HTTP ${response.status}: non-object-response`)
    const code = typeof body.code === "string" && /^[a-z0-9-]{1,80}$/.test(body.code) ? body.code : undefined
    result.http.push({ suffix, action: payload.action ?? "activate", requestID: payload.requestID,
      expectedRevision: payload.expectedRevision ?? payload.expectedDocumentRevision, status: response.status, ...(code ? { code } : {}), pending: body.pending,
      document: body.document && { id: body.document.id, revision: body.document.revision, state: body.document.state,
        launchedCount: body.document.launchedCount, pending: body.document.pending, activation: body.document.scheduleActivation?.state } })
    assert(response.status === 200 || allowPending && response.status === 503 && body.pending === true, `Product HTTP ${response.status}: ${code ?? "unconfirmed"}`)
    return body
  }
  const create = async (label, timing, maxLaunches = 1) => {
    const selected = { agent: "fixture-worker", model: { providerID: "fixture", id: "fixture" } }
    const response = await http("/scheduled", { requestID: `create_${label}_${randomUUID().replaceAll("-", "")}`, expectedRevision: 0, action: "create", configuration: {
      title: `Native ${label}`, objective: "Use the actual mission_report tool to finalize this owned fixture passage. No helpers or other effects.",
      template: "custom", taskMode: "native", profiles: { coordinator: selected, roles: { specialist: selected } }, watchedConversationIDs: [],
      launch: { timing, condition: null, ends: { at: null, afterMs: null, maxLaunches } },
    } })
    assert.equal(response.document.state, "paused"); assert.equal(response.document.launchedCount, 0)
    return response.document.id
  }
  const activate = async id => {
    const before = snapshot(id).document
    const activation = await http(`/${id}/schedule-settings`, { requestID: `activate_${randomUUID().replaceAll("-", "")}`, expectedDocumentRevision: before.revision })
    assert.equal(activation.document.scheduleActivation.state, "ready"); assert.equal(activation.document.state, "paused")
  }
  const control = async (id, action, options = {}) => http(`/${id}/schedule`, { requestID: `${action}_${randomUUID().replaceAll("-", "")}`, expectedRevision: snapshot(id).document.revision, action,
    ...(action === "delete" ? { deleteManagedSessions: false } : {}) }, options.allowPending)
  try {
    await writeFile(yaml, "server:\n  environmentVariables: {}\n")
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve)); assert.notEqual(provider.address().port, 28894)
    if (values["first-admission-race"]) { await new Promise(resolve => barrier.listen(0, "127.0.0.1", resolve)); assert.notEqual(barrier.address().port, 28894) }
    const observer = path.join(root, "provider-observer"); await mkdir(observer)
    await writeFile(path.join(observer, "package.json"), JSON.stringify({ name: "codenomad-product-provider-observer", type: "module", exports: { ".": "./index.mjs" } }))
    await writeFile(path.join(observer, "index.mjs"), `import {Plugin,Rpc} from "@opencode/plugin/effect";
import {Effect,Stream,Scope} from "effect";import {appendFileSync} from "node:fs";
const file=${JSON.stringify(maintenanceLog)},key=Symbol.for("codenomad.product-qualification.maintenance-observer");
const method="/api/rpc/codenomad.missions.schedule-maintenance/reconcile",wakeMethod="/api/rpc/codenomad.missions.schedule/wake";
export default Plugin.define({id:"codenomad.product-provider-observer",effect:ctx=>Effect.gen(function*(){
 const ownerScope=yield*Scope.Scope;
 let state=globalThis[key];if(!state){
  state={refs:0,count:0,request:0,original:globalThis.fetch,wakes:new Map(),raced:new Set(),handoffs:new Set()};
  state.log=event=>{if(state.count++>512)return;appendFileSync(file,JSON.stringify(state.count===513?{kind:"observer-overflow"}:{...event,at:Date.now(),pid:process.pid})+"\\n")};
  state.wrapper=new Proxy(state.original,{apply(target,thisArg,args){
   const [input,init]=args;let match=false;try{const url=new URL(input instanceof Request?input.url:String(input));const own=["127.0.0.1","localhost","[::1]"].includes(url.hostname)&&(init?.method??input?.method)==="POST";
    if(own&&url.pathname===wakeMethod&&typeof init?.body==="string"&&init.body.length<=32768){const body=JSON.parse(init.body);if(typeof body.input?.wake?.missionID==="string"&&state.wakes.size<32){state.wakes.set(body.input.wake.missionID,structuredClone(body.input));state.log({kind:"genuine-wake-captured",missionID:body.input.wake.missionID,sessionID:body.input.wake.sessionID})}}
    match=own&&url.pathname===method}catch{}
   if(!match)return Reflect.apply(target,thisArg,args);
   let sessionID;try{if(typeof init?.body==="string"&&init.body.length<=32768){const body=JSON.parse(init.body);if(typeof body.input?.sessionID==="string"&&/^[A-Za-z0-9_.:-]{1,240}$/.test(body.input.sessionID))sessionID=body.input.sessionID}}catch{}
   const requestID=++state.request;state.log({kind:"maintenance-http-request",requestID,sessionID});
   return Promise.resolve(Reflect.apply(target,thisArg,args)).then(response=>{state.log({kind:"maintenance-http-response",requestID,sessionID,status:response.status});return response},error=>{state.log({kind:"maintenance-http-error",requestID,sessionID});throw error});
  }});globalThis.fetch=state.wrapper;globalThis[key]=state;
 }
  state.refs++;yield*Effect.addFinalizer(()=>Effect.sync(()=>{if(--state.refs===0){if(globalThis.fetch===state.wrapper)globalThis.fetch=state.original;if(globalThis[key]===state)delete globalThis[key]}}));
  state.log({kind:"observer-setup",raceConfigured:!!ctx.options.raceBarrier});
  if(ctx.options.raceBarrier)yield*ctx.session.hook("prompt",event=>Effect.gen(function*(){
   state.log({kind:"prompt-observed",sessionID:event.sessionID,messageID:event.messageID,metadataKeys:Object.keys(event.metadata??{})});
   const document=event.metadata?.["codenomad.mission"]?.document;
   if(!document||state.raced.has(event.messageID))return;
   if(event.sessionID.startsWith("ses_cn_schedule_"))throw Error("fixture-barrier-technical-session");
   const request=state.wakes.get(document.missionID);if(!request)throw Error("fixture-barrier-original-wake-unavailable");
   state.raced.add(event.messageID);state.log({kind:"original-admission-held",sessionID:event.sessionID,messageID:event.messageID});
   yield*Effect.tryPromise({try:async signal=>{const response=await Reflect.apply(state.original,globalThis,[ctx.options.raceBarrier.url,{method:"POST",headers:{"content-type":"application/json","x-fixture-barrier":ctx.options.raceBarrier.token},body:JSON.stringify({document,sessionID:event.sessionID,messageID:event.messageID,request}),signal:AbortSignal.any([signal,AbortSignal.timeout(6500)])}]);if(!response.ok)throw Error("fixture-barrier-refused");await response.json()},catch:()=>Error("fixture-original-barrier-failed")}).pipe(Effect.orDie);
  }));
  yield*ctx.session.hook("http.request",event=>Effect.gen(function*(){
   event.request.headers.set("x-fixture-kind",event.kind);event.request.headers.set("x-fixture-session",event.sessionID);
   if(ctx.options.raceBarrier&&event.kind==="primary"&&!event.sessionID.startsWith("ses_cn_schedule_")&&!state.handoffs.has(event.sessionID)){
    const request=[...state.wakes.values()].at(-1);if(!request)throw Error("fixture-pending-wake-unavailable");state.handoffs.add(event.sessionID);
    yield*Effect.tryPromise({try:async signal=>{const response=await Reflect.apply(state.original,globalThis,[ctx.options.raceBarrier.url.replace(/original$/,"pending"),{method:"POST",headers:{"content-type":"application/json","x-fixture-barrier":ctx.options.raceBarrier.token},body:JSON.stringify({document:{missionID:request.wake.missionID},sessionID:event.sessionID,request}),signal}]);if(!response.ok)throw Error("fixture-pending-handoff-refused");await response.json()},catch:()=>Error("fixture-pending-handoff-failed")}).pipe(Effect.orDie);
   }
  }));
  const preparingRpc=Rpc.define({id:"codenomad.product-qualification",methods:{armPreparing:{input:{type:"object"},output:{type:"object"}}},events:{}});
  yield*ctx.rpc.register(preparingRpc,{armPreparing:raw=>Effect.gen(function*(){
   const target=raw,session=yield*ctx.session.get({sessionID:target.sessionID}),marker=session.metadata?.["codenomad.schedule-carrier"];
   const url=new URL(target.url);if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||url.pathname!=="/hold-preparing"||url.port==="28894"||url.username||url.password||url.search||url.hash||marker?.missionID!==target.missionID||marker.role!=="principal")throw Error("fixture-preparing-target");
   let used=false;yield*ctx.session.hook("prompt",event=>Effect.gen(function*(){
    if(used||event.sessionID!==target.sessionID)return;used=true;const schedule=event.metadata?.schedule;
    if(typeof schedule?.id!=="string"||event.messageID!=="msg_"+schedule.id+"_"+schedule.run)throw Error("fixture-preparing-wake");
    yield*Effect.tryPromise({try:async signal=>{const response=await Reflect.apply(state.original,globalThis,[url.href,{method:"POST",headers:{"content-type":"application/json","x-fixture-barrier":target.token},body:JSON.stringify({sessionID:event.sessionID,messageID:event.messageID,schedule}),signal:AbortSignal.any([signal,AbortSignal.timeout(6500)])}]);if(!response.ok)throw Error("fixture-preparing-refused");await response.json()},catch:()=>Error("fixture-preparing-aborted")}).pipe(Effect.orDie);
   })).pipe(Effect.provideService(Scope.Scope,ownerScope));return{armed:true,sessionID:target.sessionID};
  })});
  yield*ctx.event.subscribe({types:["session.execution.started","session.execution.succeeded","session.execution.failed","session.execution.interrupted"]}).pipe(Stream.runForEach(event=>Effect.sync(()=>{if(typeof event.data?.sessionID==="string")state.log({kind:event.type==="session.execution.started"?"execution-started":"terminal",type:event.type,sessionID:event.data.sessionID,nativeCreatedAt:typeof event.created==="number"?event.created:undefined})})),Effect.forkScoped);
})});`)
    const extraPlugins = [values["first-admission-race"] ? { package: observer, options: { raceBarrier: { url: `http://127.0.0.1:${barrier.address().port}/original`, token: barrierToken } } } : observer]
    if (values["diagnose-product-stop"]) {
      const { buildControlTraceBundle } = await import("./native-mission-schedule-control-trace.mjs")
      controlTrace = await buildControlTraceBundle(root, registrationFile, [...secrets])
      result.originalProductBundleSHA256 = result.productBundleSHA256
      result.diagnosticVariant = controlTrace; result.loadedRuntimeKind = "scratch-control-trace-not-final-product"
    }
    if (values["diagnose-stop"]) {
      const { buildStopDiagnosticPlugin } = await import("./native-mission-schedule-stop-diagnostic.mjs")
      const diagnostic = await buildStopDiagnosticPlugin(root)
      result.diagnosticSourceSHA256 = diagnostic.sourceSHA256; extraPlugins.push(diagnostic.directory)
    }
    if (values["controlled-settlement"]) {
      const [{ build }, { nativePluginBuild }] = await Promise.all([import("esbuild"), import("../packages/server/scripts/native-plugin-build.mjs")])
      const clock = path.join(root, "clock-observer"); await mkdir(clock)
      await build({ ...nativePluginBuild, entryPoints: [fileURLToPath(new URL("../packages/server/src/opencode/missions/native-schedule-carrier-clock-fixture.ts", import.meta.url))], outfile: path.join(clock, "index.mjs") })
      await writeFile(path.join(clock, "package.json"), JSON.stringify({ name: "codenomad-product-clock-qualification", type: "module", exports: { ".": "./index.mjs" } })); extraPlugins.push(clock)
    }
    const configuration = { update: "disable", snapshots: false, experimental: { schedules: true }, permissions: [{ action: "*", resource: "*", effect: "allow" }],
      plugins: extraPlugins, model: "fixture/fixture", agents: { "fixture-worker": { mode: "all", description: "Owned native product coordinator" }, title: { model: "fixture/fixture" }, compaction: { model: "fixture/fixture" } },
      providers: { fixture: { activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" }, models: { fixture: { limit: { context: 32000, output: 4096 } } } } } }
    assert(!("codenomad-missions-local" in configuration.providers))
    await writeFile(path.join(env.OPENCODE_CONFIG_DIR, "opencode.json"), JSON.stringify(configuration))
    await writeFile(path.join(env.XDG_CONFIG_HOME, "opencode", "service.json"), JSON.stringify({ hostname: "127.0.0.1", port: 0, disabled: false })).catch(async error => {
      if (error.code !== "ENOENT") throw error
      await mkdir(path.join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true }); await writeFile(path.join(env.XDG_CONFIG_HOME, "opencode/service.json"), '{"hostname":"127.0.0.1","port":0,"disabled":false}')
    })
    await launch()
    manager = new WorkspaceManager({ rootDir: root, logger: pino({ level: "silent" }), eventBus: new EventBus(), settings,
      binaryResolver: { resolveDefault: () => ({ path: cli, label: "Owned scheduled product fixture" }) },
      hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }) })
    workspace = (await manager.create(project)).workspace
    const connection = await manager.getSharedServiceConnection(workspace.id), paths = await resolveDesktopPluginPaths(connection, { kind: "host", platform: process.platform, binary: cli })
    assert(path.relative(root, paths.config) && !path.relative(root, paths.config).startsWith(".."))
    const fence = new WorktreeDeletionFence(), registration = createAutomationBridgeRegistration("http://127.0.0.1:1")
    secrets.add(registration.token)
    app = Fastify(); app.addHook("preHandler", (request, reply, done) => {
      if (request.url.startsWith("/api/workspaces/") && !auth.getSessionFromRequest(request)) return reply.code(401).send({ code: "fixture-human-required" })
      done()
    })
    const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: fence, logger: pino({ level: "silent" }) })
    app.post("/fixture/native-schedules", async (request, reply) => {
      if (!auth.getSessionFromRequest(request) || typeof request.body?.enabled !== "boolean") return reply.code(403).send({ code: "fixture-config-refused" })
      try {
        await controls.editConfigDocuments(workspace.id, { directory: project }, view => {
          const target = view.documents.find(item => item.scope === "global"), relative = target && path.relative(root, target.document.writePath)
          assert(target && relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
          return [{ scope: "global", path: target.path, expectation: experimentalEditor.nativeSettingExpectation(target.document),
            updated: experimentalEditor.editMissionExperimental(target.document, "schedules", request.body.enabled,
              experimentalEditor.inheritedMissionExperimental(view.entries, target.path, view.location.directory), "global") }]
        }, { beforeWrite: async () => {}, afterWrite: async () => {} })
        return { enabled: request.body.enabled }
      } catch { return reply.code(503).send({ code: "fixture-config-unconfirmed" }) }
    })
    registerMissionRoutes(app, { workspaceManager: manager, worktreeDeletionFence: fence, auth, settings, bridgeToken: registration.token,
      scheduleSettingsActivation: new NativeScheduleSettingsActivation(controls, manager) })
    registerAutomationPluginRoute(app, { workspaceManager: manager, worktreeDeletionFence: fence, authManager: auth, settings, bridgeToken: registration.token, nativeParent: {}, developerCdp: {} })
    await app.listen({ host: "127.0.0.1", port: 0 }); baseURL = `http://127.0.0.1:${app.server.address().port}`; assert.notEqual(app.server.address().port, 28894)
    registration.url = `${baseURL}/api/opencode-plugin/automation`; removeBridge = await publishAutomationBridge(registration)
    plugin = controlTrace ? new DesktopPluginLifecycle("missions", () => readFile(controlTrace.file)) : new DesktopPluginLifecycle("missions"); await plugin.start(paths)
    await until(async () => (await client.plugin.list({ location: { directory: project } })).data.some(item => item.id === "codenomad.missions" && item.state.status === "active"))
    if (controlsKinds.includes(kind)) {
      const { runProductControlJourney } = await import("./native-mission-schedule-product-controls.mjs")
      await runProductControlJourney(kind, { result, project, delayMs, create, activate, control, snapshot, save, until, readSQL,
        diagnoseStop: !!values["diagnose-stop"],
        controlTrace,
        technicalRows, learnTechnical, maintenanceEvents, client: () => client, calls, providerOpen: () => providerOpen.size,
        reported: id => reported.has(id), secret: value => secrets.add(value), hold: enabled => { holdBusiness = enabled; if (!enabled) { for (const release of releases) release(); releases.clear() } },
        business: doc => missionDocumentPassage(readOnlyStorage, doc, () => true).journal.snapshot(),
        nativeFlag: async enabled => {
          const response = await fetch(`${baseURL}/fixture/native-schedules`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ enabled }), signal: AbortSignal.timeout(15000) })
          assert.equal(response.status, 200, "Owned fixture config API failed")
          await until(async () => experimentalEditor.effectiveMissionExperimental(await client.config.get({ location: { directory: project } })).schedules === enabled)
        } })
      result.calls = calls; result.status = values["diagnose-stop"] || controlTrace ? "diagnostic-only" : "passed"; result.stage = "completed"; return result
    }
    const pausedID = await create("paused", { kind: "in", delayMs }), stoppedID = await create("stopped", { kind: "in", delayMs })
    await activate(stoppedID); await control(stoppedID, "play"); await control(stoppedID, "stop")
    const timing = kind === "every" ? { kind, intervalMs: 900000 } : kind === "at" ? { kind, at: Date.now() + delayMs, zone: "UTC" } : { kind, delayMs }
    const id = await create(kind, timing); await activate(id); await control(id, "play")
    const armed = snapshot(id), principal = armed.schedules.find(item => item.role === "principal"), auxiliary = armed.schedules.find(item => item.role === "reconciliation")
    assert(armed.document.calendarOwner.auxiliaryReady && !armed.document.calendarOwner.operation.pending)
    assert(auxiliary?.status === "active" && principal?.status === "active")
    learnTechnical(armed)
    assert(technicalRows().every(item => item.sessionPresent && item.schedulePresent && item.reverseIndexPresent))
    assert.equal(armed.document.calendarOwner.slots[0].role, "reconciliation")
    assert.equal(calls.length, 0); assert(principal.next_due_at >= Date.now() + 6000, "Insufficient real due-time headroom")
    result.documentID = id; result.guardIDs = { pausedID, stoppedID }; result.dueAt = principal.next_due_at
    await save("armed", armed)
    if (values["arm-only"]) {
      result.arming = { pausedCreation: true, activationReady: armed.document.scheduleActivation?.state === "ready", auxiliaryReady: true,
        auxiliaryScheduleID: auxiliary.id, principalScheduleID: principal.id, providerRequests: calls.length,
        installation: armed.document.calendarOwner.installation, noBusinessAdmission: armed.document.pending === null && armed.document.launchedCount === 0 }
      assert(result.arming.activationReady && result.arming.noBusinessAdmission)
      result.status = "passed"
      return result // finally closes backend/leases/bridge and waits for every owned child.
    }
    await closeBackend(); if (!values.live) await stop()
    result.initialWakeMode = values.live ? "live-same-process" : "cold-restart"
    assert(Date.now() < principal.next_due_at, "Natural due must remain in the future when closing the backend")
    result.noClientWindowStartedAt = Date.now()
    await delay(Math.max(0, principal.next_due_at - Date.now()) + 250)
    result.stage = values.live ? "natural-live-first-admission" : "natural-cold-first-admission"
    if (!values.live) await launch(true) // Cold startup is registration-read-only; live keeps the original process.
    if (values["first-admission-race"]) {
      result.stage = "first-original-admission-held"
      const held = await until(() => {
        const state = snapshot(id), pending = state.document.pending
        const beforeACK = heldOriginal && pending?.admissionAttempted && pending.admittedAt === null && state.document.launchedCount === 0 && state.start.length === 0 && state.inboxCount === 0
        const admittedFallback = !heldOriginal && pendingHandoff && pending?.admittedAt != null && state.document.launchedCount === 1 && state.start.length === 1 && providerOpen.size > 0
        return state.sessions.length === 1 && (beforeACK || admittedFallback) ? state : false
      })
      const relay = heldOriginal ?? pendingHandoff, beforeACK = !!heldOriginal
      const pending = held.document.pending, original = pending.origin.wakes[0]
      const mapped = held.document.calendars.find(item => item.scheduleID === original.scheduleID)
      const actualWake = { missionID: id, generation: mapped.timeGeneration, sessionID: mapped.sessionID, scheduleID: original.scheduleID, run: original.run, messageID: original.messageID }
      assert(mapped.highWater >= original.run, "The genuine first wake must already be consumed durably")
      assert.equal(relay.sessionID, pending.coordinatorSessionID)
      if (beforeACK) { assert.equal(relay.messageID, pending.messageID); assert.equal(relay.document.passageID, pending.id) }
      assert.deepEqual(relay.request.wake, actualWake); assert.deepEqual(relay.request.incarnation, readNativeScheduleIncarnation(registrationFile))
      if (relay.request.preflight?.signature) secrets.add(relay.request.preflight.signature)
      assert(Date.now() - relay.request.preflight.issuedAt < 5000, "Insufficient genuine preflight headroom")
      result.noClientFirstAdmissionHeldAt = Date.now(); await save("first-admission-held", held)
      const started = Date.now(), abort = new AbortController(), timer = setTimeout(() => { abort.abort(); releaseBarrier("race-budget-expired") }, 2000)
      let after
      try {
        await connect(abort.signal)
        const expectedKey = nativeScheduleWakeKey(actualWake)
        const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => client.rpc(NativeScheduleTransportRpc)
          .wake(structuredClone(relay.request), { location: { directory: project }, signal: abort.signal })))
        result.firstAdmissionRace = { coverage: beforeACK ? "native original already reserved and in-flight before inbox/ACK; not simultaneous reservation CAS" : "authorized fallback: original already admitted, same pending and provider HTTP held; not pre-admission concurrency",
          preAdmissionBarrierEngaged: beforeACK,
          pendingID: pending.id, rootID: pending.coordinatorSessionID, originalMessageID: pending.messageID, highWater: mapped.highWater,
          preflightCapturedFromActualProductDispatch: true, before: { count: held.document.launchedCount, roots: held.sessions.length, startMessages: held.start.length, inbox: held.inboxCount },
          outcomes: outcomes.map(entry => entry.status === "fulfilled" ? { status: entry.status, key: entry.value.key, state: entry.value.state }
            : { status: entry.status, type: entry.reason?.type ?? entry.reason?.reason?.type ?? entry.reason?._tag ?? "unclassified" }), elapsedMs: Date.now() - started }
        assert((beforeACK ? !heldOriginal.releasedAt : holdBusiness && providerOpen.size > 0) && Date.now() - started < 2000, "The measured original phase must remain held throughout the bounded race")
        assert(outcomes.every(entry => entry.status === "fulfilled" && entry.value.key === expectedKey && entry.value.state === "applied"), "Every consumed-path replay must return its exact typed applied reply")
        after = snapshot(id)
        assert.equal(after.document.pending.id, pending.id); if (beforeACK) assert.equal(after.document.revision, held.document.revision)
        assert.equal(after.document.launchedCount, held.document.launchedCount); assert.deepEqual(after.sessions, held.sessions); assert.deepEqual(after.start, held.start); assert.equal(after.inboxCount, held.inboxCount)
      } finally { clearTimeout(timer); releaseBarrier("race-finished") }
      result.firstAdmissionRace.heldMs = (heldOriginal?.releasedAt ?? Date.now()) - relay.enteredAt
      result.firstAdmissionRace.releaseReason = heldOriginal?.releaseReason ?? "provider-remains-held"
      await save("first-admission-race", { ...result.firstAdmissionRace, after })
    }
    const positive = await until(() => {
      const state = snapshot(id), pending = state.document.pending
      return state.document.launchedCount === 1 && state.start.length === 1 && pending?.admittedAt != null
        && state.schedules.filter(item => item.role === "principal").every(item => item.status !== "active") ? state : false
    })
    assert.equal(positive.sessions.length, 1); assert.equal(positive.sessions[0].id, positive.document.pending.coordinatorSessionID)
    assert.equal(positive.start[0].id, positive.document.pending.messageID)
    await until(() => calls.some(call => call.sessionID === positive.document.pending.coordinatorSessionID))
    assert(positive.schedules.some(item => item.role === "reconciliation" && item.status === "active"), "Last pending passage requires its live auxiliary")
    for (const guardID of [pausedID, stoppedID]) { const guard = snapshot(guardID); assert.equal(guard.document.launchedCount, 0); assert.equal(guard.sessions.length, 0) }
    if (values.live) { assert.equal(result.serviceStarts.length, 1); assert.equal(child.pid, result.serviceStarts[0].pid); result.naturalLivePositiveAt = Date.now() }
    else result.naturalColdPositiveAt = Date.now()
    result.admittedPositiveBeforeAnyExternalClient = !values["first-admission-race"]
    await save(values.live ? "natural-live-positive" : "natural-cold-positive", positive)
    const pending = positive.document.pending, originalWake = pending.origin.wakes[0], calendar = positive.document.calendars.find(item => item.scheduleID === originalWake.scheduleID)
    const wake = { missionID: id, generation: calendar.timeGeneration, sessionID: calendar.sessionID, scheduleID: originalWake.scheduleID, run: originalWake.run, messageID: originalWake.messageID }
    result.stage = "business-report"
    if (values["crash-pending"]) {
      result.stage = "crash-pending-provider-held"
      const beforeCrash = await until(() => {
        const state = snapshot(id), claim = state.claims.find(item => item.id === pending.coordinatorSessionID)
        return state.document.pending?.id === pending.id && state.document.launchedCount === 1 && state.start.length === 1
          && Number.isSafeInteger(claim?.time_suspended) && claim.time_suspended > 0 && providerOpen.size > 0 ? state : false
      })
      assert(!reported.has(pending.coordinatorSessionID)); assert(holdBusiness)
      await save("before-pending-crash", beforeCrash)
      const killedPID = child.pid, owned = children.find(entry => entry.child === child)
      child.kill("SIGKILL"); await owned.closed; client = undefined; endpoint = undefined
      for (const deadline = Date.now() + 5000; providerOpen.size > 0;) { assert(Date.now() < deadline, "Killed provider connection did not close"); await delay(10) }
      assert(!reported.has(pending.coordinatorSessionID), "The disconnected original HTTP handler must not emit a report")
      const afterKill = snapshot(id)
      assert.equal(afterKill.document.pending.id, pending.id); assert.equal(afterKill.document.launchedCount, 1)
      assert.deepEqual(afterKill.start, beforeCrash.start); assert.deepEqual(afterKill.sessions, beforeCrash.sessions)
      assert.deepEqual(afterKill.claims, beforeCrash.claims, "Hard kill must preserve the actual durable native claim")
      await save("after-pending-hard-kill", afterKill)
      result.crashPending = { killedPID, hardKill: true, originalHandlerClosedWithoutReport: true, oldClaimRetained: true,
        pendingID: pending.id, rootID: pending.coordinatorSessionID, originalMessageID: pending.messageID, noClientRecoveryWindowStartedAt: Date.now() }
      holdBusiness = false; for (const release of releases) release(); releases.clear()
      result.stage = "cold-pending-execution-recovery-no-client"
      await launch(true)
      const recovered = await until(async () => {
        const state = snapshot(id)
        assert.equal(state.document.launchedCount, 1); assert.deepEqual(state.sessions, beforeCrash.sessions)
        assert.equal(state.start.filter(message => message.id === pending.messageID).length, 1)
        const terminal = readSQL(db => {
          const rows = db.prepare("SELECT id,type,data FROM session_message WHERE session_id=? AND type IN ('assistant','idle') ORDER BY seq DESC LIMIT 64").all(pending.coordinatorSessionID)
          const report = rows.filter(row => row.type === "assistant").flatMap(row => JSON.parse(row.data).content ?? []).find(part => part.type === "tool" && part.name === "mission_report" && part.state?.status === "completed")
          const idle = rows.find(row => row.type === "idle")
          return { report: !!report, idle: idle && { id: idle.id, outcome: JSON.parse(idle.data).outcome } }
        })
        if (!terminal.report || terminal.idle?.outcome !== "succeeded") return false
        const business = await missionDocumentPassage(readOnlyStorage, positive.document, () => true).journal.snapshot()
        return business.missions[0]?.status === "completed" ? { state, terminal, businessStatus: "completed" } : false
      })
      const messages = recovered.state.startDetails.map(message => ({ ...message,
        classification: message.id === pending.messageID ? "missions-original" : !message.missionDocument && message.type === "synthetic" ? "native-recovery-unmarked-synthetic" : "unclassified-continuation" }))
      assert.equal(messages.filter(message => message.classification === "missions-original").length, 1)
      assert(!messages.some(message => message.id !== pending.messageID && message.missionDocument), "An extra Missions-origin start requires investigation")
      assert(recovered.state.schedules.some(item => item.role === "reconciliation" && item.status === "active"))
      result.crashPending.recoveredBeforeAnyClient = true; result.crashPending.recoveredAt = Date.now(); result.crashPending.messages = messages
      await save("cold-pending-recovered", { ...recovered, messages })
    } else { holdBusiness = false; for (const release of releases) release(); releases.clear() }
    await until(() => readSQL(db => db.prepare("SELECT 1 AS idle FROM session_message WHERE session_id=? AND type='idle' AND json_extract(data,'$.outcome')='succeeded' LIMIT 1").get(pending.coordinatorSessionID)))
    const business = await missionDocumentPassage(readOnlyStorage, positive.document, () => true).journal.snapshot()
    assert.equal(business.missions[0]?.status, "completed"); result.businessFinalReport = true
    const completedStarts = snapshot(id).start
    result.stage = "second-cold-reboot"
    await stop(); await launch(true); await delay(8000)
    const rebooted = snapshot(id); assert.equal(rebooted.document.launchedCount, 1); assert.deepEqual(rebooted.start, completedStarts); assert.deepEqual(rebooted.sessions, positive.sessions)
    await save("second-cold-reboot", rebooted)
    // Natural no-client proof is already saved. Authenticated exact replay is a
    // separate mutation-dedupe stage, using a genuine native persisted wake.
    await connect()
    const beforeMaintenance = snapshot(id)
    if (values["controlled-settlement"]) {
      result.stage = "controlled-auxiliary-settlement"
      const auxiliaryDue = beforeMaintenance.schedules.find(item => item.role === "reconciliation" && item.status === "active")?.next_due_at
      if (beforeMaintenance.document.pending) {
        assert(Number.isSafeInteger(auxiliaryDue))
        const definition = { id: "codenomad.schedule-clock-qualification", methods: { tick: { input: { type: "object" }, output: { type: "object" } } }, events: {} }
        await client.rpc(definition).tick({ at: auxiliaryDue + 1 }, { location: { directory: project }, signal: AbortSignal.timeout(20000) })
      }
      const settled = await until(() => { const state = snapshot(id); return state.document.pending === null && state.document.settledCount === 1 ? state : false })
      assert.equal(settled.document.history[0].outcome, "completed"); assert.equal(settled.document.launchedCount, 1)
      result.controlledSettlement = { usedNativeEffectClockOnly: !!beforeMaintenance.document.pending, osClockUnchanged: true }; await save("controlled-settled", settled)
      result.stage = "after-idle-maintenance"
      // No fixture maintenance call and no replay may perform this cleanup.
      // Observe the real terminal hint -> fixed product HTTP RPC -> exact row removal.
      const afterIdle = await until(async () => {
        const rows = technicalRows(), events = await maintenanceEvents(), settledAt = settled.document.history[0].settledAt
        const terminal = events.find(event => event.kind === "terminal" && event.sessionID === auxiliary.session_id && event.at >= settledAt)
        const request = terminal && events.find(event => event.kind === "maintenance-http-request" && event.sessionID === auxiliary.session_id
          && event.pid === terminal.pid && event.at >= terminal.at)
        const response = request && events.find(event => event.kind === "maintenance-http-response" && event.requestID === request.requestID
          && event.pid === request.pid && event.status === 200)
        return terminal && request && response && rows.every(item => !item.sessionPresent && !item.schedulePresent && !item.reverseIndexPresent)
          ? { rows, terminal, request, response, observedAt: Date.now() } : false
      })
      result.afterIdleMaintenance = true; await save("after-idle-maintenance", afterIdle)
    } else result.settlementGate = "Natural auxiliary settlement may require up to 15 minutes; use separate --controlled-settlement qualification"
    result.stage = "after-purge-replay"
    const payload = { wake, registrationFile, incarnation: readNativeScheduleIncarnation(registrationFile) }
    const replay = await Promise.allSettled(Array.from({ length: 8 }, () => client.rpc(NativeScheduleTransportRpc).wake(payload, { location: { directory: project }, signal: AbortSignal.timeout(15000) })))
    result.concurrentReplay = replay.map(entry => entry.status === "fulfilled" ? { status: entry.status, state: entry.value.state } : { status: entry.status })
    const deduped = snapshot(id); assert.equal(deduped.document.launchedCount, 1); assert.deepEqual(deduped.start, completedStarts)
    result.calls = calls; result.status = "passed"; result.stage = "completed"
  } catch (error) {
    const redact = input => { let text = String(input ?? ""); for (const secret of secrets) text = text.replaceAll(secret, "<redacted>"); return text.slice(0, 64000) }
    const detail = item => item && { name: redact(item.name), type: redact(item.type ?? item._tag), message: redact(item.message), stack: redact(item.stack) }
    result.status = "failed"; result.error = redact(error?.message ?? "qualification-failed")
    await save("failure-diagnostic", { stage: result.stage, error: detail(error), reason: detail(error?.reason), cause: detail(error?.cause) })
    if (result.documentID) try { await save("failure-sql", snapshot(result.documentID)) } catch { /* Preserve the original failure. */ }
    throw Error(`Native product qualification failed at ${result.stage ?? "setup"}; private redacted diagnostic saved`)
  }
  finally {
    releaseBarrier("fixture-finally")
    holdBusiness = false; for (const release of releases) release(); releases.clear()
    try { await closeBackend() } finally {
      const stopped = await Promise.allSettled(children.map(entry => entry.child.exitCode === null && entry.child.signalCode === null ? stopFixtureChild(entry.child, entry.closed) : entry.closed))
      provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve))
      barrier.closeAllConnections(); if (barrier.listening) await new Promise(resolve => barrier.close(resolve))
      result.calls = calls
      result.allOwnedServicesStopped = stopped.every(entry => entry.status === "fulfilled"); await save("receipt", result)
      assert(result.allOwnedServicesStopped, "An owned native process failed cleanup")
    }
  }
}

try { for (const kind of kinds) await journey(kind); receipt.outcome = values["diagnose-stop"] || values["diagnose-product-stop"] ? "diagnostic-only" : "passed" }
catch (error) { receipt.outcome = "failed"; throw error }
finally {
  for (const name of Object.keys(process.env)) if (!(name in originalEnvironment)) delete process.env[name]
  Object.assign(process.env, originalEnvironment)
  await writeFile(path.join(scratch, "receipt.json"), JSON.stringify(receipt, null, 2))
}
