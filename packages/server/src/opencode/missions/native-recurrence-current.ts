import { createPrivateKey, createPublicKey } from "node:crypto"
import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { authoritySignerDigest, canonicalAuthority, MISSION_AUTHORITY_POLICY } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { authenticateRecurrenceStanding, recurrenceAuthorityDigest } from "../../missions/recurrence-authority-contract"
import { assertRecurrenceStartupReceipts } from "../../missions/recurrence-input"
import { NativeRecurrenceAuthorityStore } from "../../missions/recurrence-authority-store"
import { currentRecurrenceContent, recurrenceCurrentInput, recurrenceCurrentContentInput } from "../../missions/recurrence-current"
import { recurrencePassage } from "../../missions/recurrence-passage"
import type { MissionStorage } from "../../missions/journal"
import type { MissionMap } from "../../missions/model"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { nativeDatabaseStorageID } from "./native-database-identity"

const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
const locationTag = Context.Service<never, unknown>("@opencode/Location")
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const prefix = `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`
const equal = (a: unknown, b: unknown) => canonicalAuthority(a ?? null, 256 * 1024) === canonicalAuthority(b ?? null, 256 * 1024)

/** Read-only request graph: never acquire the writer provider (which writes a
 * challenge), touch Jobs, environment, or manufacture a missing journal. */
const readCurrent = Effect.fn("missions.readNativeRecurrenceCurrent")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location">, raw: unknown, content: boolean,
) {
  const input = content ? recurrenceCurrentContentInput.parse(raw) : recurrenceCurrentInput.parse(raw)
  const origin = yield* Effect.serviceOption(locationTag)
  if (Option.isNone(origin)) throw new Error("Native recurrence Location unavailable")
  const location = yield* Schema.decodeUnknownEffect(Schema.toType(Schema.Struct(Location.Info.fields)))(origin.value)
  const assertLocation = () => {
    if (location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
      || location.project.id !== ctx.location.project.id || location.project.canonical !== ctx.location.project.canonical) {
      throw new Error("Recurrence Location changed")
    }
  }
  assertLocation()
  const store = yield* acquireNativeRecurrenceStore(ctx)
  const doc = yield* Effect.promise(() => store.read(input.scheduleID))
  if (!doc || !doc.config.roots.some(root => root.directory === location.directory)) throw new Error("Current recurrence schedule unavailable")
  const identity = { version: 1 as const, projectID: location.project.id, projectCanonical: location.project.canonical,
    location: { directory: location.directory, ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }) }, scheduleID: doc.id }
  const freshSchedule = Effect.promise(async () => {
    const fresh = await store.read(doc.id)
    assertLocation()
    if (!fresh || !equal(fresh, doc)) throw new Error("Current recurrence schedule changed")
  })
  if (!doc.pending) {
    if (content) throw new Error("Current recurrence passage unavailable")
    yield* freshSchedule
    return { ...identity, passageID: null }
  }
  if ("passageID" in input && input.passageID !== doc.pending.passage.id) throw new Error("Current recurrence passage changed")
  const found = yield* Effect.serviceOption(databaseTag)
  if (Option.isNone(found)) throw new Error("Native recurrence database unavailable")
  const db = found.value as { db?: { $client?: SqlClient.SqlClient } }
  if (!Predicate.isFunction(db.db?.$client) || !Predicate.isFunction(db.db?.$client?.unsafe)) throw new Error("Native recurrence database unavailable")
  const graph = yield* Effect.context<never>()
  const query = (sql: string, params: readonly unknown[] = []) => db.db!.$client!.unsafe(sql, params).withoutTransform.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(rows)), Effect.provide(graph))
  const sync = (sql: string, params: readonly unknown[] = []) => Effect.runSync(query(sql, params))
  const databases = yield* query("PRAGMA database_list")
  if (databases.length !== 1 || databases[0]?.name !== "main" || typeof databases[0].file !== "string") throw new Error("Native recurrence database unavailable")
  const daemonStorageID = nativeDatabaseStorageID(databases[0].file)
  const namespaceKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`
  const namespaceRaw = sync("SELECT value FROM kv WHERE key=?", [`${prefix}${namespaceKey}`])[0]?.value
  const namespace: unknown = typeof namespaceRaw === "string" && namespaceRaw.length < 100 ? JSON.parse(namespaceRaw) : null
  if (typeof namespace !== "string" || !/^[a-f\d-]{36}$/.test(namespace)) throw new Error("Native recurrence namespace unavailable")
  const signerKey = `${prefix}${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/${doc.config.profileID}`
  const pinnedSigner = sync("SELECT value FROM kv WHERE key=?", [signerKey])[0]?.value
  if (typeof pinnedSigner !== "string" || Buffer.byteLength(pinnedSigner) > 1024) throw new Error("Native recurrence signer unavailable")
  const encoded: unknown = JSON.parse(pinnedSigner)
  if (typeof encoded !== "string" || encoded.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Native recurrence signer unavailable")
  const key = createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" })
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Native recurrence signer unavailable")
  const publicKey = createPublicKey(key), digest = authoritySignerDigest(publicKey)
  const assertCurrent = (): true => {
    assertLocation()
    const latest = sync("PRAGMA database_list")
    if (Context.get(graph, databaseTag) !== found.value || Context.get(graph, locationTag) !== origin.value
      || latest.length !== 1 || latest[0]?.name !== "main" || typeof latest[0].file !== "string"
      || nativeDatabaseStorageID(latest[0].file) !== daemonStorageID
      || sync("SELECT value FROM kv WHERE key=?", [`${prefix}${namespaceKey}`])[0]?.value !== namespaceRaw
      || sync("SELECT value FROM kv WHERE key=?", [signerKey])[0]?.value !== pinnedSigner) throw new Error("Native recurrence authority changed")
    return true
  }
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect.pipe(Effect.provide(graph)))
  let bytes = 0
  const storage: MissionStorage = {
    get: async key => { assertCurrent(); const value = await run(ctx.storage.get(key)); assertCurrent(); return value as Awaited<ReturnType<MissionStorage["get"]>> },
    set: async () => { throw new Error("Current recurrence reader is read-only") },
    scan: async options => {
      assertCurrent()
      const page = await run(ctx.storage.scan(options)) as Awaited<ReturnType<MissionStorage["scan"]>>
      // ponytail: 32 MiB journal read ceiling; use checkpoints if real passages exceed it.
      for (const entry of page.entries) bytes += Buffer.byteLength(canonicalAuthority(entry.value, 256 * 1024))
      if (bytes > 32 * 1024 * 1024) throw new Error("Current recurrence journal capacity")
      assertCurrent()
      return page
    },
  }
  const scope = { namespace, daemonStorageID, projectID: doc.projectID, projectCanonical: doc.projectCanonical,
    scheduleID: doc.id, profileID: doc.config.profileID, executionHost: doc.config.executionHost }
  const authority = new NativeRecurrenceAuthorityStore(storage, scope)
  const ledger = yield* Effect.promise(() => authority.read())
  if (!ledger) throw new Error("Current recurrence authority unavailable")
  const authenticate = (signed: typeof ledger.parent) => {
    if (signed.body.signerDigest !== digest || signed.body.provisioningGeneration !== digest
      || signed.body.authorityID !== `rec_${digest.slice(0, 40)}` || signed.body.keyID !== `key_${digest.slice(0, 40)}`) throw new Error("Current recurrence signer differs")
    return authenticateRecurrenceStanding(signed, [{ ...scope, authorityID: signed.body.authorityID, keyID: signed.body.keyID,
      roots: doc.config.roots, publicKey, provisioningGeneration: digest, policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" }])
  }
  authenticate(ledger.parent)
  const archive = yield* Effect.promise(() => authority.readPassage(doc.pending!.passage.id))
  if (ledger.child && archive) throw new Error("Current recurrence authority is torn")
  const child = ledger.child ?? archive?.child
  if (!child || archive && (ledger.settledSequence !== child.grant.sequence || ledger.lastArchiveDigest !== recurrenceAuthorityDigest(archive))) throw new Error("Current recurrence child unavailable")
  authenticate(child.parent)
  const grant = child.grant
  if (!equal(child.parent.body.config, doc.config) || !equal(grant.passage, doc.pending.passage)
    || child.parent.body.scheduleRevision !== doc.scheduleRevision
    || doc.pending.admission && (doc.pending.admission.missionID !== grant.missionID
      || doc.pending.admission.conversationID !== grant.coordinatorSessionID || doc.pending.admission.messageID !== grant.messageID)) throw new Error("Current recurrence identity differs")
  const result = { ...identity, passageID: grant.passage.id }
  let mission: MissionMap | undefined
  if (doc.pending.admission) {
    assertRecurrenceStartupReceipts(child)
    const passage = recurrencePassage(storage, doc, assertCurrent)
    const snapshot = yield* Effect.promise(() => passage.journal.snapshot())
    mission = snapshot.missions[0]
    if (snapshot.missions.length !== 1 || snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable
      || !mission || mission.id !== grant.missionID || mission.projectID !== doc.projectID || mission.projectCanonical !== doc.projectCanonical
      || mission.coordinatorSessionId !== grant.coordinatorSessionID || !equal(mission.profiles, doc.config.profiles)
      || mission.taskMode !== doc.config.taskMode) throw new Error("Current recurrence journal unavailable")
    const events = yield* Effect.promise(() => passage.journal.events())
    if (events.discardedEvents || !events.events.some(event => event.type === "mission.created"
      && event.requestID === grant.passage.id && event.missionID === grant.missionID)) throw new Error("Current recurrence creation differs")
  }
  const freshLedger = yield* Effect.promise(() => authority.read())
  if (!equal(freshLedger, ledger) || !equal(yield* Effect.promise(() => authority.readPassage(grant.passage.id)), archive)) throw new Error("Current recurrence authority changed")
  yield* freshSchedule
  assertCurrent()
  if (content) {
    if (!mission) throw new Error("Current recurrence content unavailable")
    return { ...currentRecurrenceContent(mission, input), projectCanonical: identity.projectCanonical, location: identity.location }
  }
  return { ...result, ...(mission ? { mission: JSON.parse(JSON.stringify(mission)) as MissionMap } : {}) }
})

export const readNativeRecurrenceCurrent = (ctx: Pick<Plugin.Context, "storage" | "location">, input: unknown) => readCurrent(ctx, input, false)
export const readNativeRecurrenceCurrentContent = (ctx: Pick<Plugin.Context, "storage" | "location">, input: unknown) => readCurrent(ctx, input, true)
