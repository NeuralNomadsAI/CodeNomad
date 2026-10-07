// SOURCE-ONLY fixture metadata. No native cancellation, resume or protected Mission grant.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Effect, Schema } from 'effect'

const hash = value => createHash('sha256').update(value).digest('hex')
const text = Schema.String, integer = Schema.Number
const bindingSchema = Schema.Struct({ version: Schema.Literal(1), nonce: text, root: text, directory: text,
  sessionID: text, inputID: text, pendingID: text, permissionID: text, createdAt: integer, deadlineAt: integer,
  claimAt: integer, inputHash: text, dbPath: text, dbIdentity: text, executable: text, executableIdentity: text,
  projectID: text, workspaceID: Schema.NullOr(text), generation: integer, hostPID: integer, jobID: text })
const keys = Object.keys(bindingSchema.fields).sort()
export const decodeBinding = raw => {
  const value = Schema.decodeUnknownSync(bindingSchema)(raw)
  assert.deepEqual(Object.keys(raw).sort(), keys, 'Unexpected binding field')
  for (const key of keys) if (typeof value[key] === 'string') assert.ok(value[key].length <= 1024, 'Oversized fixture binding')
  assert.match(value.nonce, /^[A-Za-z0-9-]{8,80}$/)
  for (const key of ['sessionID', 'inputID', 'permissionID', 'projectID']) assert.match(value[key], /^[A-Za-z0-9_-]{1,160}$/)
  for (const key of ['createdAt', 'deadlineAt', 'claimAt', 'generation', 'hostPID']) assert.ok(Number.isSafeInteger(value[key]) && value[key] > 0)
  assert.ok(value.generation <= 2, 'Finite fixture allows only original and one cold generation')
  assert.equal(value.deadlineAt - value.createdAt, 120_000)
  assert.ok(value.claimAt >= value.createdAt && value.claimAt <= value.deadlineAt)
  assert.equal(value.inputID, `msg_park_${value.nonce.replaceAll('-', '')}`)
  assert.equal(value.pendingID, `finite_watch_${value.nonce.replaceAll('-', '')}`)
  assert.equal(value.jobID, `job_missions_fixture_${value.nonce.replaceAll('-', '')}_shutdown`)
  assert.equal(path.resolve(value.directory), path.join(value.root, 'project'))
  assert.equal(path.resolve(value.dbPath), path.join(value.root, 'fixture.db'))
  for (const key of ['inputHash', 'dbIdentity', 'executableIdentity']) assert.match(value[key], /^[a-f0-9]{64}$/)
  assert.ok(path.isAbsolute(value.executable))
  return Object.freeze(value)
}
export const bindingHash = value => hash(JSON.stringify(keys.map(key => decodeBinding(value)[key])))
const originalKeys = keys.filter(key => !['generation', 'hostPID'].includes(key))
export const sameOriginal = (a, b) => assert.deepEqual(originalKeys.map(key => decodeBinding(a)[key]), originalKeys.map(key => decodeBinding(b)[key]), 'Original native intent changed')
const ownedRoot = root => {
  assert.equal(path.dirname(path.resolve(root)), 'C:\\Users\\Admin\\AppData\\Local\\Temp\\opencode')
  assert.match(path.basename(root), /^(?:missions-startup-|park-retire-check-|park-jobs-only-check-)[A-Za-z0-9-]+$/)
  assert.equal(lstatSync(root).isSymbolicLink(), false)
  assert.equal(realpathSync(root), path.resolve(root))
  return path.resolve(root)
}
const file = (binding, name) => path.join(ownedRoot(decodeBinding(binding).root), `park-stop-${name}.json`)
const readJSON = filename => {
  const info = lstatSync(filename)
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 8192)
  return JSON.parse(readFileSync(filename, 'utf8'))
}
const optionalJSON = filename => {
  try { return readJSON(filename) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
const writeExclusive = (filename, value) => {
  // A partial/uncertain reservation remains in place and denies admission; never steal/delete it.
  const bytes = JSON.stringify(value)
  assert.ok(Buffer.byteLength(bytes) <= 8192)
  const fd = openSync(filename, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
}
export const acquireGate = binding => {
  const filename = file(binding, 'gate'), token = { token: randomUUID(), binding: bindingHash(binding) }
  writeExclusive(filename, token)
  return () => { assert.deepEqual(readJSON(filename), token); unlinkSync(filename) }
}
const infoIdentity = filename => {
  const info = lstatSync(filename)
  assert.ok(info.isFile() && !info.isSymbolicLink())
  return hash(JSON.stringify([realpathSync(filename), info.dev, info.ino]))
}
// One exact enrolled root/input; no listSuspended/inventory, SQL mutation, service lookup or candidate loop.
export const observeNative = (enrolled, event) => {
  const root = ownedRoot(enrolled.root), dbPath = path.join(root, 'fixture.db')
  assert.equal(path.resolve(process.env.NATIVE_STARTUP_ROOT), root)
  assert.equal(enrolled.nonce, process.env.NATIVE_STARTUP_NONCE)
  assert.equal(enrolled.nonce, process.env.NATIVE_STARTUP_PERSISTED_NONCE)
  assert.equal(path.resolve(process.env.OPENCODE_DB), dbPath)
  assert.equal(realpathSync(dbPath), dbPath)
  assert.equal(enrolled.permission.effect, 'allow')
  assert.equal(path.resolve(enrolled.directory), path.join(root, 'project'))
  assert.match(enrolled.promptHash, /^[a-f0-9]{64}$/)
  const dbIdentity = infoIdentity(dbPath), db = new DatabaseSync(dbPath, { readOnly: true })
  let row, message
  try {
    db.exec('BEGIN')
    row = db.prepare(`SELECT id, directory, parent_id, project_id, workspace_id, agent, time_suspended,
      resume_attempts, time_compacting, time_archived FROM session_v2 WHERE id = ?`).get(enrolled.sessionID)
    message = db.prepare('SELECT id, session_id, type, seq, time_created, data FROM session_message WHERE id = ? AND session_id = ?').get(enrolled.inputID, enrolled.sessionID)
    assert.ok(row && message, 'Original native claim/promoted message missing')
    assert.equal(row.id, enrolled.sessionID)
    assert.equal(path.resolve(row.directory), path.join(root, 'project'))
    assert.equal(row.parent_id, null)
    assert.equal(row.agent, 'build')
    assert.equal(row.time_compacting, null)
    assert.equal(row.time_archived, null)
    assert.equal(message.type, 'user')
    assert.ok(typeof message.data === 'string' && Buffer.byteLength(message.data) <= 4096, 'Oversized original native message')
    const data = JSON.parse(message.data)
    assert.equal(hash(data.text), enrolled.promptHash, 'Original admitted prompt modified')
    assert.ok(['files', 'agents', 'skills'].every(key => data[key] === undefined || data[key].length === 0))
    const other = db.prepare(`SELECT
      EXISTS(SELECT 1 FROM session_pending WHERE session_id = ?) AS pending,
      EXISTS(SELECT 1 FROM session_inbox WHERE session_id = ?) AS inbox,
      EXISTS(SELECT 1 FROM session_v2 WHERE parent_id = ?) AS children,
      EXISTS(SELECT 1 FROM session_message WHERE session_id = ? AND
        ((type IN ('user', 'synthetic', 'shell', 'compaction', 'assistant') AND id != ?) OR
        (seq > ? AND type != 'idle'))) AS changed`).get(row.id, row.id, row.id, row.id, message.id, message.seq)
    assert.deepEqual(Object.values(other), [0, 0, 0, 0], 'Other native work present')
    if (event) {
      assert.equal(event.sessionID, row.id)
      const last = event.messages.at(-1)
      assert.equal(last?.id, message.id, 'Context does not end in original promoted input')
      assert.equal(last.role, 'user')
      assert.equal(hash(last.content.filter(part => part.type === 'text').map(part => part.text).join('')), enrolled.promptHash)
    }
  } finally { db.close() }
  assert.equal(infoIdentity(dbPath), dbIdentity)
  const executable = realpathSync(process.execPath), exe = lstatSync(executable)
  return decodeBinding({ version: 1, nonce: enrolled.nonce, root, directory: path.join(root, 'project'),
    sessionID: row.id, inputID: message.id, pendingID: enrolled.watch.pendingID, permissionID: enrolled.permission.id,
    createdAt: enrolled.watch.createdAt, deadlineAt: enrolled.watch.deadlineAt, claimAt: row.time_suspended,
    inputHash: hash(JSON.stringify([message.id, message.seq, message.time_created, message.data])),
    dbPath, dbIdentity, executable, executableIdentity: hash(JSON.stringify([executable, exe.dev, exe.ino, exe.size, exe.mtimeMs])),
    projectID: row.project_id, workspaceID: row.workspace_id, generation: row.resume_attempts + 1,
    hostPID: process.pid, jobID: `job_missions_fixture_${enrolled.nonce.replaceAll('-', '')}_shutdown` })
}
export const readEnrollment = root => readJSON(path.join(ownedRoot(root), 'claim-enrollment.json'))
export const bindGeneration = observed => {
  const binding = decodeBinding(observed), release = acquireGate(binding)
  try {
    const filename = file(binding, 'original'), original = optionalJSON(filename)
    if (original) {
      sameOriginal(original, binding)
      if (binding.generation > original.generation) {
        assert.notEqual(binding.hostPID, original.hostPID, 'Cold generation requires a different native process')
        assert.deepEqual(readJSON(file(binding, 'ack-1')), { bindingHash: bindingHash(original), state: 'AdmissionAcknowledged' },
          'Unknown original Job ACK cannot be reconstructed automatically')
      }
    }
    else { assert.equal(binding.generation, 1, 'Cold entry cannot invent original binding'); writeExclusive(filename, binding) }
    const generationFile = file(binding, `generation-${binding.generation}`), current = optionalJSON(generationFile)
    if (current) assert.equal(bindingHash(current), bindingHash(binding), 'Generation/host replaced')
    else writeExclusive(generationFile, binding)
    // Includes a valid older-generation Stop; cold entry never extends or re-adopts that watch.
    return { binding, stopped: readStop(binding) !== undefined }
  } finally { release() }
}
const persisted = binding => {
  sameOriginal(readJSON(file(binding, 'original')), binding)
  assert.equal(bindingHash(readJSON(file(binding, `generation-${binding.generation}`))), bindingHash(binding))
}
export const reserveJobStart = binding => {
  persisted(binding)
  writeExclusive(file(binding, `start-${binding.generation}`), { bindingHash: bindingHash(binding), state: 'AdmissionPending' })
}
export const recordJobACK = binding => {
  persisted(binding)
  assert.deepEqual(readJSON(file(binding, `start-${binding.generation}`)), { bindingHash: bindingHash(binding), state: 'AdmissionPending' })
  writeExclusive(file(binding, `ack-${binding.generation}`), { bindingHash: bindingHash(binding), state: 'AdmissionAcknowledged' })
}
export const readStop = binding => {
  const stop = optionalJSON(file(binding, 'reservation'))
  if (!stop) {
    // An interrupted intent write is unknown, never a reason to admit more work.
    assert.equal(optionalJSON(file(binding, 'intent')), undefined, 'Stop intent without reservation')
    return undefined
  }
  assert.deepEqual(Object.keys(stop).sort(), ['binding', 'requestID', 'state'].sort())
  assert.equal(stop.state, 'StopPending')
  assert.match(stop.requestID, /^fixture-human-stop-[A-Za-z0-9_-]{1,100}$/)
  const original = readJSON(file(binding, 'original'))
  sameOriginal(original, binding)
  sameOriginal(original, stop.binding)
  assert.ok(stop.binding.generation <= binding.generation, 'Future Stop generation cannot be borrowed')
  assert.equal(bindingHash(readJSON(file(binding, `generation-${stop.binding.generation}`))), bindingHash(stop.binding))
  assert.deepEqual(readJSON(file(binding, 'intent')), { requestID: stop.requestID, bindingHash: bindingHash(stop.binding) })
  return stop
}
export const assertEffectAllowed = (binding, stage) => {
  assert.ok(['adopt', 'expiry'].includes(stage))
  persisted(binding)
  if (readStop(binding)) return false
  if (stage === 'adopt') assert.ok(Date.now() < binding.deadlineAt, 'Finite horizon expired')
  return true
}
export const guarded = (binding, stage, effect) => Effect.acquireUseRelease(
  Effect.sync(() => acquireGate(binding)),
  () => Effect.suspend(() => assertEffectAllowed(binding, stage) ? effect : Effect.interrupt),
  release => Effect.sync(release),
)
// Synthetic producer only. No human-control provenance or native Stop RPC is qualified here.
export const writeStopIntent = (binding, requestID) => {
  const release = acquireGate(binding)
  try {
    persisted(binding)
    assert.match(requestID, /^fixture-human-stop-[A-Za-z0-9_-]{1,100}$/)
    writeExclusive(file(binding, 'intent'), { requestID, bindingHash: bindingHash(binding) })
  } finally { release() }
}
export const reserveStop = (binding, requestID) => {
  const release = acquireGate(binding)
  try {
    persisted(binding)
    assert.deepEqual(readJSON(file(binding, 'intent')), { requestID, bindingHash: bindingHash(binding) })
    const existing = optionalJSON(file(binding, 'reservation')) && readStop(binding)
    if (existing) { assert.equal(existing.requestID, requestID); return { admission: 'existing-no-replay', reservation: existing } }
    const reservation = { binding: decodeBinding(binding), requestID, state: 'StopPending' }
    writeExclusive(file(binding, 'reservation'), reservation)
    return { admission: 'new', reservation }
  } finally { release() }
}
