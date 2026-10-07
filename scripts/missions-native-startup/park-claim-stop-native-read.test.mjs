// Local synthetic SQLite only; never open an OpenCode database or native service.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { observeNative, sameOriginal } from './park-claim-stop-fence.mjs'

const root = mkdtempSync('C:/Users/Admin/AppData/Local/Temp/opencode/park-retire-check-')
const directory = path.join(root, 'project'), dbPath = path.join(root, 'fixture.db')
mkdirSync(directory)
const nonce = '00000000-0000-4000-8000-000000000004'
const sessionID = 'fixture-root', inputID = `msg_park_${nonce.replaceAll('-', '')}`
const text = 'synthetic exact-root original input', digest = value => createHash('sha256').update(value).digest('hex')
const createdAt = Date.now() - 1000
Object.assign(process.env, { NATIVE_STARTUP_ROOT: root, NATIVE_STARTUP_NONCE: nonce,
  NATIVE_STARTUP_PERSISTED_NONCE: nonce, OPENCODE_DB: dbPath })
const enrolled = { root, nonce, directory, sessionID, inputID, promptHash: digest(text),
  permission: { id: 'fixture-permission', effect: 'allow' }, watch: {
    pendingID: `finite_watch_${nonce.replaceAll('-', '')}`, createdAt, deadlineAt: createdAt + 120_000 } }
const db = new DatabaseSync(dbPath)
db.exec(`CREATE TABLE session_v2 (id TEXT, directory TEXT, parent_id TEXT, project_id TEXT, workspace_id TEXT,
  agent TEXT, time_suspended INTEGER, resume_attempts INTEGER, time_compacting INTEGER, time_archived INTEGER);
  CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
  CREATE TABLE session_pending (session_id TEXT);
  CREATE TABLE session_inbox (session_id TEXT);`)
db.prepare('INSERT INTO session_v2 VALUES (?, ?, NULL, ?, NULL, ?, ?, 0, NULL, NULL)')
  .run(sessionID, directory, 'fixture-project', 'build', createdAt + 1)
db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)')
  .run(inputID, sessionID, 'user', 1, createdAt, JSON.stringify({ text }))
const event = { sessionID, messages: [{ id: inputID, role: 'user', content: [{ type: 'text', text }] }] }
const observed = observeNative(enrolled, event)
assert.equal(observed.claimAt, createdAt + 1)
assert.equal(observed.inputID, inputID)
assert.equal(observed.generation, 1)
assert.throws(() => observeNative(enrolled, { ...event, messages: [{ ...event.messages[0], id: 'foreign' }] }))
db.prepare('UPDATE session_v2 SET time_suspended = ? WHERE id = ?').run(createdAt + 2, sessionID)
assert.throws(() => sameOriginal(observed, observeNative(enrolled, event)), /Original native intent changed/)
db.prepare('UPDATE session_v2 SET time_suspended = ? WHERE id = ?').run(createdAt + 1, sessionID)
db.prepare('INSERT INTO session_pending VALUES (?)').run(sessionID)
assert.throws(() => observeNative(enrolled, event), /Other native work present/)
db.close()
console.log(JSON.stringify({ checks: 4, nativeOperations: 0, syntheticDatabaseOnly: true, originalInputAndClaimObserved: true }))
