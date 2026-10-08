import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { Context, Effect, Schema } from "effect"
import { Location } from "@opencode/schema/location"
import { authorityDigest, authoritySignerDigest } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { RECURRENCE_AUTHORITY_POLICY, recurrenceHumanRequestID, recurrenceStandingSigningBytes, recurrenceStandingIntentSchema } from "../../missions/recurrence-authority-contract"
import { NativeRecurrenceAuthorityStore } from "../../missions/recurrence-authority-store"
import { RECURRENCE_STORAGE_PREFIX, type RecurrenceConfig } from "../../missions/recurrence-contract"
import { stableToken } from "../../missions/journal"
import { nativeDatabaseStorageID } from "./native-database-identity"
import { readNativeRecurrenceSnapshot } from "./native-recurrence-snapshot"
import { readNativeRecurrenceControlStatus } from "./native-recurrence-control-status"

test("lost control ACK reads its exact signed epoch without replay, state writes or optimistic capability", async () => {
  const base = await mkdtemp(path.join(process.env.LOCALAPPDATA ?? "C:/Users/Admin/AppData/Local", "Temp", "opencode", "recurrence-status-"))
  const file = path.join(base, "offline.sqlite"), db = new DatabaseSync(file)
  try {
    db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER,time_updated INTEGER)")
    const prefix = `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`
    const put = (key: string, value: unknown) => db.prepare("INSERT INTO kv VALUES(?,?,0,0)").run(prefix + key, JSON.stringify(value))
    const get = (key: string) => { const row = db.prepare("SELECT value FROM kv WHERE key=?").get(prefix + key) as { value: string } | undefined; return row && JSON.parse(row.value) }
    const config: RecurrenceConfig = { template: "custom", consigne: "Offline", clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "local",
      profiles: { coordinator: { agent: "worker", model: { providerID: "provider", id: "model" } }, roles: { specialist: { agent: "worker", model: { providerID: "provider", id: "model" } } } },
      taskMode: "native", roots: [{ mode: "directory-only", directory: base }], watchedConversationIDs: [],
      budgets: { effects: 3, nativeCalls: 0, inboxMessages: 0, publications: 0 }, publication: { policy: "disabled", conversationIDs: [] } }
    const location = Schema.decodeUnknownSync(Location.Info)({ directory: base, project: { id: "project", canonical: base, directory: base } })
    const scope = { namespace: "9f6f590e-271d-477f-8c02-7a6a119d63b9", projectID: "project", projectCanonical: base,
      scheduleID: "daily_review", profileID: config.profileID, executionHost: config.executionHost, daemonStorageID: nativeDatabaseStorageID(file) }
    const authority = new NativeRecurrenceAuthorityStore({ get: async () => undefined, set: async () => {}, scan: async () => ({ entries: [] }) }, scope)
    const keys = generateKeyPairSync("ed25519"), digest = authoritySignerDigest(keys.publicKey)
    const body = recurrenceStandingIntentSchema.parse({ ...scope, authorityID: "authority", keyID: "key", roots: config.roots,
      version: 1, policy: RECURRENCE_AUTHORITY_POLICY, epoch: 1, expectedRevision: null, expectedScheduleRevision: 0,
      scheduleRevision: 0, requestID: recurrenceHumanRequestID(scope.scheduleID, 1, "authorize"), action: "authorize",
      provisioningGeneration: digest, signerDigest: digest, config, configDigest: authorityDigest(config), budgets: config.budgets,
      profileSource: { profileID: config.profileID, executionHost: config.executionHost, configYamlPath: path.join(base, "config.yaml") } })
    const parent = { body, signature: sign(null, recurrenceStandingSigningBytes(body), keys.privateKey).toString("base64") }
    put(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, scope.namespace)
    put(`${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/profile`, keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"))
    put(authority.key, { version: 1, scope, revision: 0, parent, settledSequence: 0, child: null, lastArchiveDigest: null })
    put(`${authority.parentKey}/parents/1`, parent)
    put(`${RECURRENCE_STORAGE_PREFIX}/project/${stableToken(`project\0${base}`, 24)}/daily_review`, {
      version: 1, projectID: "project", projectCanonical: base, id: "daily_review", revision: 1, scheduleRevision: 0,
      createdAt: 100, state: "running", config, lastDaily: null, pending: null, history: [], settledCount: 0, cursors: [] })
    const client = Object.assign(() => {}, { unsafe: (sql: string, params: readonly unknown[]) => ({ withoutTransform: Effect.sync(() => db.prepare(sql).all(...params as [])) }) })
    const graph = Context.make(Context.Service<never, unknown>("@opencode/storage/Database"), { db: { $client: client,
      transaction: () => Effect.die("read must not begin a mutation") } }).pipe(Context.add(Context.Service<never, unknown>("@opencode/Location"), location))
    const ctx = { location, storage: { get: (key: string) => Effect.sync(() => get(key)), set: () => Effect.die("No writes"),
      scan: ({ prefix: key }: { prefix: string }) => Effect.sync(() => ({ entries: (db.prepare("SELECT key,value FROM kv WHERE substr(key,1,?)=? ORDER BY key").all((prefix + key).length, prefix + key) as Array<{ key: string; value: string }>).map(row => ({ key: row.key.slice(prefix.length), value: JSON.parse(row.value) })) })) } } as never
    const input = { scheduleID: "daily_review", requestID: body.requestID, expectedRevision: 0, expectedEpoch: 0, action: "play" }
    const beforeNativeCompletion = await Effect.runPromiseWith(graph)(readNativeRecurrenceControlStatus(ctx, input))
    assert.equal(beforeNativeCompletion.outcome, "unknown", "signed schedule publication is not a completed native control receipt")
    put(`${authority.parentKey}/controls/1`, { version: 1, scheduleID: "daily_review", requestID: body.requestID,
      revision: 1, epoch: 1, state: "running", controlsComplete: true })
    const result = await Effect.runPromiseWith(graph)(readNativeRecurrenceControlStatus(ctx, input))
    assert.equal(result.outcome, "committed")
    assert.equal(result.revision, 1)
    const wrong = await Effect.runPromiseWith(graph)(readNativeRecurrenceControlStatus(ctx, { ...input, expectedRevision: 1 }))
    assert.equal(wrong.outcome, "unknown")
    const snapshot = await Effect.runPromiseWith(graph)(readNativeRecurrenceSnapshot(ctx))
    assert.equal(snapshot.schedules[0]?.epoch, 1)
    assert.equal("controlCapability" in snapshot.schedules[0]!, false)
    assert.equal(snapshot.schedules[0]?.state, "unavailable", "missing Job graph is not proof of Interrupted")
    assert.equal((db.prepare("SELECT count(*) AS count FROM kv").get() as { count: number }).count, 6)
  } finally { db.close(); await rm(base, { recursive: true, force: true }) }
})
