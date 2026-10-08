import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { authorityDigest, canonicalAuthority, rejectAuthority } from "../../missions/authority-protocol"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { RECURRENCE_STORAGE_PREFIX } from "../../missions/recurrence-contract"
import { stableToken } from "../../missions/journal"
import { recurrenceAuthorityScopeSchema, RECURRENCE_AUTHORITY_MAX_BYTES, type RecurrenceAuthorityScope, type SignedRecurrenceStandingIntent } from "../../missions/recurrence-authority-contract"
import { NativeRecurrenceAuthorityStore, recurrenceAuthorityDocumentSchema, type RecurrenceAuthorityDocument } from "../../missions/recurrence-authority-store"
import type { MissionStorage } from "../../missions/journal"
import { validateRecurrenceMetadataFence } from "./native-recurrence-metadata-fence"

const PLUGIN_ID = "codenomad.missions"
const PREFIX = `${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence`
/** Trusted provisioning supplies this native record; acquisition never creates
 * namespaces, signers, storage identities or standing human authorizations. */
export const NATIVE_RECURRENCE_STORAGE_ID_KEY = `${PREFIX}/native-storage-id`
export const nativeRecurrenceAnchorKey = (scope: RecurrenceAuthorityScope, sessionID: string) => `${PREFIX}/anchors/${authorityDigest({
  scope: recurrenceAuthorityScopeSchema.parse(scope), sessionID: Schema.decodeUnknownSync(Session.ID)(sessionID),
})}`
const namespaceKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`
const nativeKey = (key: string) => `plugin:${Array.from(PLUGIN_ID).map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
const sessionTag = Context.Service<never, unknown>("@opencode/Session")
const locationTag = Context.Service<never, unknown>("@opencode/Location")
type NativeEffect = Effect.Effect<unknown, unknown>
type NativeDatabase = { db: { $client: SqlClient.SqlClient; transaction<A>(callback: () => Effect.Effect<A, unknown>, config: { behavior: "immediate" }): Effect.Effect<A, unknown> } }
const method = Schema.declare<(...args: never[]) => NativeEffect>((value): value is (...args: never[]) => NativeEffect => Predicate.isFunction(value))
const databaseShape = Schema.Struct({ db: Schema.Struct({ transaction: method,
  $client: Schema.declare<SqlClient.SqlClient>((value): value is SqlClient.SqlClient => Predicate.isFunction(value)
    && Predicate.hasProperty(value, "unsafe") && Predicate.isFunction(value.unsafe)
    && Predicate.hasProperty(value, "transactionService") && Context.isKey(value.transactionService)) }) })
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const SELECT_VALUE = "SELECT value FROM kv WHERE key=?"
// This private read shim permits only the metadata CAS statements.
const claimQueries = new Set([
  "PRAGMA database_list", "SELECT 1 FROM sqlite_schema WHERE type='trigger' LIMIT 1", SELECT_VALUE,
  "SELECT directory,project_id,workspace_id,time_suspended,time_compacting,revert FROM session_v2 WHERE id=?",
])
const same = (a: unknown, b: unknown) => canonicalAuthority(a, RECURRENCE_AUTHORITY_MAX_BYTES) === canonicalAuthority(b, RECURRENCE_AUTHORITY_MAX_BYTES)

/** Native metadata COMMIT capability, not RecurrenceAuthorityAdapter or a
 * permanent writer lease. Uses the CURRENT daemon connection and its real
 * BEGIN IMMEDIATE transaction; enrolled Session maintenance/placement is checked
 * but existing events are not a metadata-CAS exclusion. Managed ownership, signer/profile/family qualification and
 * independently protected cold rollback checkpoints remain producer obligations.
 * Acquire in native HTTP/RPC context; sealed setup cannot fabricate that graph. */
export const acquireNativeRecurrenceAuthorityProvider = Effect.fn("missions.acquireNativeAuthorityProvider")(function* (
  ctx: Pick<Plugin.Context, "storage">, sessionID: string, rawScope: RecurrenceAuthorityScope,
) {
  const found = yield* Effect.serviceOption(databaseTag), sessions = yield* Effect.serviceOption(sessionTag), origin = yield* Effect.serviceOption(locationTag)
  if (Option.isNone(found) || Option.isNone(sessions) || Option.isNone(origin)) return yield* Effect.fail(new Error("Native authority graph unavailable"))
  yield* Schema.decodeUnknownEffect(databaseShape)(found.value)
  const service = yield* Schema.decodeUnknownEffect(Schema.Struct({ get: method }))(sessions.value)
  const location = yield* Schema.decodeUnknownEffect(Schema.toType(Schema.Struct(Location.Info.fields)))(origin.value)
  const sessionEffect = service.get(sessionID as never)
  if (!Effect.isEffect(sessionEffect)) return yield* Effect.fail(new Error("Native session contract unavailable"))
  const session = yield* Schema.decodeUnknownEffect(Schema.toType(Session.Info))(yield* sessionEffect)
  const scope = Object.freeze(recurrenceAuthorityScopeSchema.parse(JSON.parse(canonicalAuthority(rawScope))))
  if (session.id !== sessionID || session.projectID !== scope.projectID || scope.projectID !== location.project.id
    || scope.projectCanonical !== location.project.canonical || session.location.directory !== location.directory
    || session.location.workspaceID !== location.workspaceID) rejectAuthority("binding-mismatch")
  const { db } = found.value as NativeDatabase, client = db.$client
  const anchorKey = nativeRecurrenceAnchorKey(scope, session.id)
  const sourceKey = `${RECURRENCE_STORAGE_PREFIX}/project/${stableToken(`${scope.projectID}\0${scope.projectCanonical}`, 24)}/${scope.scheduleID}`
  const anchor = { version: 1, scope, sessionID: session.id, location: { directory: session.location.directory,
    ...(session.location.workspaceID === undefined ? {} : { workspaceID: session.location.workspaceID }) } }
  const graph = yield* Effect.context<never>()
  let active = true, frame: Context.Context<never> | undefined
  yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
  const assertActive = (): true => {
    if (!active || Context.get(graph, databaseTag) !== found.value || Context.get(graph, locationTag) !== origin.value
      || Context.get(graph, sessionTag) !== sessions.value) rejectAuthority("authorization-blocked")
    return true
  }
  const readRows = (sql: string, params: readonly unknown[], context = graph) =>
    client.unsafe(sql, params).withoutTransform.pipe(Effect.flatMap(Schema.decodeUnknownEffect(rows)), Effect.provide(context))
  const syncRows = (sql: string, params: readonly unknown[] = []) => {
    if (!frame || Option.isNone(Context.getOption(frame, client.transactionService))) rejectAuthority("policy-unqualified")
    return Effect.runSync(readRows(sql, params, frame))
  }
  const syncValue = (key: string) => {
    const value = syncRows(SELECT_VALUE, [nativeKey(key)])[0]?.value
    if (value === undefined) return undefined
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > RECURRENCE_AUTHORITY_MAX_BYTES) rejectAuthority("storage-invalid")
    return JSON.parse(value)
  }
  // Fresh nonce is issued by this native context, not an RPC-supplied identity.
  // One slot per trusted enrolled anchor; a fresh acquisition fences an older
  // capability rather than accumulating a durable nonce for every read.
  const challengeKey = `${anchorKey}/challenge`, nonce = randomUUID()
  yield* ctx.storage.set(challengeKey, nonce)
  const readClaim = {
    get isTransaction() { return frame !== undefined && Option.isSome(Context.getOption(frame, client.transactionService)) },
    prepare(sql: string) {
      if (!claimQueries.has(sql)) rejectAuthority("policy-unqualified")
      return { all: (...params: unknown[]) => syncRows(sql, params), get: (...params: unknown[]) => syncRows(sql, params)[0] }
    },
  } as unknown as DatabaseSync
  const nativeFence = (): true => {
    assertActive()
    validateRecurrenceMetadataFence(readClaim, { sessionID, challengeKey: nativeKey(challengeKey), nonce,
      directory: location.directory, projectID: scope.projectID, workspaceID: session.location.workspaceID })
    if (syncValue(namespaceKey) !== scope.namespace || syncValue(NATIVE_RECURRENCE_STORAGE_ID_KEY) !== scope.daemonStorageID
      || !same(syncValue(anchorKey) ?? null, anchor)) {
      rejectAuthority("policy-unqualified")
    }
    return true
  }
  const inTransaction = <A>(current: () => true, operation: () => Effect.Effect<A, unknown>) => db.transaction(() => Effect.gen(function* () {
    const context = yield* Effect.context<never>()
    if (frame) rejectAuthority("policy-unqualified")
    frame = context
    return yield* Effect.suspend(() => { nativeFence(); return operation() }).pipe(
      Effect.tap(() => Effect.sync(() => {
        // The async operation may settle AFTER its last caller check. Repeat
        // both guards here, synchronously, at the shared final commit boundary.
        assertSynchronousAuthorityGuard(current, "policy-unqualified")
        return assertSynchronousAuthorityGuard(nativeFence, "policy-unqualified")
      })), Effect.ensuring(Effect.sync(() => { frame = undefined })))
  }), { behavior: "immediate" }).pipe(Effect.provide(graph))
  let store: NativeRecurrenceAuthorityStore
  const allowed = (key: string, write: boolean) => {
    const suffix = key.startsWith(`${store.parentKey}/`) ? key.slice(store.parentKey.length + 1) : ""
    if (!(!write && key === namespaceKey) && !/^(live|parents\/[1-9]\d*|settled\/[1-9]\d*|passages\/[A-Za-z0-9_-]{3,100})$/.test(suffix)) {
      rejectAuthority("binding-mismatch")
    }
  }
  const storage: MissionStorage = {
    get: async key => {
      assertActive(); allowed(key, false)
      const raw = (await Effect.runPromise(readRows(SELECT_VALUE, [nativeKey(key)], frame ?? graph)))[0]?.value
      assertActive()
      if (raw === undefined) return undefined
      if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > RECURRENCE_AUTHORITY_MAX_BYTES) rejectAuthority("storage-invalid")
      const value = JSON.parse(raw)
      canonicalAuthority(value, RECURRENCE_AUTHORITY_MAX_BYTES)
      return value
    },
    set: async (key, value, current) => {
      allowed(key, true)
      const bytes = canonicalAuthority(value, RECURRENCE_AUTHORITY_MAX_BYTES)
      await Effect.runPromise(Effect.sync(() => {
        nativeFence()
        const existing = syncValue(key)
        if (key === store.key) {
          const next = recurrenceAuthorityDocumentSchema.parse(JSON.parse(bytes))
          if (!same(next.scope, scope)) rejectAuthority("binding-mismatch")
          if (existing !== undefined) {
            const previous = recurrenceAuthorityDocumentSchema.parse(existing)
            if (!same(previous.scope, scope) || next.revision !== previous.revision + 1
              || next.parent.body.epoch < previous.parent.body.epoch || next.settledSequence < previous.settledSequence) rejectAuthority("revision-conflict")
          } else if (next.revision !== 0) rejectAuthority("revision-conflict")
        } else if (existing !== undefined && !same(existing, JSON.parse(bytes))) rejectAuthority("request-conflict")
        // Store/core validation supplies the signed semantic decision. Neither a
        // Promise nor a caller flag substitutes for the actual native fence.
        if (!current) rejectAuthority("policy-unqualified")
        assertSynchronousAuthorityGuard(current as () => true, "policy-unqualified")
        assertSynchronousAuthorityGuard(nativeFence, "policy-unqualified")
        syncRows("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,time_updated=excluded.time_updated",
          [nativeKey(key), bytes, Date.now(), Date.now()])
        if (!same(syncValue(key), JSON.parse(bytes))) rejectAuthority("storage-unavailable")
        // Last synchronous observation before the native transaction commits:
        // reread the fresh nonce, enrolled session, namespace and storage ID.
        assertSynchronousAuthorityGuard(nativeFence, "policy-unqualified")
      }))
    },
    scan: async () => rejectAuthority("policy-unqualified"),
  }
  store = new NativeRecurrenceAuthorityStore(storage, scope)
  // Verify the exact actual storage/claim contracts before publishing capability.
  yield* inTransaction(nativeFence, () => Effect.sync(nativeFence))
  const assertLedgerCurrent = (expected: Readonly<RecurrenceAuthorityDocument> | null): true => {
    nativeFence()
    if (!same(syncValue(store.key) ?? null, expected)) rejectAuthority("revision-conflict")
    return true
  }
  const guarded = (expected: Readonly<RecurrenceAuthorityDocument> | null, current: () => true) => (): true => {
    assertLedgerCurrent(expected)
    return assertSynchronousAuthorityGuard(current, "policy-unqualified")
  }
  return Object.freeze({ daemonStorageID: scope.daemonStorageID, ledgerKey: store.key,
    location: Object.freeze({ directory: location.directory, projectID: location.project.id,
      projectCanonical: location.project.canonical, sessionID: session.id }),
    store,
    /** Keep the same native IMMEDIATE frame around the entire business CAS. */
    transact: <A>(current: () => true, operation: () => Promise<A>): Promise<A> =>
      Effect.runPromise(inTransaction(current, () => Effect.promise(operation))),
    assertCurrent: nativeFence,
    readCurrent: (key: string): unknown => {
      nativeFence()
      // No arbitrary plugin KV access: only this scope's exact immutable/live keys.
      if (key !== sourceKey) allowed(key, false)
      return syncValue(key)
    },
    sourceKey,
    read: () => store.read(),
    publish: (expected: Readonly<RecurrenceAuthorityDocument> | null, next: RecurrenceAuthorityDocument, current: () => true) => {
      const pinned = expected ? recurrenceAuthorityDocumentSchema.parse(JSON.parse(canonicalAuthority(expected))) : null
      const document = recurrenceAuthorityDocumentSchema.parse(JSON.parse(canonicalAuthority(next)))
      return Effect.runPromise(inTransaction(current, () => Effect.promise(async () => {
        const revision = await store.transaction(pinned?.revision ?? null, async before => {
          if (!same(before ?? null, pinned)) rejectAuthority("revision-conflict")
          return { document, result: document.revision, assertCurrent: guarded(pinned, current) }
        })
        assertLedgerCurrent(document)
        assertSynchronousAuthorityGuard(current, "policy-unqualified")
        return revision
      })))
    },
    archiveParent: (parent: SignedRecurrenceStandingIntent, expected: Readonly<RecurrenceAuthorityDocument> | null, current: () => true) => {
      const pinned = expected ? recurrenceAuthorityDocumentSchema.parse(JSON.parse(canonicalAuthority(expected))) : null
      const signed = JSON.parse(canonicalAuthority(parent)) as SignedRecurrenceStandingIntent
      return Effect.runPromise(inTransaction(current, () => Effect.promise(async () => {
        await store.archiveParent(signed, guarded(pinned, current))
        guarded(pinned, current)()
      })))
    },
  })
})
export type NativeRecurrenceAuthorityProvider = Effect.Success<ReturnType<typeof acquireNativeRecurrenceAuthorityProvider>>
