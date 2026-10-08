import { createPrivateKey, createPublicKey } from "node:crypto"
import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { authoritySignerDigest, canonicalAuthority, MISSION_AUTHORITY_POLICY, rejectAuthority } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { authenticateRecurrenceStanding, deriveRecurrenceChild, recurrenceAuthorityDigest,
  type RecurrenceAuthorityScope } from "../../missions/recurrence-authority-contract"
import { RecurrenceAuthority } from "../../missions/recurrence-authority-core"
import type { RecurrenceDocument } from "../../missions/recurrence-contract"
import type { MissionStorage } from "../../missions/journal"
import { MissionRecurrenceRunner, type RecurrenceAuthorizedAdmission, type RecurrenceRunOutcome } from "../../missions/recurrence-runner"
import { acquireNativeRecurrenceAuthorityProvider } from "./native-authority-provider"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { admitNativeRecurrencePassage } from "./native-recurrence-admission"
import { nativeRecurrenceAdapter, type NativeStandingSigner } from "./native-recurrence-adapter"
import { observeNativeRecurrenceSettlement } from "./native-recurrence-settlement"
import { acquireMissionNativeService } from "./native-service-adapter"
import { nativeDatabaseStorageID } from "./native-database-identity"
import type { RecurrenceClockPlacement } from "./native-service-clock"
import { assertRecurrenceDispatchFeasible } from "../../missions/recurrence-read-budget"
import { recurrenceInput, recurrenceSourceCursors, recurrenceSources, recurrenceSourceLocationDigest } from "../../missions/recurrence-input"
import { readAutonomousMissionEnvironment } from "./autonomous-environment"

const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
const locationTag = Context.Service<never, unknown>("@opencode/Location")
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const prefix = `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`
const equal = (a: unknown, b: unknown) => canonicalAuthority(a, 768 * 1024) === canonicalAuthority(b, 768 * 1024)

/** A native terminal-evidence observer, not an admission ACK or model prose. */
export type ReconcileNativePending = typeof observeNativeRecurrenceSettlement

/** The only due callback. The native Job passes a freshly borrowed Location graph
 * on each tick; this closure carries placement, not an evictable Session/owner. */
export function nativeRecurrenceDue(ctx: Pick<Plugin.Context, "storage" | "location">, placement: RecurrenceClockPlacement,
  reconcilePending: ReconcileNativePending = observeNativeRecurrenceSettlement, now: () => number = Date.now) {
  // Pick is not a runtime projection. Retain only app-global KV and detached
  // scalar identity; never the caller's full plugin context or evictable graph.
  const exactCtx = Object.freeze({ storage: ctx.storage, location: Object.freeze(new Location.Info({
    directory: ctx.location.directory, workspaceID: ctx.location.workspaceID,
    project: Object.freeze({ id: ctx.location.project.id, directory: ctx.location.project.directory,
      canonical: ctx.location.project.canonical }),
  })) })
  if (typeof reconcilePending !== "function") rejectAuthority("observation-unavailable")
  return (graph: Context.Context<never>, graphCurrent: () => true, signal: AbortSignal): Promise<RecurrenceRunOutcome> =>
    Effect.runPromise(Effect.gen(function* () {
      graphCurrent()
      const found = yield* Effect.serviceOption(databaseTag), origin = yield* Effect.serviceOption(locationTag)
      if (Option.isNone(found) || Option.isNone(origin)) rejectAuthority("policy-unqualified")
      const db = found.value as { db?: { $client?: SqlClient.SqlClient } }
      if (!Predicate.isFunction(db.db?.$client) || !Predicate.isFunction(db.db?.$client?.unsafe)) rejectAuthority("policy-unqualified")
      const currentGraph = yield* Effect.context<never>()
      const query = (sql: string, params: readonly unknown[] = []) => db.db!.$client!.unsafe(sql, params)
        .withoutTransform.pipe(Effect.flatMap(Schema.decodeUnknownEffect(rows)), Effect.provide(currentGraph))
      const sync = (sql: string, params: readonly unknown[] = []) => Effect.runSync(query(sql, params))
      const namespaceKey = `${prefix}${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`
      const signerKey = `${prefix}${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/${placement.profileID}`
      const first = yield* query("PRAGMA database_list")
      if (first.length !== 1 || first[0]?.name !== "main" || typeof first[0].file !== "string") rejectAuthority("policy-unqualified")
      const daemonStorageID = nativeDatabaseStorageID(first[0].file)
      const namespace = JSON.parse(String(sync("SELECT value FROM kv WHERE key=?", [namespaceKey])[0]?.value ?? "null"))
      if (typeof namespace !== "string" || !/^[a-f\d-]{36}$/.test(namespace)) rejectAuthority("namespace-mismatch")
      const owner = { namespace, daemonStorageID, assertCurrent: (): true => {
        graphCurrent()
        const databases = sync("PRAGMA database_list")
        if (Context.get(currentGraph, databaseTag) !== found.value || Context.get(currentGraph, locationTag) !== origin.value
          || databases.length !== 1 || databases[0]?.name !== "main"
          || nativeDatabaseStorageID(String(databases[0]?.file ?? "")) !== daemonStorageID
          || sync("SELECT value FROM kv WHERE key=?", [namespaceKey])[0]?.value !== JSON.stringify(namespace)) rejectAuthority("policy-unqualified")
        return true
      } }
      owner.assertCurrent()
      const scope: RecurrenceAuthorityScope = { namespace, daemonStorageID, projectID: placement.projectID,
        projectCanonical: placement.projectCanonical, scheduleID: placement.scheduleID,
        profileID: placement.profileID, executionHost: placement.executionHost }
      const provider = yield* acquireNativeRecurrenceAuthorityProvider(exactCtx, scope, owner)
      const source = yield* acquireNativeRecurrenceStore(exactCtx)
      const native = yield* acquireMissionNativeService()
      const initial = yield* Effect.promise(() => provider.read())
      const parent = yield* Effect.promise(() => provider.store.readParent(placement.epoch))
      if (!initial || !parent || parent.body.action !== "authorize" || !equal(initial.scope, scope)
        || initial.child && !equal(initial.child.parent, parent)
        || !initial.child && initial.parent.body.epoch === placement.epoch && !equal(initial.parent, parent)) rejectAuthority("authorization-blocked")
      const signed = { scope: initial.scope, parent }
      const secret = () => {
        owner.assertCurrent()
        const raw = sync("SELECT value FROM kv WHERE key=?", [signerKey])[0]?.value
        if (typeof raw !== "string" || Buffer.byteLength(raw) > 1024) rejectAuthority("untrusted-signer")
        const encoded: unknown = JSON.parse(raw)
        if (typeof encoded !== "string" || encoded.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) rejectAuthority("untrusted-signer")
        const key = createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" })
        if (key.asymmetricKeyType !== "ed25519") rejectAuthority("untrusted-signer")
        return createPublicKey(key)
      }
      const signer: NativeStandingSigner = {
        readSigners: async () => {
          const body = signed.parent.body, publicKey = secret(), digest = authoritySignerDigest(publicKey)
          if (body.signerDigest !== digest || body.provisioningGeneration !== digest
            || body.authorityID !== `rec_${digest.slice(0, 40)}` || body.keyID !== `key_${digest.slice(0, 40)}`) rejectAuthority("untrusted-signer")
          return [{ namespace, projectID: scope.projectID, projectCanonical: scope.projectCanonical,
            profileID: scope.profileID, executionHost: scope.executionHost, authorityID: body.authorityID,
            keyID: body.keyID, roots: body.roots, publicKey, provisioningGeneration: digest,
            policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" as const }]
        },
        assertSignerCurrent: snapshot => {
          if (authoritySignerDigest(secret()) !== snapshot.signerDigest || snapshot.signerDigest !== signed.parent.body.signerDigest
            || !equal(snapshot.roots, signed.parent.body.roots)) rejectAuthority("untrusted-signer")
          return true
        },
        assertProtectedCurrent: request => {
          owner.assertCurrent()
          if (!equal(request.scope, scope) || !equal(request.parent, signed.parent)
            || !equal(provider.readCurrent(`${provider.store.parentKey}/parents/${placement.epoch}`), signed.parent)
            || !equal(provider.readCurrent(provider.store.key), request.ledger)
            || request.purpose === "human") rejectAuthority("authorization-blocked")
          return true
        },
        captureHumanIntent: () => rejectAuthority("authorization-blocked"),
      }
      const authenticated = yield* Effect.promise(async () => authenticateRecurrenceStanding(signed.parent, await signer.readSigners()))
      const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect.pipe(Effect.provide(currentGraph)))
      const storage: MissionStorage = {
        get: key => run(exactCtx.storage.get(key)) as ReturnType<MissionStorage["get"]>,
        scan: options => run(exactCtx.storage.scan(options)) as ReturnType<MissionStorage["scan"]>,
        set: async (key, value, current) => { owner.assertCurrent(); current?.()
          await run(exactCtx.storage.set(key, value)); owner.assertCurrent(); current?.() },
      }
      const admission: RecurrenceAuthorizedAdmission = {
        authorize: async (document, purpose) => {
          owner.assertCurrent()
          const hot = await provider.read(), actual = await source.read(placement.scheduleID)
          const parent = hot?.parent.body
          const noTornParent = (): true => {
            if (!parent || provider.readCurrent(`${provider.store.parentKey}/parents/${parent.epoch + 1}`) !== undefined)
              rejectAuthority("authorization-blocked")
            return true
          }
          if (purpose === "dispatch") noTornParent()
          if (!hot || !actual || !parent
            || !equal(actual, document) || !equal(parent.config, document.config)
            || !equal(parent.profileSource.profileID, placement.profileID)
            || !equal(parent.profileSource.executionHost, placement.executionHost)
            || !equal(hot.scope, scope) || !equal(provider.readCurrent(`${provider.store.parentKey}/parents/${parent.epoch}`), hot.parent)
            || purpose === "dispatch" && (parent.epoch !== placement.epoch || !equal(hot.parent, signed.parent)
              || document.state !== "running" || hot.child && !document.pending)
            || purpose === "settle" && (!document.pending
              || hot.child && !equal(hot.child.parent, signed.parent))) {
            rejectAuthority("authorization-blocked")
          }
          authenticateRecurrenceStanding(hot.parent, await signer.readSigners())
          if (purpose === "dispatch") {
            assertRecurrenceDispatchFeasible(document.config, parent.budgets)
            // Fresh signed YAML readability is preparation, not session ENV mutation.
            // Reject before calendar reservation; actual sends still reread it.
            await readAutonomousMissionEnvironment(scope, parent.profileSource, signal)
          }
          return () => {
            owner.assertCurrent(); signer.assertSignerCurrent(authenticated.signer)
            if (purpose === "dispatch") noTornParent()
            // Source reservation and child/effect CAS advance their own revisions.
            // Fence the signed epoch and exact deterministic child, not stale
            // pre-write bytes; each native effect has its separate single-use guard.
            const latest = provider.readCurrent(provider.store.key) as typeof hot
            if (!latest || !equal(latest.scope, scope) || !equal(latest.parent, hot.parent)
              || latest.settledSequence !== hot.settledSequence
              || hot.child && (!latest.child || !equal(latest.child.grant, hot.child.grant))
              || !hot.child && latest.child && (!document.pending || !equal(latest.child.grant,
                 deriveRecurrenceChild(hot.parent, document, hot.settledSequence + 1)))) rejectAuthority("revision-conflict")
            if (purpose === "dispatch") assertRecurrenceDispatchFeasible(document.config, latest.parent.body.budgets)
            return true
          }
        },
        admit: (document, beforeEffect) => admitNativeRecurrencePassage({ document, provider, signer, owner,
          storage, native, profile: signed.parent.body.profileSource, signal,
          settlementSignal: AbortSignal.timeout(120_000), beforeEffect }),
      }
      const runner = new MissionRecurrenceRunner(source, admission, now)
      const reconcile = async (doc: Readonly<RecurrenceDocument>): Promise<RecurrenceRunOutcome> => {
        const pending = doc.pending!, accepted = pending.admission!
        const ledger = await provider.read()
        if (!ledger || !equal(ledger.scope, scope) || !equal(ledger.parent.body.config, doc.config)
          || doc.config.publication.policy !== "disabled") return "pending"
        const observerSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        let archive
        if (ledger.child) {
          if (!equal(ledger.child.parent, signed.parent) || ledger.child.grant.passage.id !== pending.passage.id
            || ledger.child.grant.messageID !== accepted.messageID || ledger.child.grant.missionID !== accepted.missionID
            || ledger.child.grant.coordinatorSessionID !== accepted.conversationID) return "pending"
          const authority = new RecurrenceAuthority(provider.store, nativeRecurrenceAdapter({ provider, signer, owner,
            observeSettlement: (child, evidenceSignal) => reconcilePending(provider, storage, child, evidenceSignal) }))
          archive = await provider.transact(owner.assertCurrent, () => authority.settle(ledger.child!.grant.grantID,
            ledger.revision, observerSignal))
        } else {
          // Crash after authority archive: reconcile only the original immutable
          // receipt, never observe/re-dispatch an effect or invent new terminality.
          archive = await provider.store.readPassage(pending.passage.id)
          if (!archive || ledger.settledSequence !== archive.child.grant.sequence
            || ledger.lastArchiveDigest !== recurrenceAuthorityDigest(archive)) return "pending"
        }
        const grant = archive.child.grant, terminal = archive.settlement
        if (grant.passage.id !== pending.passage.id || grant.messageID !== accepted.messageID
          || grant.missionID !== accepted.missionID || grant.coordinatorSessionID !== accepted.conversationID
          || !equal(archive.child.parent, signed.parent) || terminal.grantID !== grant.grantID
          || !["completed", "failed", "stopped"].includes(terminal.outcome)
          || !terminal.nativeIdle || !terminal.controlsSettled || !terminal.notificationsSettled || !terminal.derivedCallsEnded)
          return "pending"
        const fresh = await source.read(placement.scheduleID)
        if (!fresh || !equal(fresh.pending, pending)) return "pending"
        const fence = await admission.authorize(fresh, "settle")
        // Authority is already archived. Finish only from exact validated read
        // receipts, never from admission ACKs or newly queried source messages.
        recurrenceInput(archive.child)
        const sources = recurrenceSources(archive.child), cursors = recurrenceSourceCursors(archive)
        const archived = (): true => {
          fence()
          if (!equal(provider.readCurrent(`${provider.store.parentKey}/passages/${grant.passage.id}`), archive))
            rejectAuthority("observation-unavailable")
          for (const item of sources) {
            const cursor = fresh.cursors.find(cursor => cursor.conversationID === item.conversationID)
            if ((cursor?.messageID ?? null) !== item.afterMessageID
              || cursor?.locationDigest !== undefined && cursor.locationDigest !== recurrenceSourceLocationDigest(item))
              rejectAuthority("binding-mismatch")
            provider.assertSourcePlacement(item.conversationID, item)
          }
          return true
        }
        await source.finish(placement.scheduleID, { passageID: grant.passage.id, messageID: grant.messageID,
          missionID: grant.missionID, conversationID: grant.coordinatorSessionID,
          outcome: terminal.outcome as "completed" | "failed" | "stopped", artifactMessageIDs: [], cursors }, now(), archived)
        return runner.tick(placement.scheduleID)
      }
      const document = yield* Effect.promise(() => source.read(placement.scheduleID))
      if (document?.pending) {
        if (!document.pending.admission) return "pending"
        return yield* Effect.tryPromise(() => reconcile(document)).pipe(
          Effect.catchCause(() => Effect.succeed("pending" as const))) // Unknown evidence never replays the child.
      }
      return yield* Effect.tryPromise(() => runner.tick(placement.scheduleID))
    }).pipe(Effect.provide(graph), Effect.scoped))
}
