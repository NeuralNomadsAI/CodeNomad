import { sign } from "node:crypto"
import { realpathSync } from "node:fs"
import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { verifyRecurrenceBridge } from "../automation-plugin"
import { authorityDigest, authoritySignerDigest, canonicalAuthority, rejectAuthority } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { recurrenceAuthorityDocumentSchema, NativeRecurrenceAuthorityStore } from "../../missions/recurrence-authority-store"
import { RECURRENCE_AUTHORITY_POLICY, recurrenceHumanRequestID, recurrenceStandingIntentSchema,
  recurrenceStandingSigningBytes, authenticateRecurrenceStanding, recurrenceProfileSourceSchema, type SignedRecurrenceStandingIntent } from "../../missions/recurrence-authority-contract"
import { parseRecurrenceDocument, RECURRENCE_STORAGE_PREFIX, recurrenceIDSchema } from "../../missions/recurrence-contract"
import { stableToken } from "../../missions/journal"
import { assertRecurrenceProofFresh, recurrenceControlRequestDigest } from "../../missions/recurrence-control-proof"
import { recurrenceControlRequestSchema } from "../../missions/recurrence-control-contract"
import { physical } from "../../missions/host-authority/private-files"
import { readFamilyAuthorityPlacementSync } from "../../workspaces/family-authority-claim"
import { assertRecurrenceDispatchFeasible } from "../../missions/recurrence-read-budget"
import { nativeDatabaseStorageID } from "./native-database-identity"
import { acquireRecurrenceSigner } from "./native-recurrence-signer"
import { cancelNativeRecurrenceClock, readNativeRecurrenceClock, startNativeRecurrenceClock, type RecurrenceClockPlacement } from "./native-service-clock"
import { nativeRecurrenceDue } from "./native-recurrence-due"
import { qualifyNativeRecurrenceControl } from "./native-recurrence-capability"
import { interruptRecurrenceActors } from "./native-recurrence-actor-controls"
import { emitNativeRecurrenceChanged } from "./native-recurrence-events"
import type { MissionLifecycleOperation } from "../../missions/lifecycle-model"

interface NativeControlResult {
  version: 1; scheduleID: string; requestID: string; revision: number; epoch: number; state: "running" | "paused" | "stopped"
  controlsComplete: boolean; schedulerCancellation?: "acknowledged" | "unknown"; nativeControl?: MissionLifecycleOperation
}

const dbTag = Context.Service<never, unknown>("@opencode/storage/Database")
const locationTag = Context.Service<never, unknown>("@opencode/Location")
const nativeKey = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const inputSchema = Schema.Struct({ sessionID: Schema.String, workspaceID: Schema.String, requestID: Schema.String,
  location: Schema.Struct({ directory: Schema.String, workspaceID: Schema.optional(Schema.String) }),
  digest: Schema.String, scheduleID: Schema.String, expectedRevision: Schema.Number, expectedEpoch: Schema.Number,
  action: Schema.Literals(["play", "pause", "stop"]), profileSource: Schema.Struct({ profileID: Schema.String,
    executionHost: Schema.String, configYamlPath: Schema.String }), issuedAt: Schema.Number, proof: Schema.String })
export type NativeRecurrenceControlInput = typeof inputSchema.Type

async function assertBridgeProof(input: NativeRecurrenceControlInput) {
  const { proof, ...body } = input
  if (!/^[a-f0-9]{64}$/.test(proof) || !/^[a-f0-9]{64}$/.test(input.digest)
    || input.digest !== recurrenceControlRequestDigest((({ digest: _digest, ...identity }) => identity)(body))
    || input.sessionID === "auth-disabled" || !input.sessionID || input.sessionID.length > 256
    || !input.workspaceID || input.workspaceID.length > 200 || !input.requestID || input.requestID.length > 128
    || !Number.isSafeInteger(input.issuedAt)
    || input.issuedAt > Date.now() + 5_000 || Date.now() - input.issuedAt > 30_000) rejectAuthority("untrusted-signer")
  if (!await verifyRecurrenceBridge(body, proof)) rejectAuthority("untrusted-signer")
  assertRecurrenceProofFresh(input.issuedAt)
}

/** Explicit human Play/Pause/Stop only. The reviewed service-owned due callback
 * reacquires fresh native admission; nothing is armed at plugin setup/restart. */
export const controlNativeRecurrence = Effect.fn("missions.controlNativeRecurrence")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location" | "session">, raw: unknown,
) {
  const input = yield* Schema.decodeUnknownEffect(inputSchema)(raw)
  recurrenceIDSchema.parse(input.scheduleID)
  recurrenceProfileSourceSchema.parse(input.profileSource)
  recurrenceControlRequestSchema.parse({ scheduleID: input.scheduleID, requestID: input.requestID,
    action: input.action, expectedRevision: input.expectedRevision, expectedEpoch: input.expectedEpoch })
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) rejectAuthority("invalid-intent")
  const playRequested: boolean = input.action === "play"
  // Qualify before the first signed write, not after optimistic activation.
  if (playRequested) yield* qualifyNativeRecurrenceControl()
  yield* Effect.tryPromise(() => assertBridgeProof(input))
  const origin = yield* Effect.serviceOption(locationTag), found = yield* Effect.serviceOption(dbTag)
  if (Option.isNone(origin) || Option.isNone(found)) rejectAuthority("trust-unavailable")
  const location = yield* Schema.decodeUnknownEffect(Schema.toType(Schema.Struct(Location.Info.fields)))(origin.value)
  if (location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
    || location.project.id !== ctx.location.project.id || location.project.canonical !== ctx.location.project.canonical
    || input.location.directory !== location.directory || input.location.workspaceID !== location.workspaceID) rejectAuthority("binding-mismatch")
  const db = found.value as { db?: { $client?: SqlClient.SqlClient; transaction?: <A>(run: () => Effect.Effect<A, unknown>, options: { behavior: "immediate" }) => Effect.Effect<A, unknown> } }
  if (!Predicate.isFunction(db.db?.$client) || !Predicate.isFunction(db.db?.$client?.unsafe)
    || !Predicate.isFunction(db.db?.transaction)) rejectAuthority("trust-unavailable")
  const graph = yield* Effect.context<never>()
  const query = (sql: string, parameters: readonly unknown[] = []) => db.db!.$client!.unsafe(sql, parameters).withoutTransform.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(rows)))
  const get = (key: string) => query("SELECT value FROM kv WHERE key=?", [nativeKey(key)]).pipe(Effect.map(result => {
    const value = result[0]?.value
    if (value === undefined) return undefined
    if (typeof value !== "string" || Buffer.byteLength(value) > 256 * 1024) rejectAuthority("storage-invalid")
    return JSON.parse(value) as unknown
  }))
  const put = (key: string, value: unknown) => query("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,time_updated=excluded.time_updated",
    [nativeKey(key), canonicalAuthority(value, 256 * 1024), Date.now(), Date.now()])
  const projectID = location.project.id, projectCanonical = location.project.canonical
  const sourceKey = `${RECURRENCE_STORAGE_PREFIX}/project/${stableToken(`${projectID}\0${projectCanonical}`, 24)}/${input.scheduleID}`
  const namespace = yield* ctx.storage.get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`)
  if (typeof namespace !== "string" || !/^[a-f\d-]{36}$/.test(namespace)) rejectAuthority("namespace-mismatch")
  const file = (yield* query("PRAGMA database_list"))[0]?.file
  if (typeof file !== "string" || !file) rejectAuthority("trust-unavailable")
  const daemonStorageID = nativeDatabaseStorageID(file)
  const signerKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/${input.profileSource.profileID}`
  const scope = { namespace, daemonStorageID, projectID, projectCanonical, scheduleID: input.scheduleID,
    profileID: input.profileSource.profileID, executionHost: input.profileSource.executionHost }
  const authority = new NativeRecurrenceAuthorityStore({ get: async () => undefined, set: async () => {}, scan: async () => ({ entries: [] }) }, scope)
  const action = input.action === "play" ? "authorize" : input.action === "pause" ? "pause" : "revoke"
  const result = yield* db.db!.transaction!(() => Effect.gen(function* () {
    assertRecurrenceProofFresh(input.issuedAt)
    if ((yield* get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`)) !== namespace) rejectAuthority("policy-unqualified")
    const raw = yield* get(sourceKey)
    if (raw === undefined) rejectAuthority("observation-unavailable")
    const schedule = parseRecurrenceDocument(raw, projectID, projectCanonical, input.scheduleID)
    const oldRaw = yield* get(authority.key)
    const old = oldRaw === undefined ? undefined : recurrenceAuthorityDocumentSchema.parse(oldRaw)
    if (!playRequested && old?.parent.body.requestID === input.requestID
      && old.parent.body.expectedScheduleRevision === input.expectedRevision && old.parent.body.epoch === input.expectedEpoch + 1
      && old.parent.body.action === action) {
      // Explicit retry of the SAME denying epoch; only unresolved native target
      // receipts may advance. Never sign another parent, rearm, prompt or assign.
      return { state: schedule.state, epoch: old.parent.body.epoch,
        clockEpoch: old.parent.body.clockEpoch ?? input.expectedEpoch, previousClockEpoch: undefined,
        scheduleRevision: schedule.scheduleRevision, sourceRevision: schedule.revision, changed: false }
    }
    if (input.action === "pause" && old?.parent.body.action === "pause") rejectAuthority("authorization-blocked")
    const root = schedule.config.roots[0]
    const placement = root?.mode === "git" ? readFamilyAuthorityPlacementSync(root.directory) : undefined
    if (playRequested && schedule.config.budgets) assertRecurrenceDispatchFeasible(schedule.config, schedule.config.budgets)
    if (schedule.revision !== input.expectedRevision || schedule.state === "stopped"
      || !schedule.config.budgets
      || playRequested && schedule.config.publication.policy !== "disabled"
      || schedule.config.roots.length !== 1 || !root || root.mode !== "git" || root.directory !== location.directory
      || placement?.checkout !== root.checkout || placement.family !== root.family
      || physical(realpathSync(root.family)) !== root.family
      || schedule.config.profileID !== scope.profileID || schedule.config.executionHost !== scope.executionHost
      || schedule.pending && input.action === "play") rejectAuthority("revision-conflict")
    const { privateKey, publicKey, secret } = yield* acquireRecurrenceSigner(() => get(signerKey), value =>
      query("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,?,?) ON CONFLICT(key) DO NOTHING",
        [nativeKey(signerKey), JSON.stringify(value), Date.now(), Date.now()]), playRequested)
    const signerDigest = authoritySignerDigest(publicKey)
    if ((old?.parent.body.epoch ?? 0) !== input.expectedEpoch) rejectAuthority("epoch-conflict")
    if (old && canonicalAuthority(old.scope) !== canonicalAuthority(scope)) rejectAuthority("binding-mismatch")
    if (!old && input.action !== "play" || old?.parent.body.action === "revoke" || old?.child && input.action === "play") rejectAuthority("authorization-blocked")
    if (old) {
      const prior = old.parent.body
      if (canonicalAuthority(yield* get(`${authority.parentKey}/parents/${prior.epoch}`)) !== canonicalAuthority(old.parent)
        || prior.signerDigest !== signerDigest || prior.daemonStorageID !== daemonStorageID
        || prior.provisioningGeneration !== signerDigest
        || schedule.state !== (prior.action === "authorize" ? "running" : "paused")
        || canonicalAuthority(prior.config) !== canonicalAuthority(schedule.config)) rejectAuthority("storage-invalid")
      authenticateRecurrenceStanding(old.parent, [{ authorityID: prior.authorityID, keyID: prior.keyID,
        profileID: scope.profileID, executionHost: scope.executionHost, namespace, projectID, projectCanonical,
        roots: schedule.config.roots, publicKey, provisioningGeneration: signerDigest,
        policy: "codenomad.missions.authority/signed-v1", qualification: "qualified" }])
      if (schedule.state === "running" && input.action === "play") {
        const priorClock = yield* readNativeRecurrenceClock({ projectID, projectCanonical, directory: location.directory,
          ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }),
          scheduleID: input.scheduleID, profileID: scope.profileID, executionHost: scope.executionHost, epoch: prior.epoch })
        if (priorClock !== false) rejectAuthority("authorization-blocked")
      }
    } else if (schedule.state !== "paused") rejectAuthority("authorization-blocked")
    const epoch = (old?.parent.body.epoch ?? 0) + 1
    const body = recurrenceStandingIntentSchema.parse({ ...scope, version: 1, policy: RECURRENCE_AUTHORITY_POLICY,
      authorityID: `rec_${signerDigest.slice(0, 40)}`, keyID: `key_${signerDigest.slice(0, 40)}`,
      roots: schedule.config.roots, scheduleRevision: schedule.scheduleRevision, epoch,
      expectedRevision: old?.revision ?? null, requestID: recurrenceHumanRequestID(input.scheduleID, epoch, action),
      expectedScheduleRevision: input.expectedRevision,
      clockEpoch: playRequested ? epoch : old?.parent.body.clockEpoch ?? old?.parent.body.epoch,
      provisioningGeneration: signerDigest, signerDigest, action, configDigest: authorityDigest(schedule.config),
      config: schedule.config, profileSource: input.profileSource,
      budgets: schedule.config.budgets })
    if (old && (canonicalAuthority(old.parent.body.config) !== canonicalAuthority(body.config)
      || canonicalAuthority(old.parent.body.profileSource) !== canonicalAuthority(body.profileSource)) && action !== "authorize") rejectAuthority("binding-mismatch")
    const parent: SignedRecurrenceStandingIntent = { body, signature: sign(null, recurrenceStandingSigningBytes(body), privateKey).toString("base64") }
    const archiveKey = `${authority.parentKey}/parents/${epoch}`
    if ((yield* get(archiveKey)) !== undefined) rejectAuthority("request-conflict")
    const next = { version: 1 as const, scope, revision: old ? old.revision + 1 : 0, parent,
      settledSequence: old?.settledSequence ?? 0, lastArchiveDigest: old?.lastArchiveDigest ?? null, child: old?.child ?? null }
    const state = action === "authorize" ? "running" : action === "pause" ? "paused" : "stopped"
    // All three records commit together or none do. No side effect occurs in a
    // due callback until a separate native admission producer is qualified.
    assertRecurrenceProofFresh(input.issuedAt)
    yield* put(archiveKey, parent)
    yield* put(authority.key, next)
    yield* put(sourceKey, { ...schedule, revision: schedule.revision + 1, state })
    if (canonicalAuthority(yield* get(authority.key)) !== canonicalAuthority(next)
      || (yield* get(sourceKey)) === undefined
      || (yield* get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`)) !== namespace
      || (yield* get(signerKey)) !== secret) rejectAuthority("storage-unavailable")
    assertRecurrenceProofFresh(input.issuedAt)
    return { state, epoch, clockEpoch: body.clockEpoch,
      previousClockEpoch: old?.parent.body.clockEpoch ?? old?.parent.body.epoch, scheduleRevision: schedule.scheduleRevision,
      sourceRevision: schedule.revision + 1, changed: true }
  }), { behavior: "immediate" }).pipe(Effect.provide(graph))
  const placement: RecurrenceClockPlacement = { projectID, projectCanonical, directory: location.directory,
    ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }), scheduleID: input.scheduleID,
    profileID: scope.profileID, executionHost: scope.executionHost, epoch: result.epoch }
  const notify = (revision: number) => emitNativeRecurrenceChanged(placement, input.scheduleID, revision).pipe(
    Effect.catchCause(() => Effect.logWarning("recurrence-invalidation-unavailable")))
  if (result.changed) yield* notify(result.sourceRevision)
  const recordResult = (value: unknown) => db.db!.transaction!(() => Effect.gen(function* () {
    const archived = yield* get(`${authority.parentKey}/parents/${result.epoch}`)
    const parent = archived as { body?: { requestID?: string; expectedScheduleRevision?: number } } | undefined
    if (parent?.body?.requestID !== input.requestID || parent.body.expectedScheduleRevision !== input.expectedRevision
      || nativeDatabaseStorageID(file) !== daemonStorageID) rejectAuthority("binding-mismatch")
    const key = `${authority.parentKey}/controls/${result.epoch}`, before = yield* get(key)
    if (canonicalAuthority(before ?? null, 256 * 1024) === canonicalAuthority(value, 256 * 1024)) return false
    yield* put(key, value)
    return true
  }), { behavior: "immediate" }).pipe(Effect.provide(graph),
    Effect.flatMap(changed => changed ? notify(result.sourceRevision) : Effect.void))
  if (playRequested) {
    // Consume only the predecessor's volatile Job record. This is not durable
    // settlement, and never changes the pending passage/receipt high-water.
    if (result.previousClockEpoch) yield* cancelNativeRecurrenceClock({ ...placement, epoch: result.previousClockEpoch })
    yield* startNativeRecurrenceClock(placement, nativeRecurrenceDue(ctx, placement))
    const response: NativeControlResult = { version: 1, scheduleID: input.scheduleID, revision: input.expectedRevision + 1,
      state: result.state as NativeControlResult["state"], epoch: result.epoch, requestID: input.requestID, controlsComplete: true }
    yield* recordResult(response)
    return response
  } else {
    // Denial is durable first. A failed scheduler cancellation must not skip
    // interruption of the registered native actors.
    let cancelKnown = false
    if (result.clockEpoch) {
      yield* cancelNativeRecurrenceClock({ ...placement, epoch: result.clockEpoch }).pipe(
        Effect.flatMap(() => readNativeRecurrenceClock({ ...placement, epoch: result.clockEpoch! })),
        Effect.tap(value => Effect.sync(() => { cancelKnown = value === false })), Effect.catchCause(() => Effect.void))
    }
    const nativeControl = yield* Effect.scoped(interruptRecurrenceActors(ctx, { scheduleID: input.scheduleID,
      requestID: input.requestID, epoch: result.epoch, action: input.action as "pause" | "stop" }))
    const response: NativeControlResult = { version: 1, scheduleID: input.scheduleID, requestID: input.requestID,
      revision: input.expectedRevision + 1, state: result.state as NativeControlResult["state"], epoch: result.epoch,
      controlsComplete: cancelKnown && !nativeControl?.pending.length,
      schedulerCancellation: cancelKnown ? "acknowledged" as const : "unknown" as const,
      ...(nativeControl ? { nativeControl } : {}) }
    yield* recordResult(response)
    return response
  }
})
