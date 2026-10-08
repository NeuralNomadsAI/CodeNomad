import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { validateRecurrenceEntryFence, validateRecurrenceMetadataFence } from "./native-recurrence-metadata-fence"

test("schedule metadata CAS requires a native transaction and its current nonce, not a Session", () => {
  const db = new DatabaseSync(":memory:")
  try {
    db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
    const input = { challengeKey: "nonce", nonce: "fresh" }
    db.prepare("INSERT INTO kv VALUES (?,?)").run(input.challengeKey, JSON.stringify(input.nonce))
    assert.throws(() => validateRecurrenceMetadataFence(db, input), /policy-unqualified/)
    assert.equal(validateRecurrenceEntryFence(db, input), true)
    assert.throws(() => validateRecurrenceEntryFence(db, { ...input, nonce: "wrong" }), /policy-unqualified/)
    db.exec("BEGIN IMMEDIATE")
    assert.equal(validateRecurrenceMetadataFence(db, input), true)
    assert.throws(() => validateRecurrenceMetadataFence(db, { ...input, nonce: "wrong" }), /policy-unqualified/)
    db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify("replaced"), input.challengeKey)
    assert.throws(() => validateRecurrenceMetadataFence(db, input), /policy-unqualified/)
    db.exec("ROLLBACK")
  } finally { db.close() }
})
