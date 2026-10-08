import { createHash, randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
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
import { validateRecurrenceEntryFence, validateRecurrenceMetadataFence } from "./native-recurrence-metadata-fence"
export type NativeRecurrenceOwner = Readonly<{ namespace: string; daemonStorageID: string; assertCurrent(): true }>

const PLUGIN_ID = "codenomad.missions"
const PREFIX = `${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence`
/** The managed service identity, rather than an invented Session, owns each
 * exact project/schedule Location. Acquisition never signs or authorizes work. */
const namespaceKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`
const nativeKey = (key: string) => `plugin:${Array.from(PLUGIN_ID).map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
const locationTag = Context.Service<never, unknown>("@opencode/Location")
const formTag = Context.Service<never, unknown>("@opencode/Form")
const permissionTag = Context.Service<never, unknown>("@opencode/Permission")
const shellTag = Context.Service<never, unknown>("@opencode/Shell")
type NativeEffect = Effect.Effect<unknown, unknown>
type NativeDatabase = { db: { $client: SqlClient.SqlClient; transaction<A>(callback: () => Effect.Effect<A, unknown>, config: { behavior: "immediate" }): Effect.Effect<A, unknown> } }
const method = Schema.declare<(...args: never[]) => NativeEffect>((value): value is (...args: never[]) => NativeEffect => Predicate.isFunction(value))
const databaseShape = Schema.Struct({ db: Schema.Struct({ transaction: method,
  $client: Schema.declare<SqlClient.SqlClient>((value): value is SqlClient.SqlClient => Predicate.isFunction(value)
    && Predicate.hasProperty(value, "unsafe") && Predicate.isFunction(value.unsafe)
    && Predicate.hasProperty(value, "transactionService") && Context.isKey(value.transactionService)) }) })
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const SELECT_VALUE = "SELECT value FROM kv WHERE key=?"
const SESSION_ROW = "SELECT id,parent_id,project_id,directory,workspace_id,metadata,time_suspended FROM session_v2 WHERE id=?"
const SESSION_HEAD = "SELECT seq,owner_id FROM event_sequence WHERE aggregate_id=?"
const SESSION_EVENTS = "SELECT id,seq,type,data FROM event WHERE aggregate_id=? ORDER BY seq LIMIT 513"
const SESSION_INBOX = "SELECT count(*) AS count FROM session_inbox WHERE session_id=?"
const SESSION_PENDING = "SELECT count(*) AS count FROM session_pending WHERE session_id=?"
const SESSION_MESSAGE = "SELECT id,session_id,type,data FROM session_message WHERE id=?"
const SESSION_MESSAGES = "SELECT id,type,data FROM session_message WHERE session_id=? ORDER BY seq LIMIT 129"
const PASSAGE_JOURNAL = "SELECT key,value FROM kv WHERE substr(key,1,?)=? ORDER BY key LIMIT 2001"
// This private read shim permits only the metadata CAS statements.
const claimQueries = new Set([
  "PRAGMA database_list", "SELECT 1 FROM sqlite_schema WHERE type='trigger' LIMIT 1", SELECT_VALUE,
  SESSION_ROW, SESSION_HEAD, SESSION_EVENTS, SESSION_INBOX, SESSION_PENDING, SESSION_MESSAGE, SESSION_MESSAGES, PASSAGE_JOURNAL,
])
const same = (a: unknown, b: unknown) => canonicalAuthority(a, RECURRENCE_AUTHORITY_MAX_BYTES) === canonicalAuthority(b, RECURRENCE_AUTHORITY_MAX_BYTES)

/** Native metadata COMMIT capability, not RecurrenceAuthorityAdapter or a
 * permanent writer lease. Uses the CURRENT daemon connection and its real
 * BEGIN IMMEDIATE transaction. The native managed owner and exact Location are
 * checked without borrowing a Session or creating an anchor. */
export const acquireNativeRecurrenceAuthorityProvider = Effect.fn("missions.acquireNativeAuthorityProvider")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location">, rawScope: RecurrenceAuthorityScope,
  owner: NativeRecurrenceOwner,
) {
  const found = yield* Effect.serviceOption(databaseTag), origin = yield* Effect.serviceOption(locationTag)
  if (Option.isNone(found) || Option.isNone(origin)) return yield* Effect.fail(new Error("Native authority graph unavailable"))
  yield* Schema.decodeUnknownEffect(databaseShape)(found.value)
  const location = yield* Schema.decodeUnknownEffect(Schema.toType(Schema.Struct(Location.Info.fields)))(origin.value)
  const scope = Object.freeze(recurrenceAuthorityScopeSchema.parse(JSON.parse(canonicalAuthority(rawScope))))
  if (scope.projectID !== location.project.id || scope.projectCanonical !== location.project.canonical
    || ctx.location.directory !== location.directory || ctx.location.workspaceID !== location.workspaceID
    || ctx.location.project.id !== scope.projectID || ctx.location.project.canonical !== scope.projectCanonical
    || owner.namespace !== scope.namespace || owner.daemonStorageID !== scope.daemonStorageID) rejectAuthority("binding-mismatch")
  assertSynchronousAuthorityGuard(owner.assertCurrent, "policy-unqualified")
  const { db } = found.value as NativeDatabase, client = db.$client
  const sourceKey = `${RECURRENCE_STORAGE_PREFIX}/project/${stableToken(`${scope.projectID}\0${scope.projectCanonical}`, 24)}/${scope.scheduleID}`
  const graph = yield* Effect.context<never>()
  let active = true, frame: Context.Context<never> | undefined
  yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
  const assertActive = (): true => {
    if (!active || Context.get(graph, databaseTag) !== found.value || Context.get(graph, locationTag) !== origin.value
      || ctx.location.directory !== location.directory || ctx.location.workspaceID !== location.workspaceID
      || ctx.location.project.id !== scope.projectID || ctx.location.project.canonical !== scope.projectCanonical) rejectAuthority("authorization-blocked")
    assertSynchronousAuthorityGuard(owner.assertCurrent, "policy-unqualified")
    return true
  }
  const readRows = (sql: string, params: readonly unknown[], context = graph) =>
    client.unsafe(sql, params).withoutTransform.pipe(Effect.flatMap(Schema.decodeUnknownEffect(rows)), Effect.provide(context))
  const syncRows = (sql: string, params: readonly unknown[] = []) => {
    if (frame ? Option.isNone(Context.getOption(frame, client.transactionService)) : !claimQueries.has(sql)) rejectAuthority("policy-unqualified")
    return Effect.runSync(readRows(sql, params, frame ?? graph))
  }
  const syncValue = (key: string) => {
    const value = syncRows(SELECT_VALUE, [nativeKey(key)])[0]?.value
    if (value === undefined) return undefined
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > RECURRENCE_AUTHORITY_MAX_BYTES) rejectAuthority("storage-invalid")
    return JSON.parse(value)
  }
  const sessionWatermark = (sessionID: string) => {
    if (!/^ses_[A-Za-z0-9_-]{3,100}$/.test(sessionID)) rejectAuthority("binding-mismatch")
    const session = syncRows(SESSION_ROW, [sessionID])[0]
    const head = syncRows(SESSION_HEAD, [sessionID])[0]
    const inbox = syncRows(SESSION_INBOX, [sessionID])[0]?.count
    const pending = syncRows(SESSION_PENDING, [sessionID])[0]?.count
    if (!session || !head || !Number.isSafeInteger(head.seq) || !Number.isSafeInteger(inbox)
      || !Number.isSafeInteger(pending) || session.id !== sessionID || session.project_id !== scope.projectID
      || session.directory !== location.directory || session.workspace_id !== (location.workspaceID ?? null))
      rejectAuthority("observation-unavailable")
    return { session, seq: head.seq as number, ownerID: head.owner_id, inbox, pending }
  }
  const journalWatermark = (passageID: string) => {
    // ponytail: bounded whole-passage hash; add a durable checkpoint only if large journals must settle.
    if (!/^rcp_[A-Za-z0-9_-]{3,100}$/.test(passageID)) rejectAuthority("binding-mismatch")
    const prefix = nativeKey(`${RECURRENCE_STORAGE_PREFIX}/passages/${stableToken(`${scope.projectID}\0${scope.projectCanonical}`, 24)}/${scope.scheduleID}/${passageID}/`)
    const entries = syncRows(PASSAGE_JOURNAL, [prefix.length, prefix])
    if (!entries.length || entries.length > 2000 || entries.some(row => typeof row.key !== "string"
      || !row.key.startsWith(prefix) || typeof row.value !== "string")
      || Buffer.byteLength(JSON.stringify(entries), "utf8") > 3 * 1024 * 1024) rejectAuthority("observation-unavailable")
    return createHash("sha256").update(canonicalAuthority(entries, 3 * 1024 * 1024)).digest("hex")
  }
  // One native nonce slot per exact schedule. A new acquisition revokes an old
  // writer even if its evictable Location/plugin Scope has not been disposed.
  const scheduleKey = `${PREFIX}/owners/${authorityDigest({ scope, location: {
    directory: location.directory, workspaceID: location.workspaceID ?? null } })}`
  const challengeKey = `${scheduleKey}/challenge`, nonce = randomUUID()
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
    validateRecurrenceMetadataFence(readClaim, { challengeKey: nativeKey(challengeKey), nonce })
    if (syncValue(namespaceKey) !== scope.namespace) {
      rejectAuthority("policy-unqualified")
    }
    return true
  }
  const entryFence = (): true => {
    assertActive()
    if (frame) return nativeFence()
    validateRecurrenceEntryFence(readClaim, { challengeKey: nativeKey(challengeKey), nonce })
    if (syncValue(namespaceKey) !== scope.namespace) rejectAuthority("policy-unqualified")
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
    entryFence()
    if (!same(syncValue(store.key) ?? null, expected)) rejectAuthority("revision-conflict")
    return true
  }
  const guarded = (expected: Readonly<RecurrenceAuthorityDocument> | null, current: () => true) => (): true => {
    assertLedgerCurrent(expected)
    return assertSynchronousAuthorityGuard(current, "policy-unqualified")
  }
  return Object.freeze({ daemonStorageID: scope.daemonStorageID, ledgerKey: store.key,
    location: Object.freeze({ directory: location.directory, workspaceID: location.workspaceID,
      projectID: location.project.id, projectCanonical: location.project.canonical }),
    store,
    /** Keep the same native IMMEDIATE frame around the entire business CAS. */
    transact: <A>(current: () => true, operation: () => Promise<A>): Promise<A> =>
      Effect.runPromise(inTransaction(current, () => Effect.promise(operation))),
    assertCurrent: entryFence,
    readCurrent: (key: string): unknown => {
      entryFence()
      // No arbitrary plugin KV access: only this scope's exact immutable/live keys.
      if (key !== sourceKey) allowed(key, false)
      return syncValue(key)
    },
    readSession: (sessionID: string, messageID?: string) => {
      entryFence()
      const before = sessionWatermark(sessionID)
      // ponytail: 512 native events/128 messages per actor; a persistent cursor is needed for larger passages.
      const events = syncRows(SESSION_EVENTS, [sessionID])
      const messages = syncRows(SESSION_MESSAGES, [sessionID])
      if (events.length > 512 || events.some(row => typeof row.data !== "string" || Buffer.byteLength(row.data, "utf8") > 256 * 1024)
        || messages.length > 128 || messages.some(row => typeof row.data !== "string" || Buffer.byteLength(row.data, "utf8") > 256 * 1024)
        || Buffer.byteLength(JSON.stringify([events, messages]), "utf8") > 3 * 1024 * 1024) rejectAuthority("observation-unavailable")
      const message = messageID === undefined ? undefined : syncRows(SESSION_MESSAGE, [messageID])[0]
      if (messageID !== undefined && (!/^([A-Za-z0-9_:-]{3,240})$/.test(messageID)
        || !message || message.session_id !== sessionID || typeof message.data !== "string"
        || Buffer.byteLength(message.data, "utf8") > 256 * 1024)) rejectAuthority("observation-unavailable")
      if (!same(before, sessionWatermark(sessionID))) rejectAuthority("observation-unavailable")
      return { ...before, events, messages, message }
    },
    readJournalWatermark: (passageID: string) => { entryFence(); return journalWatermark(passageID) },
    assertJournalWatermark: (passageID: string, expected: string): true => {
      nativeFence()
      if (!frame || journalWatermark(passageID) !== expected) rejectAuthority("observation-unavailable")
      return true
    },
    /** Called by the settlement lease inside the original native BEGIN IMMEDIATE.
     * No arbitrary SQL, project inventory or asynchronous promise can pass this fence. */
    assertSessionWatermarks: (observed: readonly { sessionID: string; seq: number; ownerID: unknown; session: unknown }[]): true => {
      nativeFence()
      if (!frame || observed.length < 1 || observed.length > 32 || new Set(observed.map(item => item.sessionID)).size !== observed.length)
        rejectAuthority("policy-unqualified")
      for (const item of observed) {
        const actual = sessionWatermark(item.sessionID)
        if (actual.seq !== item.seq || actual.ownerID !== item.ownerID || actual.inbox !== 0 || actual.pending !== 0
          || actual.session.time_suspended !== null || !same(actual.session, item.session)) rejectAuthority("observation-unavailable")
      }
      return true
    },
    assertNoPendingRequests: async (sessionIDs: readonly string[]) => {
      entryFence()
      if (!sessionIDs.length || sessionIDs.length > 32 || new Set(sessionIDs).size !== sessionIDs.length)
        rejectAuthority("observation-unavailable")
      const owned = new Set(sessionIDs)
      const forms = Context.getOption(graph, formTag), permissions = Context.getOption(graph, permissionTag)
      const shells = Context.getOption(graph, shellTag)
      if (Option.isNone(forms) || Option.isNone(permissions) || Option.isNone(shells)
        || !Predicate.hasProperty(forms.value, "list") || !Predicate.isFunction(forms.value.list)
        || !Predicate.hasProperty(permissions.value, "list") || !Predicate.isFunction(permissions.value.list)
        || !Predicate.hasProperty(shells.value, "list") || !Predicate.isFunction(shells.value.list)) rejectAuthority("observation-unavailable")
      // ponytail: one active-Location queue read materializes before the 1024-result cap;
      // replace it only if upstream exposes a bounded per-session reader/cursor.
      const [formRows, permissionRows, shellRows] = await Promise.all([forms.value.list(), permissions.value.list(), shells.value.list()]
        .map(effect => Effect.runPromise(Effect.provide(effect as NativeEffect, graph))))
      if (![formRows, permissionRows, shellRows].every(Array.isArray)
        || [formRows, permissionRows, shellRows].some(list => (list as unknown[]).length > 1024)) rejectAuthority("observation-unavailable")
      if ((formRows as { sessionID?: string }[]).some(row => owned.has(row.sessionID ?? "") || row.sessionID === "global")
        || (permissionRows as { sessionID?: string }[]).some(row => owned.has(row.sessionID ?? ""))
        || (shellRows as { metadata?: { sessionID?: string } }[]).some(row => owned.has(row.metadata?.sessionID ?? "")))
        rejectAuthority("observation-unavailable")
      entryFence()
      return true as const
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
