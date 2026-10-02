import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { readSessionOutline } from "./outline-index"

for (const phase of ["headers", "projection"] as const) test(`outline ${phase} admit pending cancellation before consuming an expensive checkpoint`, async (t) => {
  const db = new DatabaseSync(":memory:")
  let reads = 0
  let clock = 0
  const controller = new AbortController()
  let pending: ReturnType<typeof setImmediate> | undefined
  const freeReads = phase === "projection" ? 512 : 0
  // Charge a deterministic cost to SQLite payload access instead of asserting
  // wall-clock timing on CI. The real SQL/iterator/transaction still execute.
  db.function("payload", (data) => {
    reads++
    if (reads > freeReads) {
      clock += 2
      pending ??= setImmediate(() => controller.abort())
    }
    return data
  })
  t.mock.method(performance, "now", () => clock)
  db.exec(`CREATE TABLE session_v2(id TEXT,directory TEXT,project_id TEXT,workspace_id TEXT,revert TEXT);
    CREATE TABLE stored_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT,time_updated INTEGER);
    CREATE UNIQUE INDEX stored_session_seq ON stored_messages(session_id,seq);
    CREATE VIEW session_message AS SELECT id,session_id,type,seq,payload(data) AS data,time_updated FROM stored_messages;
    INSERT INTO session_v2 VALUES ('s','/repo','p',NULL,NULL);`)
  const insert = db.prepare("INSERT INTO stored_messages VALUES (?,'s','assistant',?,?,0)")
  for (let i = 0; i < 512; i++) insert.run(`m${i}`, i, '{"content":[{"type":"tool","name":"read"}]}')
  try {
    await assert.rejects(readSessionOutline(db, { directory: "/repo", projectID: "p", sessionID: "s" },
      undefined, controller.signal), /abort/i)
    assert(reads - freeReads < 32, `cancelled scan accessed ${reads - freeReads} expensive payloads before giving the event loop a turn`)
    assert.equal(db.isTransaction, false, "cancellation releases its read snapshot")
  } finally { if (pending) clearImmediate(pending); db.close() }
})
