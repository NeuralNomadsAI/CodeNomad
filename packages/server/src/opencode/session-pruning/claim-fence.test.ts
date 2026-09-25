import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { validateClaimFence, type StorageIdentity } from "./claim-fence"
import { pruneTransaction } from "./transaction"
import { revision } from "./planner"
import { storageDirectory } from "./storage-path"

const identity: StorageIdentity = { directory: "/work", projectID: "p", key: "binding", nonce: "fresh" }
const content = [{ type: "reasoning", text: "remove" }, { type: "text", text: "retain" }]
const input = { sessionID: "s", messageID: "m", revision: revision(content), indexes: [0] }
function fixture() {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,project_id TEXT,workspace_id TEXT,time_suspended INTEGER,time_compacting INTEGER,revert TEXT);
    INSERT INTO session_v2 VALUES('s','/work','p',NULL,NULL,NULL,NULL);
    CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY,owner_id TEXT);
    INSERT INTO event_sequence VALUES('s',NULL);
    CREATE TABLE event(aggregate_id TEXT);
    CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,time_created INTEGER,time_updated INTEGER);
    INSERT INTO kv VALUES('binding','"fresh"',1,1);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,data TEXT);`)
  db.prepare("INSERT INTO session_message VALUES('m','s','assistant',?)").run(JSON.stringify({ time: { completed: 1 }, content }))
  return db
}
const run = (db: DatabaseSync, binding = identity) => pruneTransaction(db, input, () => validateClaimFence(db, input.sessionID, binding), "receipt/")

test("fence requires ownership of the SQLite transaction", () => {
  const db = fixture()
  try { assert.throws(() => validateClaimFence(db, "s", identity), /write transaction/) }
  finally { db.close() }
})

for (const [label, sql] of [
  ["active execution", "UPDATE session_v2 SET time_suspended=1"],
  ["compaction", "UPDATE session_v2 SET time_compacting=1"],
  ["staged revert", "UPDATE session_v2 SET revert='{}'"],
  ["moved session", "UPDATE session_v2 SET directory='/other'"],
  ["changed project", "UPDATE session_v2 SET project_id='other'"],
  ["changed workspace", "UPDATE session_v2 SET workspace_id='other'"],
  ["wrong database challenge", "UPDATE kv SET value='\"snapshot\"'"],
  ["retained event", "INSERT INTO event VALUES('s')"],
  ["remote aggregate owner", "UPDATE event_sequence SET owner_id='remote'"],
  ["unknown trigger", "CREATE TRIGGER writes AFTER UPDATE ON session_message BEGIN SELECT 1; END"],
] as const) test(`rejects ${label} without a content write or receipt`, () => {
  const db = fixture()
  try {
    db.exec(sql)
    const before = db.prepare("SELECT data FROM session_message").get()!.data
    assert.equal(run(db).status, "blocked")
    assert.equal(db.prepare("SELECT data FROM session_message").get()!.data, before)
    assert.equal(db.prepare("SELECT count(*) AS n FROM kv WHERE key LIKE 'receipt/%'").get()!.n, 0)
    assert.equal(db.isTransaction, false)
  } finally { db.close() }
})

test("missing native claim storage rolls back without a content write or receipt", () => {
  const db = fixture()
  try {
    db.exec("ALTER TABLE session_v2 RENAME COLUMN time_suspended TO missing_claim")
    assert.equal(run(db).status, "blocked")
    assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM session_message").get()!.data as string).content, content)
    assert.equal(db.prepare("SELECT count(*) AS n FROM kv WHERE key LIKE 'receipt/%'").get()!.n, 0)
    assert.equal(db.isTransaction, false)
  }
  finally { db.close() }
})

test("commit and receipt are atomic, and repeated delivery never deletes a second block", () => {
  const db = fixture()
  try {
    const result = run(db)
    assert.equal(result.status, "pruned")
    assert.deepEqual(run(db), result)
    assert.equal(db.prepare("SELECT count(*) AS n FROM kv WHERE key LIKE 'receipt/%'").get()!.n, 1)
    assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM session_message").get()!.data as string).content, [content[1]])
    assert.equal(db.isTransaction, false)
  } finally { db.close() }
})

test("a failed receipt insert rolls back the content change", () => {
  const db = fixture()
  try {
    // Inject a storage failure without a trigger, which the fence rightly rejects.
    db.exec("DROP TABLE kv; CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,time_created INTEGER CHECK(time_created < 2),time_updated INTEGER); INSERT INTO kv VALUES('binding','\"fresh\"',1,1)")
    assert.throws(() => run(db))
    assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM session_message").get()!.data as string).content, content)
    assert.equal(db.isTransaction, false)
  } finally { db.close() }
})

test("Windows directory encoding agrees with native SQLite storage", () => {
  const directory = "C:\\work\\project"
  assert.equal(storageDirectory(directory), process.platform === "win32" ? "C:/work/project" : directory)
})
