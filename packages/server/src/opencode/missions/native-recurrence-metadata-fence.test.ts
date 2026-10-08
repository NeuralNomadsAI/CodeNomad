import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { storageDirectory } from "../session-pruning/storage-path"
import { validateRecurrenceMetadataFence } from "./native-recurrence-metadata-fence"

test("native metadata CAS accepts legitimate session events; rejects lost claim, placement and maintenance", () => {
  const db = new DatabaseSync(":memory:")
  try {
    db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,project_id TEXT,workspace_id TEXT,time_suspended INTEGER,time_compacting INTEGER,revert TEXT);
      CREATE TABLE event_sequence(aggregate_id TEXT,owner_id TEXT);
      CREATE TABLE event(aggregate_id TEXT);`)
    const input = { sessionID: "ses_real", directory: "C:\\checkout", projectID: "project", challengeKey: "nonce", nonce: "fresh" }
    db.prepare("INSERT INTO kv VALUES (?,?)").run(input.challengeKey, JSON.stringify(input.nonce))
    db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?)").run(input.sessionID, storageDirectory(input.directory), input.projectID, null, null, null, null)
    db.prepare("INSERT INTO event_sequence VALUES (?,?)").run(input.sessionID, "native-running-owner")
    db.prepare("INSERT INTO event VALUES (?)").run(input.sessionID)
    assert.throws(() => validateRecurrenceMetadataFence(db, input), /policy-unqualified/)
    db.exec("BEGIN IMMEDIATE")
    assert.equal(validateRecurrenceMetadataFence(db, input), true)
    assert.throws(() => validateRecurrenceMetadataFence(db, { ...input, nonce: "wrong" }), /policy-unqualified/)
    assert.throws(() => validateRecurrenceMetadataFence(db, { ...input, projectID: "foreign" }), /policy-unqualified/)
    db.prepare("UPDATE session_v2 SET time_compacting=1 WHERE id=?").run(input.sessionID)
    assert.throws(() => validateRecurrenceMetadataFence(db, input), /policy-unqualified/)
    db.exec("ROLLBACK")
  } finally { db.close() }
})
