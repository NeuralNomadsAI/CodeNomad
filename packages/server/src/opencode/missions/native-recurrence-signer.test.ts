import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { acquireRecurrenceSigner } from "./native-recurrence-signer"

test("two offline concurrent Play attempts cannot replace the committed native profile signer", async () => {
  const base = await mkdtemp(path.join(process.env.LOCALAPPDATA ?? "C:/Users/Admin/AppData/Local", "Temp", "opencode", "recurrence-cas-"))
  const file = path.join(base, "offline.sqlite"), a = new DatabaseSync(file), b = new DatabaseSync(file)
  try {
    a.exec("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    a.exec("INSERT INTO kv(key,value) VALUES('schedule','0')")
    const play = async (db: DatabaseSync) => {
      // Both callers start with the same preflight view; only BEGIN IMMEDIATE
      // supplies a current source revision and a first-writer-only signer.
      assert.equal((db.prepare("SELECT value FROM kv WHERE key='schedule'").get() as { value: string }).value, "0")
      await Promise.resolve()
      db.exec("BEGIN IMMEDIATE")
      try {
        if ((db.prepare("SELECT value FROM kv WHERE key='schedule'").get() as { value: string }).value !== "0") throw new Error("revision-conflict")
        const signer = Effect.runSync(acquireRecurrenceSigner(
          () => Effect.sync(() => (db.prepare("SELECT value FROM kv WHERE key='profile'").get() as { value: string } | undefined)?.value),
          value => Effect.sync(() => db.prepare("INSERT INTO kv(key,value) VALUES('profile',?) ON CONFLICT(key) DO NOTHING").run(value)),
          true,
        ))
        db.prepare("UPDATE kv SET value='1' WHERE key='schedule'").run()
        db.prepare("INSERT INTO kv(key,value) VALUES('parent',?)").run(signer.publicKey.export({ format: "der", type: "spki" }).toString("base64"))
        db.exec("COMMIT")
        return signer.publicKey.export({ format: "der", type: "spki" }).toString("base64")
      } catch (error) { db.exec("ROLLBACK"); throw error }
    }
    const results = await Promise.allSettled([play(a), play(b)])
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    assert.equal(results.filter(result => result.status === "rejected").length, 1)
    const winner = results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<string>
    assert.equal((a.prepare("SELECT value FROM kv WHERE key='parent'").get() as { value: string }).value, winner.value)
    assert.equal((b.prepare("SELECT count(*) AS count FROM kv WHERE key='profile'").get() as { count: number }).count, 1)
  } finally { a.close(); b.close(); await rm(base, { recursive: true, force: true }) }
})
