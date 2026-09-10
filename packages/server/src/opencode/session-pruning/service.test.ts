import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "./plugin"
import { storageDirectory } from "./storage-path"
import { storageKey } from "./claim-fence"
import { revision } from "./planner"

// Exercise the real RPC handlers, storage challenge and file-backed transaction.
// No shared service, user configuration or real conversation is involved.
for (const version of ["0.0.0-beta-19425", "future-release", undefined]) {
  test(`pruning uses storage capabilities, not runtime version ${version}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pruning-capabilities-"))
    const filename = path.join(root, "fixture.db")
    const db = new DatabaseSync(filename)
    const content = [{ type: "reasoning", text: "REMOVE" }, { type: "text", text: "KEEP" }]
    const data = { time: { completed: 1 }, content }
    const input = { sessionID: "s", messageID: "m", revision: revision(content), indexes: [0] }
    let handlers: any
    const events: unknown[] = []
    let cleanup: (() => unknown) | void = undefined
    try {
      db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,project_id TEXT,workspace_id TEXT,time_suspended INTEGER,time_compacting INTEGER,revert TEXT);
        CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY,owner_id TEXT);
        INSERT INTO event_sequence VALUES('s',NULL);
        CREATE TABLE event(aggregate_id TEXT);
        CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,time_created INTEGER,time_updated INTEGER);
        CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,data TEXT);`)
      db.prepare("INSERT INTO session_v2 VALUES('s',?,'p',NULL,NULL,NULL,NULL)").run(storageDirectory(root))
      db.prepare("INSERT INTO session_message VALUES('m','s','assistant',?)").run(JSON.stringify(data))
      cleanup = await plugin.setup({
        app: { version },
        options: { databasePath: filename },
        location: { directory: root, project: { id: "p" } },
        session: { get: async () => ({ location: { directory: root }, projectID: "p" }) },
        storage: {
          set: async (key: string, value: unknown) => {
            db.prepare("INSERT INTO kv VALUES(?,?,1,1)").run(storageKey(key), JSON.stringify(value))
          },
          remove: async (key: string) => { db.prepare("DELETE FROM kv WHERE key=?").run(storageKey(key)) },
        },
        rpc: { register: async (_definition: unknown, implementation: unknown) => {
          handlers = implementation
          return { dispose: async () => {}, events: { emit: async (...event: unknown[]) => { events.push(event) } } }
        } },
      } as any)
      assert.equal((await handlers.preview({ sessionID: "s", messageID: "m" })).liveMutation, true)
      const call = { signal: new AbortController().signal }
      // Native storage capabilities still fail closed irrespective of the label.
      db.exec("ALTER TABLE session_v2 RENAME COLUMN time_suspended TO missing_claim")
      assert.deepEqual(await handlers.prune(input, call), { status: "blocked", reason: "unsupported_storage" })
      assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM session_message").get()!.data as string), data)
      assert.equal(events.length, 0)
      db.exec("ALTER TABLE session_v2 RENAME COLUMN missing_claim TO time_suspended")
      db.exec("UPDATE session_v2 SET time_suspended=1")
      assert.deepEqual(await handlers.prune(input, call), { status: "blocked", reason: "maintenance_required" })
      db.exec("UPDATE session_v2 SET time_suspended=NULL")
      const result = await handlers.prune(input, call)
      assert.equal(result.status, "pruned")
      assert.deepEqual(await handlers.prune(input, call), result)
      assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM session_message").get()!.data as string).content, [content[1]])
      assert.equal(events.length, 2)
      assert.equal(db.prepare("SELECT count(*) AS n FROM kv").get()!.n, 1, "only the atomic receipt remains")
    } finally {
      await cleanup?.()
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}
