import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import path from "node:path"
import os from "node:os"
import { collectColdFailure, fixtureRedactor } from "./native-fixture-cold-diagnostics.mjs"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

const oldPassword = 'old-long-"password\\é', password = 'cold-long-"password\\漢'
const token = value => Buffer.from(`opencode:${value}`).toString("base64")
const driver = (await readFile(new URL("./test-native-mission-schedule-product.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
const catchStart = driver.indexOf('  } catch (error) {', driver.indexOf('result.stage = "after-purge-replay"'))
const finallyStart = driver.indexOf('\n  finally {', catchStart), journeyEnd = driver.indexOf('\n}\n\n', finallyStart)
assert(catchStart > 0 && finallyStart > catchStart && journeyEnd > finallyStart)
const catchBody = driver.slice(catchStart + '  } catch (error) {'.length, finallyStart).trimEnd().replace(/\}$/, "")
const finalBody = driver.slice(finallyStart, journeyEnd)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const catchFunction = new AsyncFunction("error", "context", `with(context) {${catchBody}}`)
const lifecycleFunction = new AsyncFunction("error", "context", `with(context) {try { if (error) throw error } catch(error) {${catchBody}}${finalBody}}`)
const outerFunction = new AsyncFunction("context", `with(context) {${driver.slice(journeyEnd + 3)}\nreturn qualificationError}`)

async function fixture(t) {
  await mkdir(path.join(os.tmpdir(), "opencode"), { recursive: true })
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode", "cold-diagnostics-test-"))
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: {}, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.resume(); child.stderr.resume()
  const closed = new Promise(resolve => child.once("close", resolve))
  let handler, requests = [], learned = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
    if (handler) return handler(request, response)
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pid: child.pid, version: "2.2.3", private: password }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (child.exitCode === null && child.signalCode === null) await stopFixtureChild(child, closed)
    await closed
    assert(child.exitCode !== null || child.signalCode !== null, `Owned fixture child ${child.pid} exited and closed`)
    await rm(root, { recursive: true, force: true })
  })
  const expected = { id: "owned-cold", pid: child.pid, url: `http://127.0.0.1:${server.address().port}`, version: "2.2.3" }
  const registrationFile = path.join(root, "xdg-state", "opencode", "service.json"), databaseFile = path.join(root, "fixture.db")
  await mkdir(path.dirname(registrationFile), { recursive: true })
  const register = async (patch = {}) => writeFile(registrationFile, JSON.stringify({ ...expected, password, ...patch }))
  await register()
  const logDir = path.join(root, "xdg-data", "opencode", "log")
  await mkdir(logDir, { recursive: true })
  await writeFile(path.join(logDir, "native.log"), [oldPassword, password, token(oldPassword), token(password),
    JSON.stringify(oldPassword).slice(1, -1), JSON.stringify(password).slice(1, -1), encodeURIComponent(oldPassword), encodeURIComponent(password)].join("\n"))
  const db = new DatabaseSync(databaseFile)
  db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE session_v2(id TEXT PRIMARY KEY,time_suspended INTEGER,time_busy INTEGER,time_idle INTEGER,idle_outcome TEXT);
    CREATE TABLE schedule(id TEXT PRIMARY KEY,session_id TEXT,status TEXT,next_due_at INTEGER,run_count INTEGER,time_created INTEGER,time_updated INTEGER,"when" TEXT,last_outcome TEXT,retry_at INTEGER,last_message_id TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);
    CREATE TABLE session_inbox(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,time_created INTEGER,payload TEXT);`)
  const document = { id: "doc", revision: 4, state: "running", launchedCount: 0,
    scheduleActivation: { state: "ready", private: password },
    calendarOwner: { auxiliaryReady: true, operation: { pending: { private: password } }, slots: [{ role: "principal", scheduleID: "schedule", sessionID: "carrier" }] },
    pending: { id: "passage", coordinatorSessionID: "business", messageID: "start", admissionAttempted: true, admittedAt: null } }
  const documentKey = "test:codenomad-missions/documents-v1/x/project/p/doc"
  db.prepare("INSERT INTO kv VALUES(?,?)").run(documentKey, JSON.stringify(document))
  db.exec(`INSERT INTO session_v2 VALUES('carrier',123,124,NULL,NULL);
    INSERT INTO session_v2 VALUES('business',456,457,NULL,NULL);
    INSERT INTO schedule VALUES('schedule','carrier','active',1000,0,10,11,'{"kind":"at","at":1000}','failed',1200,'msg_schedule_1');`)
  db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run("msg_schedule_1", "carrier", "user", 1, 1000,
    JSON.stringify({ text: "PRIVATE PROMPT", metadata: { schedule: { id: "schedule", run: 1, dueAt: 1000 }, private: password } }))
  db.prepare("INSERT INTO session_inbox VALUES(?,?,?,?,?)").run("msg_schedule_1", "carrier", "user", 1000, JSON.stringify({ text: "PRIVATE INBOX" }))
  db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run("start", "business", "user", 2, 1100, JSON.stringify({ text: "PRIVATE BUSINESS" }))
  db.close()
  const input = { status: "failed", stage: "natural-cold-first-admission", failureAt: Date.now(), root, registrationFile,
    databaseFile, expected, documentID: "doc", prefix: "test:", child, secrets: [oldPassword, token(oldPassword)],
    onSecrets: secrets => { learned.push(...secrets) } }
  const collect = extra => collectColdFailure({ ...input, ...extra })
  const runCatch = async (message = "bounded-product-qualification-deadline", patch = {}, overrides = {}, lifecycle = false) => {
    const result = { status: "running", stage: input.stage, documentID: "doc", serviceStarts: [expected], ...patch }
    const secrets = new Set(input.secrets)
    const context = { result, secrets, child, root, registrationFile, databaseFile, prefix: input.prefix,
      qualificationError: undefined, credentialsChild: undefined, nativeErrorTruncated: false,
      nativeErrorTail: `${oldPassword}\n${password}\n${token(password)}`, collectColdFailure, fixtureRedactor,
      save() { throw Error("Unexpected main-thread cold save") }, snapshot() { throw Error("Unexpected main-thread cold SQL") },
      maintenanceEvents() { throw Error("Unexpected main-thread cold disk") }, writeFile, path,
      releaseBarrier() {}, holdBusiness: true, releases: new Set(), closeBackend: async () => {}, children: [], calls: [],
      provider: { closeAllConnections() {}, close(done) { done() } }, barrier: { closeAllConnections() {}, listening: false },
      stopFixtureChild, assert, ...overrides }
    const original = message instanceof Error ? message : Error(message), originalReason = original.reason, originalCause = original.cause
    let thrown
    try { await (lifecycle ? lifecycleFunction : catchFunction)(original, context) } catch (error) { thrown = error }
    assert.strictEqual(thrown, original); assert.strictEqual(context.qualificationError, original)
    assert.strictEqual(thrown.reason, originalReason); assert.strictEqual(thrown.cause, originalCause)
    assert.equal(result.status, "failed")
    return { result, thrown, secrets, context }
  }
  return { ...input, closed, collect, runCatch, register, requests, learned, logDir, documentKey, document,
    handle(value) { handler = value }, edit(use) { const db = new DatabaseSync(databaseFile); try { use(db) } finally { db.close() } } }
}

for (const status of [503, 500, 200]) test(`cold catch retains failed verdict with later HTTP ${status}, safe logs and real SQL`, async t => {
  const f = await fixture(t)
  f.handle((_request, response) => {
    response.writeHead(status).end(JSON.stringify({ pid: f.child.pid, version: "2.2.3", password, config: "PRIVATE CONFIG" }))
  })
  const { result, thrown } = await f.runCatch()
  assert.equal(thrown.message, "bounded-product-qualification-deadline")
  assert.equal(result.error, "bounded-product-qualification-deadline")
  const raw = await readFile(path.join(f.root, "failure-diagnostic.json"), "utf8"), diagnostic = JSON.parse(raw)
  assert.equal(diagnostic.coldFailure.http.status, status)
  assert.equal(diagnostic.coldFailure.http.pid, f.child.pid)
  assert(diagnostic.coldFailure.observedAt >= diagnostic.failureAt)
  assert.equal(diagnostic.coldFailure.logs.sharedIncarnations, true)
  assert.equal(diagnostic.coldFailure.sql.schedules[0].run_count, 0)
  assert.equal(diagnostic.coldFailure.sql.schedules[0].retry_at, 1200)
  assert.equal(diagnostic.coldFailure.sql.schedules[0].session.time_suspended, 123)
  assert.equal(diagnostic.coldFailure.sql.schedules[0].messages[0].message.textBytes, 14)
  assert.deepEqual(diagnostic.coldFailure.sql.document.scheduleActivation, { state: "ready" })
  assert.deepEqual(diagnostic.coldFailure.sql.document.calendarOwner, { auxiliaryReady: true, slotCount: 1, operation: { pending: true } })
  assert.equal(diagnostic.coldFailure.sql.business.sessionID, "business")
  assert.equal(diagnostic.coldFailure.sql.business.session.time_suspended, 456)
  const sql = await readFile(path.join(f.root, "failure-sql.json"), "utf8")
  for (const secret of [oldPassword, password, token(oldPassword), token(password), JSON.stringify(password).slice(1, -1),
    JSON.stringify(oldPassword).slice(1, -1), encodeURIComponent(password), encodeURIComponent(oldPassword),
    "PRIVATE PROMPT", "PRIVATE INBOX", "PRIVATE BUSINESS", "PRIVATE CONFIG"]) assert(!(raw + sql).includes(secret), secret)
  assert(Buffer.byteLength(raw) <= 512 * 1024)
  assert.deepEqual(f.requests, [{ method: "GET", url: "/api/info", authorization: `Basic ${token(password)}` }])
})

for (const mode of ["dead-child", "undefined-expected", "invalid-expected"]) test(`actual cold catch writes a safe worker marker for ${mode}`, async t => {
  const f = await fixture(t)
  if (mode === "dead-child") await stopFixtureChild(f.child, f.closed)
  // An unavailable owner must never fall through to registration, log or SQL reads.
  await rm(f.registrationFile)
  const patch = mode === "undefined-expected" ? { serviceStarts: [] }
    : mode === "invalid-expected" ? { serviceStarts: [{ ...f.expected, pid: "foreign" }] } : {}
  const { result, thrown, secrets } = await f.runCatch(undefined, patch)
  assert.equal(result.error, "bounded-product-qualification-deadline")
  assert.equal(thrown.message, "bounded-product-qualification-deadline")
  const raw = await readFile(path.join(f.root, "failure-diagnostic.json"), "utf8"), marker = JSON.parse(raw)
  assert.equal(marker.stage, f.stage)
  assert.equal(marker.error, "owned-child-unavailable")
  assert(marker.observedAt >= marker.failureAt)
  assert.deepEqual(Object.keys(marker).sort(), ["error", "failureAt", "observedAt", "stage"])
  assert.equal(f.requests.length, 0)
  assert.deepEqual([...secrets], f.secrets)
  await assert.rejects(readFile(path.join(f.root, "failure-sql.json")), { code: "ENOENT" })
  assert(!raw.includes(password)); assert(!raw.includes(oldPassword))
})

test("a genuinely refused loopback port records only a safe transport category", async t => {
  const f = await fixture(t), closed = createServer()
  await new Promise(resolve => closed.listen(0, "127.0.0.1", resolve))
  const port = closed.address().port
  await new Promise(resolve => closed.close(resolve))
  f.expected.url = `http://127.0.0.1:${port}`
  await f.register()
  const start = Date.now(), result = await f.collect()
  assert.deepEqual(result.evidence.http, { error: "http-transport-unavailable" })
  assert.equal(f.requests.length, 0)
  assert(Date.now() - start < 5000)
  assert(!JSON.stringify(result).includes("ECONNREFUSED"))
  assert(!JSON.stringify(result).includes(f.expected.url))
})

test("collector stdout and stderr use native zero-retention discard, with IPC-only results", async () => {
  const source = await readFile(new URL("./native-fixture-cold-diagnostics.mjs", import.meta.url), "utf8")
  assert(source.includes('stdio: ["ignore", "ignore", "ignore", "ipc"]'))
  assert(!/worker\.(stdout|stderr)/.test(source))
  assert(source.includes('worker.once("error", () => resolve(failure("collector-unavailable")))'))
})

test("no network or disk collection before failure, on success, or at another stage", async t => {
  const f = await fixture(t)
  for (const patch of [{ status: "running" }, { status: "passed" }, { stage: "business-report" }]) assert.equal(await f.collect(patch), undefined)
  assert.deepEqual(f.requests, []); assert.deepEqual(f.learned, [])
  assert.equal(driver.match(/default: "120000"/g)?.length, 1)
  assert.match(driver, /if \(!cold && privateEvidenceAvailable && result\.documentID\) try \{/)
})

for (const mode of ["transport", "never-ending", "redirect", "body-overflow", "bad-pid", "bad-version", "bad-json"]) test(`single bounded GET: ${mode}`, async t => {
  const f = await fixture(t)
  f.handle((request, response) => {
    if (mode === "transport") return request.socket.destroy()
    if (mode === "never-ending") { response.writeHead(503); response.write('{"pid":'); return }
    if (mode === "redirect") return response.writeHead(302, { location: "/must-not-follow" }).end()
    if (mode === "body-overflow") return response.writeHead(503).end("x".repeat(32769))
    if (mode === "bad-json") return response.writeHead(500).end("not-json")
    response.end(JSON.stringify({ pid: mode === "bad-pid" ? f.child.pid + 1 : f.child.pid, version: mode === "bad-version" ? "wrong" : "2.2.3" }))
  })
  const start = Date.now(), result = await f.collect()
  assert.match(result.evidence.http.error, new RegExp({ transport: "transport", "never-ending": "timeout", redirect: "transport", "body-overflow": "overflow", "bad-pid": "identity-mismatch", "bad-version": "identity-mismatch", "bad-json": "body-unavailable" }[mode]))
  assert(Date.now() - start < 5000)
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, "/api/info")
})

for (const mode of ["registration-pid", "registration-id", "endpoint", "shared-port", "credentials", "registration-overflow", "dead-child", "changed-registration", "changed-child"]) test(`owned identity refuses ${mode}`, async t => {
  const f = await fixture(t)
  if (mode === "registration-pid") await f.register({ pid: f.child.pid + 1 })
  if (mode === "registration-id") await f.register({ id: "foreign" })
  if (mode === "endpoint") await f.register({ url: "http://example.com" })
  if (mode === "shared-port") { f.expected.url = "http://127.0.0.1:9911"; await f.register() }
  if (mode === "credentials") await f.register({ password: "" })
  if (mode === "registration-overflow") await f.register({ extra: "x".repeat(32768) })
  if (mode === "dead-child") f.child.killed = true
  if (mode.startsWith("changed-")) f.handle(async (_request, response) => {
    if (mode === "changed-registration") await f.register({ id: "foreign" })
    else f.child.killed = true
    response.end(JSON.stringify({ pid: f.child.pid, version: "2.2.3" }))
  })
  const result = await f.collect()
  assert(result.error); assert(!result.evidence)
  assert.equal(f.requests.length, mode.startsWith("changed-") ? 1 : 0)
  // Restore the observation flag for the fixture's owned cleanup guard.
  f.child.killed = false
})

for (const mode of ["missing-schema", "oversize-document", "oversize-message", "oversize-slots", "oversize-schedule-metadata", "locked"]) test(`real SQLite ${mode} is bounded and read-only`, async t => {
  const f = await fixture(t)
  let lock
  if (mode === "missing-schema") f.edit(db => db.exec("DROP TABLE schedule"))
  if (mode === "oversize-document") f.edit(db => db.prepare("UPDATE kv SET value=?").run(JSON.stringify({ ...f.document, huge: "x".repeat(262144) })))
  if (mode === "oversize-message") f.edit(db => db.prepare("UPDATE session_message SET data=? WHERE session_id='carrier'").run(JSON.stringify({ text: "x".repeat(262144) })))
  if (mode === "oversize-slots") f.edit(db => db.prepare("UPDATE kv SET value=?").run(JSON.stringify({ ...f.document, calendarOwner: { slots: Array(17).fill(f.document.calendarOwner.slots[0]) } })))
  if (mode === "oversize-schedule-metadata") f.edit(db => db.prepare('UPDATE schedule SET "when"=?, last_message_id=?, last_outcome=?').run("x".repeat(300000), "x".repeat(300000), "x".repeat(300000)))
  if (mode === "locked") { lock = new DatabaseSync(f.databaseFile); lock.exec("BEGIN EXCLUSIVE"); t.after(() => lock?.close()) }
  const start = Date.now(), result = await f.collect()
  if (mode === "oversize-message") assert.equal(result.evidence.sql.schedules[0].messages[0].message.error, "sql-message-overflow")
  else if (mode === "oversize-schedule-metadata") {
    assert.equal(result.evidence.sql.schedules[0].when_bytes, 300000)
    assert.equal(result.evidence.sql.schedules[0].last_message_id, null)
    assert.equal(result.evidence.sql.schedules[0].last_outcome, null)
    assert.equal(result.evidence.sql.schedules[0].whenSHA256, null)
  } else assert(result.evidence.sql.error)
  assert(Date.now() - start < 5000)
  if (lock) { lock.exec("ROLLBACK"); lock.close(); lock = undefined }
  if (mode !== "missing-schema") f.edit(db => assert.equal(db.prepare("SELECT run_count FROM schedule").get()?.run_count ?? 0, 0))
})

test("missing and oversized logs have explicit evidence and never exceed the shared read budget", async t => {
  const f = await fixture(t)
  await rm(f.logDir, { recursive: true })
  assert.equal((await f.collect()).evidence.logs.error, "logs-unavailable")
  await mkdir(f.logDir)
  await writeFile(path.join(f.logDir, "large.log"), "x".repeat(300 * 1024) + password)
  await writeFile(path.join(f.logDir, "other.log"), oldPassword)
  const result = await f.collect(), logs = result.evidence.logs
  assert(logs.files[0].truncated)
  assert.equal(logs.files[0].error, "log-truncated-content-omitted")
  assert(!Object.hasOwn(logs.files[0], "text"))
  assert.equal(logs.files[0].observedBytes, 300 * 1024 + Buffer.byteLength(password))
  assert(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024)
  assert(!JSON.stringify(result).includes(password))
})

test("refused artifact writes preserve the original private failure without exporting its text", async t => {
  const f = await fixture(t)
  await mkdir(path.join(f.root, "failure-diagnostic.json"))
  const { result, thrown } = await f.runCatch(`original ${password}`)
  assert.equal(result.error, "private-text-omitted")
  assert.equal(thrown.message, `original ${password}`)
  await writeFile(path.join(f.logDir, "native.log"), "\u0000".repeat(256 * 1024))
  const output = await f.collect()
  assert.equal(output.evidence.logs.files[0].error, "log-private-content-omitted")
  assert(!Object.hasOwn(output.evidence.logs.files[0], "text"))
  assert(Buffer.byteLength(JSON.stringify(output)) <= 512 * 1024)
})

test("a complete in-budget log exports metadata and an explicit private-content omission", async t => {
  const f = await fixture(t), content = "a".repeat(100000) + "\nlast-line\n"
  await writeFile(path.join(f.logDir, "native.log"), content)
  await f.runCatch()
  const diagnostic = JSON.parse(await readFile(path.join(f.root, "failure-diagnostic.json"), "utf8"))
  const log = diagnostic.coldFailure.logs.files[0]
  assert.equal(log.truncated, false)
  assert.equal(log.observedBytes, Buffer.byteLength(content))
  assert.equal(log.error, "log-private-content-omitted")
  assert(!Object.hasOwn(log, "text"))
})

test("private symlink escaping the owned root is refused before HTTP", async t => {
  const f = await fixture(t), outside = await mkdtemp(path.join(os.tmpdir(), "opencode", "cold-diagnostics-outside-"))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const file = path.join(outside, "service.json")
  await writeFile(file, JSON.stringify({ ...f.expected, password }))
  await rm(path.dirname(f.registrationFile), { recursive: true })
  // Windows directory junctions need no symlink privilege.
  await symlink(outside, path.dirname(f.registrationFile), process.platform === "win32" ? "junction" : "dir")
  assert((await f.collect()).error); assert.equal(f.requests.length, 0)
})

test("a secret crossing the bounded log read boundary has no exported prefix or suffix", async t => {
  const f = await fixture(t)
  const content = "x".repeat(256 * 1024 - 5) + password + "z".repeat(256 * 1024 - 5)
  await writeFile(path.join(f.logDir, "native.log"), content)
  const result = await f.collect(), file = result.evidence.logs.files[0]
  assert.equal(file.truncated, true)
  assert.equal(file.error, "log-truncated-content-omitted")
  assert(!Object.hasOwn(file, "text"))
  assert(!JSON.stringify(result).includes(password.slice(5)))
})

test("longest-first redaction covers raw, escaped, URI, Basic and overlapping credentials", () => {
  const values = ["short", "short-long", oldPassword, token(oldPassword)], redact = fixtureRedactor(values)
  for (const value of ["short-long", oldPassword, JSON.stringify(oldPassword).slice(1, -1), encodeURIComponent(oldPassword),
    token(oldPassword), `Basic ${token(oldPassword)}`, `opencode:${oldPassword}`]) assert.equal(redact(value), "<redacted>")
})

test("malformed Unicode credentials remain redacted without masking the original failure", () => {
  const value = "private-\ud800-value", redact = fixtureRedactor([value])
  for (const form of [value, value.toWellFormed(), JSON.stringify(value).slice(1, -1), encodeURIComponent(value.toWellFormed()),
    Buffer.from(value).toString("base64")]) assert.equal(redact(form), "<redacted>")
})

for (const form of ["unicode", "mixed", "backslash", "surrogate"]) test(`saved artifacts omit recoverable JSON ${form} credential spellings`, async t => {
  const f = await fixture(t), value = `${password}-😀-\ud800`
  await f.register({ password: value })
  const units = value.split(""), unicode = unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`
  const encoded = form === "unicode" ? units.map(unicode).join("")
    : form === "mixed" ? units.map((unit, i) => i % 2 ? unicode(unit) : JSON.stringify(unit).slice(1, -1)).join("")
    : form === "backslash" ? JSON.stringify(value).slice(1, -1).replaceAll("\\\\", "\\u005c")
    : units.map(unit => /[\ud800-\udfff]/.test(unit) ? unicode(unit) : JSON.stringify(unit).slice(1, -1)).join("")
  const content = `{"password":"${encoded}"}`
  assert.equal(JSON.parse(content).password, value)
  await writeFile(path.join(f.logDir, "native.log"), content)
  await f.runCatch()
  const raw = await readFile(path.join(f.root, "failure-diagnostic.json"), "utf8")
  const sql = await readFile(path.join(f.root, "failure-sql.json"), "utf8")
  const log = JSON.parse(raw).coldFailure.logs.files[0]
  assert.equal(log.error, "log-private-content-omitted"); assert(!Object.hasOwn(log, "text"))
  assert.equal(log.observedBytes, Buffer.byteLength(content))
  for (const secret of [encoded, value, value.toWellFormed(), token(value)]) assert(!(raw + sql).includes(secret))
})

test("real stderr handler tracks a credential crossing its tail boundary and omits the saved tail", async t => {
  const f = await fixture(t)
  const marker = 'child.stderr.on("data", bytes => {'
  const start = driver.indexOf(marker), end = driver.indexOf("})", start)
  assert(start > 0 && end > start)
  const state = { nativeErrorLength: 0, nativeErrorTruncated: false }
  const receive = new Function("bytes", "context", `with(context) {${driver.slice(start + marker.length, end)}}`)
  receive(Buffer.from(password + "x".repeat(32000 - 5)), state)
  assert.equal(state.nativeErrorTruncated, true)
  assert.equal(state.nativeErrorLength, 32000)
  assert(!JSON.stringify(state).includes(password.slice(-5)))
  receive(Buffer.from("more"), state)
  assert.equal(state.nativeErrorLength, 32000); assert.equal(state.nativeErrorTruncated, true)
  await f.runCatch(undefined, {}, { ...state, nativeErrorTail: (password + "x".repeat(32000 - 5)).slice(-32000) })
  const raw = await readFile(path.join(f.root, "failure-diagnostic.json"), "utf8"), diagnostic = JSON.parse(raw)
  assert.equal(diagnostic.nativeErrorTruncated, true)
  assert.equal(diagnostic.nativeErrorTail, "private-text-omitted")
  assert(!raw.includes(password.slice(-5)))
  const launch = driver.slice(driver.indexOf("const launch = async"), driver.indexOf("const connect = async"))
  assert.match(launch, /credentialsChild\s*=\s*undefined/)
  assert.match(launch, /nativeErrorLength\s*=\s*0/)
  assert.match(launch, /nativeErrorTruncated\s*=\s*false/)
})

for (const stage of ["business-report", "first-original-admission-held", "play", "natural-live-first-admission"]) test(`unknown current incarnation at ${stage} performs zero discovery, network or SQL reads`, async t => {
  const f = await fixture(t), reads = []
  await rm(f.registrationFile)
  const original = Object.assign(Error(`private-error ${password}`), {
    reason: Object.assign(Error(`private-reason ${password}`), { _tag: password }),
    cause: Error(`private-cause ${password}`), type: password,
  })
  const forbidden = name => () => { reads.push(name); throw Error(`Unexpected ${name}`) }
  const { result } = await f.runCatch(original, { stage }, {
    // An old Child with the same PID is still a different incarnation handle.
    credentialsChild: { pid: f.child.pid }, nativeErrorTail: password,
    collectColdFailure: forbidden("collector/discovery"), snapshot: forbidden("SQL"), maintenanceEvents: forbidden("maintenance"),
    save: (name, value) => writeFile(path.join(f.root, `${name}.json`), JSON.stringify(value)),
  })
  assert.deepEqual(reads, []); assert.deepEqual(f.requests, []); assert.deepEqual(f.learned, [])
  assert.equal(result.error, "private-text-omitted")
  const raw = await readFile(path.join(f.root, "failure-diagnostic.json"), "utf8"), diagnostic = JSON.parse(raw)
  for (const key of ["error", "reason", "cause", "nativeErrorTail"]) assert.equal(diagnostic[key], "private-text-omitted")
  assert(!raw.includes(password)); assert(!raw.includes("private-error")); assert(!raw.includes("private-reason")); assert(!raw.includes("private-cause"))
  await assert.rejects(readFile(path.join(f.root, "failure-sql.json")), { code: "ENOENT" })
})

test("known credentials still omit error, reason, cause and stderr private text in real cold artifacts", async t => {
  const f = await fixture(t), original = Object.assign(Error(`private-error ${password}`), {
    reason: Error(`private-reason ${password}`), cause: Error(`private-cause ${password}`),
  })
  await f.runCatch(original, {}, { credentialsChild: f.child })
  const raw = await readFile(path.join(f.root, "failure-diagnostic.json"), "utf8"), diagnostic = JSON.parse(raw)
  for (const key of ["error", "nativeErrorTail"]) assert.equal(diagnostic[key], "private-text-omitted")
  for (const key of ["reason", "cause"]) assert(!Object.hasOwn(diagnostic, key))
  assert(!raw.includes(password)); assert(!raw.includes("private-error")); assert(!raw.includes("private-reason")); assert(!raw.includes("private-cause"))
})

test("known current incarnation keeps useful non-cold SQL metadata without new discovery", async t => {
  const f = await fixture(t)
  let reads = 0
  await f.runCatch(Error("private failure"), { stage: "business-report" }, {
    credentialsChild: f.child,
    collectColdFailure() { throw Error("Unexpected discovery") },
    snapshot() {
      reads++
      let state
      f.edit(db => { state = { document: { calendarOwner: { slots: [] } },
        schedule: db.prepare("SELECT status,run_count,next_due_at FROM schedule").get() } })
      return state
    },
    maintenanceEvents: async () => [],
    save: (name, value) => writeFile(path.join(f.root, `${name}.json`), JSON.stringify(value)),
  })
  const sql = JSON.parse(await readFile(path.join(f.root, "failure-sql.json"), "utf8"))
  assert.deepEqual(sql.schedule, { status: "active", run_count: 0, next_due_at: 1000 })
  assert.equal(reads, 1); assert.deepEqual(f.requests, [])
})

for (const mode of ["EISDIR", "ENOSPC", "cleanup"]) test(`exact catch and finally preserve original error identity and reason through ${mode}`, async t => {
  const f = await fixture(t), original = Object.assign(Error(`original ${password}`), { reason: { private: password } })
  const io = Object.assign(Error(`private-io ${password}`), { code: "ENOSPC" })
  let storageFailure, cleanupCalls = 0
  if (mode === "EISDIR") await mkdir(path.join(f.root, "receipt.json"))
  const { result } = await f.runCatch(original, {}, {
    closeBackend: async () => { cleanupCalls++; if (mode === "cleanup") throw io },
    save: async (name, value) => {
      try {
        if (name === "receipt" && mode === "ENOSPC") throw io
        await writeFile(path.join(f.root, `${name}.json`), JSON.stringify(value))
      } catch (error) { storageFailure = error; throw error }
    },
  }, true)
  assert.equal(cleanupCalls, 1)
  assert.strictEqual(original.reason.private, password)
  assert.equal(result.status, "failed")
  if (mode === "EISDIR") assert.equal(storageFailure?.code, "EISDIR")
  if (mode === "ENOSPC") assert.strictEqual(storageFailure, io)
  if (mode === "cleanup") assert.equal(result.cleanupError, "backend-cleanup-failed")
  else assert.equal(result.storageError, "receipt-save-unavailable")
  assert(!JSON.stringify(result).includes(password))
})

for (const mode of ["EISDIR", "ENOSPC"]) test(`exact finally rejects successful qualification when receipt fails with ${mode}`, async t => {
  const f = await fixture(t), io = Object.assign(Error("synthetic-quota"), { code: "ENOSPC" })
  if (mode === "EISDIR") await mkdir(path.join(f.root, "receipt.json"))
  const result = { status: "passed", stage: "completed" }
  const context = { result, qualificationError: undefined, releaseBarrier() {}, holdBusiness: false, releases: new Set(),
    closeBackend: async () => {}, children: [], calls: [], stopFixtureChild, assert,
    provider: { closeAllConnections() {}, close(done) { done() } }, barrier: { closeAllConnections() {}, listening: false },
    save: async (name, value) => { if (mode === "ENOSPC") throw io; await writeFile(path.join(f.root, `${name}.json`), JSON.stringify(value)) },
  }
  await assert.rejects(lifecycleFunction(undefined, context), error => mode === "ENOSPC" ? error === io : error.code === "EISDIR")
  assert.equal(result.status, "failed")
  assert.equal(result.storageError, "receipt-save-unavailable")
})

for (const mode of ["EISDIR", "ENOSPC"]) for (const failed of [true, false]) test(`exact outer entrypoint keeps ${failed ? "original failure" : "receipt failure"} and safe output with ${mode}`, async t => {
  const f = await fixture(t), original = Object.assign(Error(`original ${password}`), { reason: { private: password } })
  const io = Object.assign(Error(`private-storage ${password}`), { code: "ENOSPC" }), receipt = { outcome: "running" }, printed = [], processStub = { env: {}, exitCode: 0 }
  let storageFailure
  if (mode === "EISDIR") await mkdir(path.join(f.root, "receipt.json"))
  const returned = await outerFunction({ kinds: ["at"], journey: async () => { if (failed) throw original }, receipt, values: {},
    scratch: f.root, path, originalEnvironment: {}, process: processStub, console: { error: (...args) => printed.push(args.join(" ")), log: (...args) => printed.push(args.join(" ")) },
    writeFile: async (...args) => { try { if (mode === "ENOSPC") throw io; await writeFile(...args) } catch (error) { storageFailure = error; throw error } },
  })
  assert.equal(storageFailure?.code, mode)
  assert.strictEqual(returned, failed ? original : storageFailure)
  if (failed) assert.strictEqual(returned.reason, original.reason)
  assert.equal(receipt.outcome, "failed"); assert.equal(processStub.exitCode, 1)
  assert.equal(receipt.storageError, "receipt-save-unavailable")
  assert.deepEqual(printed, ["Native product qualification failed; see receipt"])
  assert(!JSON.stringify(receipt).includes(password)); assert(!printed.join("").includes(password))
})

for (const mode of ["EISDIR", "ENOSPC"]) test(`full extracted inner/outer lifecycle preserves original failure with ${mode} at both receipts`, async t => {
  const f = await fixture(t), original = Object.assign(Error(`original ${password}`), { reason: { private: password } })
  const io = Object.assign(Error("synthetic-quota"), { code: "ENOSPC" }), printed = [], receipt = { outcome: "running", cases: [] }
  const processStub = { env: {}, exitCode: 0 }
  if (mode === "EISDIR") await mkdir(path.join(f.root, "receipt.json"))
  const store = async (file, value) => { if (mode === "ENOSPC" && path.basename(file) === "receipt.json") throw io; await writeFile(file, value) }
  const returned = await outerFunction({ kinds: ["at"], receipt, values: {}, scratch: f.root, path,
    originalEnvironment: {}, process: processStub, console: { error: text => printed.push(text) }, writeFile: store,
    journey: async () => {
      const { result, thrown } = await f.runCatch(original, {}, {
        children: [{ child: f.child, closed: f.closed }],
        save: (name, value) => store(path.join(f.root, `${name}.json`), JSON.stringify(value)),
      }, true)
      receipt.cases.push(result)
      throw thrown
    },
  })
  assert.strictEqual(returned, original); assert.strictEqual(returned.reason, original.reason)
  assert.equal(receipt.outcome, "failed"); assert.equal(receipt.cases[0].status, "failed")
  assert.equal(receipt.cases[0].allOwnedServicesStopped, true); assert.equal(processStub.exitCode, 1)
  assert.equal(receipt.cases[0].storageError, "receipt-save-unavailable")
  assert.deepEqual(printed, ["Native product qualification failed; see receipt"])
  assert(!JSON.stringify(receipt).includes(password))
})

test("ten-second collector deadline kills and reaps synchronous SQL without retaining handles", { timeout: 18000 }, async t => {
  const f = await fixture(t)
  // A real, intentionally expensive SQLite view executes native synchronous work.
  f.edit(db => db.exec(`DROP TABLE kv; CREATE VIEW kv AS WITH RECURSIVE n(x) AS
    (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000)
    SELECT 'test:codenomad-missions/documents-v1/x/project/p/doc' AS key,
    json_object('id', CASE WHEN sum(x)<0 THEN 'never' ELSE 'doc' END) AS value FROM n;`))
  const start = Date.now(), result = await f.collect({ diagnostic: { stage: f.stage } })
  assert.equal(result.error, "collector-timeout")
  assert(Date.now() - start >= 9900); assert(Date.now() - start < 13500)
  assert.equal(f.requests.length, 1)
  const marker = JSON.parse(await readFile(path.join(f.root, "failure-diagnostic.json"), "utf8"))
  assert.equal(marker.error, "cold-failure-diagnostic-unavailable")
  f.edit(db => db.exec("BEGIN EXCLUSIVE; ROLLBACK"))
})
