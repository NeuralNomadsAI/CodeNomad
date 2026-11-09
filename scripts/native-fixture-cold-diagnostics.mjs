import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { openSync, closeSync, fstatSync, readSync, realpathSync, opendirSync, writeFileSync, writeSync, ftruncateSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

const REGISTRATION = 32 * 1024, LOGS = 256 * 1024, OUTPUT = 512 * 1024
const same = (a, b) => ["id", "pid", "url", "version"].every(key => a?.[key] === b?.[key])
const alive = child => !!child?.pid && child.exitCode === null && child.signalCode === null && !child.killed
const failure = error => ({ error })
const validExpected = value => !!value && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 1024
  && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.url === "string" && value.url.length <= 4096
  && typeof value.version === "string" && value.version.length > 0 && value.version.length <= 1024

export function fixtureRedactor(values) {
  const hidden = new Set()
  // connect() already remembers the first incarnation's password and exact Basic token.
  // Recover its pair/username in memory; the private registration may now be overwritten.
  values = [...values]
  for (const value of [...values]) if (typeof value === "string") {
    const pair = Buffer.from(value, "base64").toString("utf8"), colon = pair.indexOf(":")
    if (colon > 0 && Buffer.from(pair).toString("base64") === value && values.includes(pair.slice(colon + 1)))
      values.push(pair, pair.slice(0, colon), `Basic ${value}`)
  }
  for (const value of values) if (typeof value === "string" && value) {
    hidden.add(value)
    hidden.add(value.toWellFormed())
    hidden.add(JSON.stringify(value).slice(1, -1))
    hidden.add(encodeURIComponent(value.toWellFormed()))
    hidden.add(Buffer.from(value).toString("base64"))
  }
  const ordered = [...hidden].sort((a, b) => b.length - a.length)
  return input => { let text = String(input ?? ""); for (const secret of ordered) text = text.replaceAll(secret, "<redacted>"); return text }
}

// A killable owned process also interrupts synchronous SQLite/native filesystem work.
// Credentials travel only over private IPC, never argv or inherited environment.
async function runWorker(input, child, onSecrets) {
  const owned = () => validExpected(input.expected) && alive(child) && child.pid === input.expected.pid
  input.ownerAvailable = owned()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR)$/i.test(key)))
  const worker = spawn(process.execPath, ["--max-old-space-size=64", fileURLToPath(import.meta.url), "--cold-diagnostic-child"],
    // Native ignore discards both streams at the OS boundary: zero retained bytes,
    // no pipe pumping and no free-form child/transport errors in exported evidence.
    { env, windowsHide: true, shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"] })
  let timer, result, exited = false
  const closed = new Promise(resolve => worker.once("close", () => { exited = true; resolve() }))
  try {
    result = await new Promise(resolve => {
      timer = setTimeout(() => resolve(failure("collector-timeout")), 10_000)
      worker.once("error", () => resolve(failure("collector-unavailable")))
      worker.once("exit", () => resolve(failure("collector-exited")))
      worker.on("message", message => {
        if (message.credentials) {
          try { onSecrets?.(message.credentials); worker.send({ credentialsAccepted: true }, () => {}) }
          catch { resolve(failure("collector-credentials-unavailable")) }
        }
        else if (message.checkOwner) { if (worker.connected) worker.send({ owned: owned() }, () => {}) }
        else resolve(message)
      })
      worker.send(input, error => { if (error) resolve(failure("collector-unavailable")) })
    })
  } finally {
    clearTimeout(timer)
    try { if (!exited) await stopFixtureChild(worker, closed) }
    catch { worker.disconnect?.(); result = failure("collector-stop-unconfirmed") }
  }
  if (input.ownerAvailable && !owned()) return failure("owned-child-changed")
  return result
}

export async function collectColdFailure(input) {
  if (input.status !== "failed" || input.stage !== "natural-cold-first-admission") return undefined
  const { child, onSecrets, ...data } = input
  return runWorker(data, child, onSecrets)
}

function ownedFile(root, file, limit, tail = false) {
  const base = realpathSync(root), resolved = realpathSync(file), relative = path.relative(base, resolved)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error("private-path-refused")
  const fd = openSync(resolved, "r")
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || !tail && stat.size > limit) throw Error("file-overflow")
    const bytes = Buffer.alloc(Math.min(limit, stat.size)), start = tail ? Math.max(0, stat.size - limit) : 0
    let count = 0
    while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, start + count); if (!n) break; count += n }
    return { bytes: bytes.subarray(0, count), observedBytes: stat.size, truncated: start > 0 || count < stat.size }
  } finally { closeSync(fd) }
}

function registration(input) {
  const raw = JSON.parse(ownedFile(input.root, input.registrationFile, REGISTRATION).bytes.toString("utf8"))
  const info = Object.fromEntries(["id", "pid", "url", "version"].map(key => [key, raw[key]]))
  if (!same(info, input.expected) || typeof info.id !== "string" || !info.id || info.id.length > 1024
    || !Number.isSafeInteger(info.pid) || info.pid <= 0 || typeof info.version !== "string" || !info.version || info.version.length > 1024) throw Error("incarnation-mismatch")
  const url = new URL(info.url)
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !url.port || ["9911", "28894"].includes(url.port) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw Error("endpoint-refused")
  // Native service registration stores a top-level password; also accept the public Basic shape.
  const auth = raw.auth ?? { type: "basic", username: "opencode", password: raw.password }
  if (auth.type !== "basic" || typeof auth.username !== "string" || !auth.username || auth.username.includes(":")
    || typeof auth.password !== "string" || !auth.password || auth.username.length > 1024 || auth.password.length > 8192) throw Error("credentials-unavailable")
  const pair = `${auth.username}:${auth.password}`, basic = Buffer.from(pair).toString("base64")
  return { info, basic, secrets: [auth.username, auth.password, pair, basic, `Basic ${basic}`] }
}

const ownerCheck = () => new Promise(resolve => {
  process.once("message", message => resolve(message.owned === true))
  process.send({ checkOwner: true })
})

async function infoProbe(input, credentials) {
  if (!await ownerCheck()) return failure("owned-child-unavailable")
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 2000)
  let response, reader
  try {
    response = await fetch(new URL("/api/info", credentials.info.url), { method: "GET", redirect: "error",
      headers: { authorization: `Basic ${credentials.basic}` }, signal: abort.signal })
    reader = response.body?.getReader()
    const chunks = []; let size = 0
    if (reader) for (;;) {
      const { value, done } = await reader.read(); if (done) break
      size += value.byteLength
      if (size > REGISTRATION) { abort.abort(); return { status: response.status, error: "http-body-overflow" } }
      chunks.push(Buffer.from(value))
    }
    let raw
    try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { return { status: response.status, error: "http-body-unavailable" } }
    const pid = Number.isSafeInteger(raw.pid) ? raw.pid : null
    const version = typeof raw.version === "string" && raw.version.length <= 1024 ? raw.version : null
    return { status: response.status, pid, version, ...(pid !== input.expected.pid || version !== input.expected.version ? failure("http-identity-mismatch") : {}) }
  } catch { return failure(abort.signal.aborted ? "http-timeout" : "http-transport-unavailable") }
  finally { clearTimeout(timer); abort.abort(); void reader?.cancel().catch(() => {}) }
}

function logs(input) {
  const output = { sharedIncarnations: true, files: [], truncated: false }, dir = path.join(input.root, "xdg-data", "opencode", "log")
  let listing, remaining = LOGS
  try {
    const relative = path.relative(realpathSync(input.root), realpathSync(dir))
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw Error()
    listing = opendirSync(dir)
    for (let index = 0; index < 17; index++) {
      const item = listing.readSync(); if (!item) break
      if (index === 16 || !remaining) { output.truncated = true; break }
      if (!item.isFile() || !item.name.endsWith(".log")) continue
      try {
        const evidence = ownedFile(input.root, path.join(dir, item.name), remaining, true)
        remaining -= evidence.bytes.length
        // Free text has arbitrary reversible encodings; export only file metadata.
        output.files.push({ observedBytes: evidence.observedBytes,
          truncated: evidence.truncated, error: evidence.truncated ? "log-truncated-content-omitted" : "log-private-content-omitted" })
      } catch { output.files.push({ error: "log-unavailable" }) }
    }
    if (!output.files.length) output.error = "logs-unavailable"
  } catch { output.error = "logs-unavailable" }
  finally { listing?.closeSync() }
  return output
}

function sql(input) {
  let db
  const hash = text => createHash("sha256").update(text).digest("hex")
  const bounded = (value, limit = 262144) => { if (typeof value !== "string" || Buffer.byteLength(value) > limit) throw Error(); return JSON.parse(value) }
  const textColumn = (name, limit = 240) => `CASE WHEN length(CAST("${name}" AS BLOB))<=${limit} THEN "${name}" END AS "${name}"`
  const id = value => typeof value === "string" && value.length > 0 && value.length <= 240
  try {
    const resolved = realpathSync(input.databaseFile), relative = path.relative(realpathSync(input.root), resolved)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return failure("sql-path-refused")
    db = new DatabaseSync(resolved, { readOnly: true, timeout: 100 })
    db.exec("PRAGMA query_only=ON; BEGIN")
    const rows = db.prepare("SELECT CASE WHEN length(CAST(value AS BLOB))<=262144 THEN value END AS value FROM kv WHERE key>=? AND key<? AND instr(key,'/project/')>0 AND CASE WHEN length(CAST(value AS BLOB))<=262144 THEN json_extract(value,'$.id') END=? LIMIT 2")
      .all(`${input.prefix}codenomad-missions/documents-v1/`, `${input.prefix}codenomad-missions/documents-v1/\uffff`, input.documentID)
    if (rows.length !== 1) return failure("sql-document-unavailable-or-overflow")
    const doc = bounded(rows[0].value), slots = doc.calendarOwner?.slots ?? []
    if (!Array.isArray(slots) || slots.length > 16) return failure("sql-slot-overflow")
    if (!Number.isSafeInteger(doc.revision) || !Number.isSafeInteger(doc.launchedCount)
      || !["paused", "running", "stopped", "finished", "blocked"].includes(doc.state)
      || slots.some(slot => !id(slot.scheduleID) || !id(slot.sessionID) || !["principal", "reconciliation"].includes(slot.role))) return failure("sql-document-incompatible")
    const passage = doc.pending ?? doc.history?.at(-1)
    if (passage && (!id(passage.id) || !id(passage.coordinatorSessionID) || !id(passage.messageID))) return failure("sql-passage-incompatible")
    const sessionRow = sessionID => db.prepare(`SELECT ${textColumn("id")},time_suspended,time_busy,time_idle,${textColumn("idle_outcome", 64)} FROM session_v2 WHERE id=?`).get(sessionID) ?? null
    const proof = row => {
      if (!row) return null
      const { body, ...status } = row
      if (body === null) return { ...status, error: "sql-message-overflow" }
      const data = bounded(body), text = data.text
      const schedule = data.metadata?.schedule
      return { ...status, textBytes: typeof text === "string" ? Buffer.byteLength(text) : null,
        textSHA256: typeof text === "string" ? hash(text) : null,
        schedule: schedule && { id: typeof schedule.id === "string" ? schedule.id.slice(0, 240) : null,
          run: Number.isSafeInteger(schedule.run) ? schedule.run : null, dueAt: Number.isSafeInteger(schedule.dueAt) ? schedule.dueAt : null } }
    }
    let count = 0
    const messages = (table, sessionID, messageID) => {
      if (count++ >= 64) return failure("sql-proof-overflow")
      const column = table === "session_message" ? "data" : "payload"
      return proof(db.prepare(`SELECT ${textColumn("id")},${textColumn("type", 64)},time_created,length(CAST(${column} AS BLOB)) AS bytes,CASE WHEN length(CAST(${column} AS BLOB))<=262144 THEN ${column} END AS body FROM ${table} WHERE id=? AND session_id=?`).get(messageID, sessionID))
    }
    const schedules = slots.map(slot => {
      const schedule = db.prepare(`SELECT ${textColumn("id")},${textColumn("session_id")},${textColumn("status", 64)},next_due_at,run_count,time_created,time_updated,length(CAST("when" AS BLOB)) AS when_bytes,CASE WHEN length(CAST("when" AS BLOB))<=4096 THEN "when" END AS native_when,${textColumn("last_outcome", 4096)},retry_at,${textColumn("last_message_id")} FROM schedule WHERE id=?`).get(slot.scheduleID)
      if (schedule) {
        schedule.whenSHA256 = typeof schedule.native_when === "string" ? hash(schedule.native_when) : null
        delete schedule.native_when
        if (typeof schedule.last_outcome === "string" && !/^[a-z_-]{1,64}$/.test(schedule.last_outcome)) {
          schedule.lastOutcomeSHA256 = hash(schedule.last_outcome); schedule.last_outcome = "omitted"
        }
      }
      const session = sessionRow(slot.sessionID)
      const ids = [...new Set([schedule?.last_message_id, schedule && `msg_${schedule.id}_${schedule.run_count + 1}`].filter(Boolean))]
      return { role: slot.role, ...schedule, session, messages: ids.map(id => ({ id,
        message: messages("session_message", slot.sessionID, id), inbox: messages("session_inbox", slot.sessionID, id) })) }
    })
    const start = passage ? db.prepare(`SELECT ${textColumn("id")},${textColumn("type", 64)},time_created,length(CAST(data AS BLOB)) AS bytes,CASE WHEN length(CAST(data AS BLOB))<=262144 THEN data END AS body FROM session_message WHERE session_id=? AND type IN ('user','synthetic') ORDER BY seq LIMIT ?`)
      .all(passage.coordinatorSessionID, Math.max(0, 64 - count)).map(proof) : []
    const business = passage && (slots.length < 16 ? { sessionID: passage.coordinatorSessionID, session: sessionRow(passage.coordinatorSessionID) }
      : { sessionID: passage.coordinatorSessionID, error: "sql-session-overflow" })
    return { document: { id: doc.id, revision: doc.revision, state: doc.state, launchedCount: doc.launchedCount,
      scheduleActivation: { state: typeof doc.scheduleActivation?.state === "string" && /^[a-z-]{1,64}$/.test(doc.scheduleActivation.state) ? doc.scheduleActivation.state : null },
      calendarOwner: { auxiliaryReady: doc.calendarOwner?.auxiliaryReady === true, slotCount: slots.length,
        operation: { pending: !!doc.calendarOwner?.operation?.pending } },
      pending: doc.pending && { id: doc.pending.id, coordinatorSessionID: doc.pending.coordinatorSessionID, messageID: doc.pending.messageID,
        admissionAttempted: doc.pending.admissionAttempted === true, admittedAt: Number.isSafeInteger(doc.pending.admittedAt) ? doc.pending.admittedAt : null } }, schedules, business, start }
  } catch { return failure("sql-unavailable-schema-lock-or-payload") }
  finally { db?.close() }
}

if (process.argv[2] === "--cold-diagnostic-child") process.once("message", async input => {
  let diagnosticFd
  try {
    // Leave a safe bounded marker even if subsequent native work must be killed.
    if (input.diagnostic) try {
      diagnosticFd = openSync(path.join(realpathSync(input.root), "failure-diagnostic.json"), "wx")
      writeFileSync(diagnosticFd, JSON.stringify({ stage: input.stage, failureAt: input.failureAt, observedAt: Date.now(),
        error: input.ownerAvailable ? "cold-failure-diagnostic-unavailable" : "owned-child-unavailable" }))
    } catch { /* Artifact writes remain best-effort. */ }
    // Unknown ownership still gets the fixed artifact, but no registration, logs,
    // database or endpoint is read, even if an old incarnation's file survives.
    if (!input.ownerAvailable || !validExpected(input.expected) || !await ownerCheck()) {
      process.send(failure("owned-child-unavailable")); return
    }
    const credentials = registration(input)
    const accepted = new Promise(resolve => process.once("message", message => resolve(message.credentialsAccepted === true)))
    process.send({ credentials: credentials.secrets })
    if (!await accepted) throw Error("credentials-unavailable")
    {
      const secrets = [...input.secrets, ...credentials.secrets], redact = fixtureRedactor(secrets)
      const observedAt = Date.now(), http = await infoProbe(input, credentials)
      const evidence = { failureAt: input.failureAt, observedAt, http, logs: logs(input), sql: sql(input) }
      const after = registration(input)
      if (!same(credentials.info, after.info) || credentials.basic !== after.basic || !await ownerCheck()) throw Error("incarnation-changed")
      let json = JSON.stringify(evidence, (_key, value) => typeof value === "string" ? redact(value) : value)
      if (Buffer.byteLength(json) > OUTPUT) json = JSON.stringify({ failureAt: input.failureAt, observedAt, http: { status: http.status }, error: "collector-output-overflow" })
      const safe = JSON.parse(json)
      let saveError
      if (input.diagnostic) try {
        const original = { stage: input.stage, error: input.diagnostic.error?.message === "bounded-product-qualification-deadline"
          ? "bounded-product-qualification-deadline" : "private-text-omitted",
          nativeErrorTail: "private-text-omitted", nativeErrorTruncated: input.diagnostic.nativeErrorTruncated === true }
        let diagnostic = JSON.stringify({ ...original, failureAt: input.failureAt, coldFailure: safe })
        if (Buffer.byteLength(diagnostic) > OUTPUT) diagnostic = JSON.stringify({ stage: input.stage, failureAt: input.failureAt, error: "failure-diagnostic-overflow" })
        if (diagnosticFd === undefined) throw Error("diagnostic-save-unavailable")
        writeSync(diagnosticFd, diagnostic, 0, "utf8"); ftruncateSync(diagnosticFd, Buffer.byteLength(diagnostic))
        writeFileSync(path.join(input.root, "failure-sql.json"), JSON.stringify(safe.sql ?? failure("cold-sql-unavailable")), { flag: "wx" })
      } catch { saveError = "diagnostic-save-unavailable" }
      const result = { evidence: safe, ...(saveError ? { saveError } : {}) }
      if (Buffer.byteLength(JSON.stringify(result)) > OUTPUT) result.evidence = failure("collector-output-overflow")
      process.send(result)
    }
  } catch { process.send(failure("collector-private-evidence-unavailable")) }
  finally { if (diagnosticFd !== undefined) closeSync(diagnosticFd); process.disconnect() }
})
