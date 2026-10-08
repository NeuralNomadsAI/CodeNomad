import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { Context, Effect } from "effect"
import { Location } from "@opencode/schema/location"
import { Schema } from "effect"
import { authoritySignerDigest } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { authenticateRecurrenceStanding } from "../../missions/recurrence-authority-contract"
import { RECURRENCE_STORAGE_PREFIX } from "../../missions/recurrence-contract"
import { stableToken } from "../../missions/journal"
import { physical } from "../../missions/host-authority/private-files"
import { readFamilyAuthorityIdentitySync } from "../../workspaces/family-authority-claim"
import { controlNativeRecurrence } from "./native-recurrence-control"
import { signNativeRecurrenceControl } from "../../missions/recurrence-control-proof"
import { readNativeRecurrenceSnapshot } from "./native-recurrence-snapshot"

const encode = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`

test("real Effect SQLite atomically archives human-signed epochs and fences stale/forged control", async () => {
  const base = await mkdtemp(path.join(process.env.LOCALAPPDATA ?? "C:/Users/Admin/AppData/Local", "Temp", "opencode", "recurrence-control-"))
  const previous = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = base
  const directory = process.cwd(), checkout = physical(directory), family = readFamilyAuthorityIdentitySync(directory)
  const db = new DatabaseSync(path.join(base, "native.sqlite"))
  try {
    db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL)")
    const bridge = path.join(base, "CodeNomad", "automation-bridges"), token = "s".repeat(48)
    await mkdir(bridge, { recursive: true })
    await writeFile(path.join(bridge, `100-100-${token.slice(0, 12)}.json`), JSON.stringify({ token }))
    const put = (key: string, value: unknown) => db.prepare("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,0,0)").run(encode(key), JSON.stringify(value))
    const get = (key: string) => { const row = db.prepare("SELECT value FROM kv WHERE key=?").get(encode(key)) as { value: string } | undefined; return row && JSON.parse(row.value) }
    const namespace = "9f6f590e-271d-477f-8c02-7a6a119d63b9", profileID = "a".repeat(64)
    put(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, namespace)
    const config = { consigne: "Inspect", clock: { time: "07:00", zone: "UTC" }, profileID, executionHost: "local",
      profiles: { coordinator: { agent: "worker", model: { providerID: "provider", id: "model" } },
        roles: { specialist: { agent: "worker", model: { providerID: "provider", id: "model" } } } },
      taskMode: "native", roots: [{ mode: "git", directory, checkout, family }],
      watchedConversationIDs: [], publication: { policy: "draft-only", conversationIDs: [] } }
    const id = "daily_review", projectID = "project", projectCanonical = checkout
    const sourceKey = `${RECURRENCE_STORAGE_PREFIX}/project/${stableToken(`${projectID}\0${projectCanonical}`, 24)}/${id}`
    put(sourceKey, { version: 1, projectID, projectCanonical, id, revision: 0, scheduleRevision: 0,
      createdAt: 100, state: "paused", config, lastDaily: null, settledCount: 0, cursors: [], pending: null, history: [] })
    const dbTag = Context.Service<never, unknown>("@opencode/storage/Database")
    const locationTag = Context.Service<never, unknown>("@opencode/Location")
    const jobTag = Context.Service<never, unknown>("@opencode/Job")
    const mapTag = Context.Service<never, unknown>("@opencode/example/LocationServiceMap")
    const sessionTag = Context.Service<never, unknown>("@opencode/Session")
    const location = Schema.decodeUnknownSync(Location.Info)({ directory,
      project: { id: projectID, directory, canonical: projectCanonical } })
    const jobs = new Map<string, { id: string; status: string; metadata: Record<string, unknown> }>()
    const job = { get: (key: string) => Effect.succeed(jobs.get(key)),
      start: (value: { id: string; metadata: Record<string, unknown> }) => Effect.sync(() => {
        const stored = { ...value, status: "running" }; jobs.set(value.id, stored); return stored
      }), cancel: (key: string) => Effect.sync(() => { const stored = jobs.get(key); if (stored) stored.status = "cancelled" }) }
    let graph: Context.Context<never>
    const client = Object.assign(() => {}, { unsafe: (sql: string, parameters: readonly unknown[]) => ({
      withoutTransform: Effect.sync(() => db.prepare(sql).all(...parameters as []) as Record<string, unknown>[]),
    }) })
    const nativeDB = { db: { $client: client, transaction: (run: () => Effect.Effect<unknown>) => Effect.promise(async () => {
      db.exec("BEGIN IMMEDIATE")
      try { const value = await Effect.runPromiseWith(graph)(run()); db.exec("COMMIT"); return value }
      catch (error) { db.exec("ROLLBACK"); throw error }
    }) } }
    graph = Context.make(dbTag, nativeDB).pipe(Context.add(locationTag, location), Context.add(jobTag, job),
      Context.add(mapTag, {}), Context.add(sessionTag, {}))
    const storage = { get: (key: string) => Effect.sync(() => get(key)), set: (key: string, value: unknown) => Effect.sync(() => {
      db.prepare("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,0,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(encode(key), JSON.stringify(value))
    }), scan: ({ prefix, after, limit }: { prefix: string; after?: string; limit: number }) => Effect.sync(() => {
      const values = db.prepare("SELECT key,value FROM kv WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?")
        .all(encode(prefix).length, encode(prefix), encode(after ?? prefix), limit + 1) as Array<{ key: string; value: string }>
      const entries = values.slice(0, limit).map(row => ({ key: row.key.slice(encode("").length), value: JSON.parse(row.value) }))
      return { entries, ...(values.length > limit ? { next: entries.at(-1)!.key } : {}) }
    }) }
    const ctx = { storage, location } as unknown as Parameters<typeof controlNativeRecurrence>[0]
    const profileSource = { profileID, executionHost: config.executionHost, configYamlPath: path.join(base, "config.yaml") }
    const request = (action: "play" | "pause" | "stop", expectedRevision: number) => {
      const body = { scheduleID: id, expectedRevision, action, profileSource, issuedAt: Date.now() }
      return { ...body, proof: signNativeRecurrenceControl(body, token) }
    }
    const call = (value: unknown) => Effect.runPromiseWith(graph)(controlNativeRecurrence(ctx, value))
    const snapshot = () => Effect.runPromiseWith(graph)(readNativeRecurrenceSnapshot(ctx))
    assert.equal((await snapshot()).schedules[0]?.state, "unavailable", "unsigned paused metadata is unavailable")
    await assert.rejects(call({ ...request("play", 0), proof: "0".repeat(64) }))
    assert.equal(get(sourceKey).revision, 0)
    assert.equal((await call(request("play", 0))).state, "running")
    assert.equal((await snapshot()).schedules[0]?.state, "interrupted", "unloaded Location cannot silently rearm")
    const key = `${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/${profileID}`
    const secret = get(key)
    assert.equal(typeof secret, "string")
    // Read the native live key directly from SQLite: its scope binds the exact DB inode.
    const live = (db.prepare("SELECT value FROM kv WHERE key LIKE ? AND key LIKE ?").get(
      `%${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence/%`, "%/live") as { value: string })
    const parent = JSON.parse(live.value).parent
    const { createPrivateKey, createPublicKey } = await import("node:crypto")
    const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(secret, "base64"), format: "der", type: "pkcs8" }))
    assert.equal(parent.body.signerDigest, authoritySignerDigest(publicKey))
    assert.equal(parent.body.requestID.startsWith("rhuman_"), true)
    assert.equal(authenticateRecurrenceStanding(parent, [{ ...parent.body, publicKey,
      policy: "codenomad.missions.authority/signed-v1", qualification: "qualified" }]).signed.signature, parent.signature)
    await assert.rejects(call(request("play", 0)))
    assert.equal(get(sourceKey).revision, 1)
    assert.equal((await call(request("pause", 1))).state, "paused")
    assert.equal((await snapshot()).schedules[0]?.state, "paused")
    assert.equal(get(sourceKey).state, "paused")
    assert.equal([...jobs.values()][0]?.status, "cancelled")
    const liveValue = JSON.parse((db.prepare("SELECT value FROM kv WHERE key LIKE ? AND key LIKE ?").get(
      `%${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence/%`, "%/live") as { value: string }).value)
    const parentKey = (db.prepare("SELECT key,value FROM kv WHERE key LIKE ? AND key LIKE ?").get(
      `%${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence/%`, "%/parents/2") as { key: string; value: string })
    db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify({ ...liveValue.parent, signature: "A".repeat(86) + "==" }), parentKey.key)
    await assert.rejects(call(request("stop", 2)))
    assert.equal(get(sourceKey).revision, 2, "forged archived parent cannot authorize a denial")
    db.prepare("UPDATE kv SET value=? WHERE key=?").run(parentKey.value, parentKey.key)
    assert.equal((await call(request("stop", 2))).state, "stopped")
    assert.equal((await snapshot()).schedules[0]?.state, "stopped")
    assert.equal(get(sourceKey).state, "stopped")
    assert.equal([...jobs.values()][0]?.status, "cancelled")
    await assert.rejects(call(request("play", 3)))
    assert.equal(get(sourceKey).revision, 3)
  } finally {
    db.close()
    if (previous === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous
    await rm(base, { recursive: true, force: true })
  }
})
