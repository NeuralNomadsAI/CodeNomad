import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, timingSafeEqual } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { lstat, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { automationBridgeDirectories } from "../automation-plugin"
import { authorityDigest, authoritySignerDigest, canonicalAuthority, rejectAuthority } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { recurrenceAuthorityDocumentSchema, NativeRecurrenceAuthorityStore } from "../../missions/recurrence-authority-store"
import { RECURRENCE_AUTHORITY_POLICY, recurrenceHumanRequestID, recurrenceStandingIntentSchema,
  recurrenceStandingSigningBytes, authenticateRecurrenceStanding, recurrenceProfileSourceSchema, type SignedRecurrenceStandingIntent } from "../../missions/recurrence-authority-contract"
import { parseRecurrenceDocument, RECURRENCE_STORAGE_PREFIX, recurrenceIDSchema } from "../../missions/recurrence-contract"
import { stableToken } from "../../missions/journal"
import { signNativeRecurrenceControl } from "../../missions/recurrence-control-proof"
import { physical } from "../../missions/host-authority/private-files"
import { readFamilyAuthorityIdentitySync } from "../../workspaces/family-authority-claim"
import { cancelNativeRecurrenceClock, readNativeRecurrenceClock, startNativeRecurrenceClock, type RecurrenceClockPlacement } from "./native-service-clock"

const dbTag = Context.Service<never, unknown>("@opencode/storage/Database")
const locationTag = Context.Service<never, unknown>("@opencode/Location")
const nativeKey = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const inputSchema = Schema.Struct({ scheduleID: Schema.String, expectedRevision: Schema.Number,
  action: Schema.Literals(["play", "pause", "stop"]), profileSource: Schema.Struct({ profileID: Schema.String,
    executionHost: Schema.String, configYamlPath: Schema.String }), issuedAt: Schema.Number, proof: Schema.String })
export type NativeRecurrenceControlInput = typeof inputSchema.Type

async function assertBridgeProof(input: NativeRecurrenceControlInput) {
  const { proof, ...body } = input
  if (!/^[a-f0-9]{64}$/.test(proof) || !Number.isSafeInteger(input.issuedAt)
    || input.issuedAt > Date.now() + 5_000 || Date.now() - input.issuedAt > 30_000) rejectAuthority("untrusted-signer")
  for (const directory of automationBridgeDirectories()) {
    const names = await readdir(directory).catch(() => [])
    if (names.length > 4096) rejectAuthority("trust-unavailable")
    for (const name of names) {
      if (!/^\d+-\d+-[A-Za-z0-9_-]{12}\.json$/.test(name)) continue
      const file = path.join(directory, name)
      const info = await lstat(file).catch(() => undefined)
      if (!info?.isFile() || info.isSymbolicLink() || info.size > 4096) continue
      const registration = JSON.parse(await readFile(file, "utf8")) as { token?: unknown }
      if (typeof registration.token !== "string" || registration.token.length < 32) continue
      const expected = Buffer.from(signNativeRecurrenceControl(body, registration.token), "hex")
      if (timingSafeEqual(expected, Buffer.from(proof, "hex"))) return
    }
  }
  rejectAuthority("untrusted-signer")
}

/** Explicit human Play/Pause/Stop only. There is intentionally no CREATE or
 * model-call method here. The Job's due callback has no dispatch capability. */
export const controlNativeRecurrence = Effect.fn("missions.controlNativeRecurrence")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location">, raw: unknown,
) {
  const input = yield* Schema.decodeUnknownEffect(inputSchema)(raw)
  recurrenceIDSchema.parse(input.scheduleID)
  recurrenceProfileSourceSchema.parse(input.profileSource)
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) rejectAuthority("invalid-intent")
  yield* Effect.tryPromise(() => assertBridgeProof(input))
  const origin = yield* Effect.serviceOption(locationTag), found = yield* Effect.serviceOption(dbTag)
  if (Option.isNone(origin) || Option.isNone(found)) rejectAuthority("trust-unavailable")
  const location = yield* Schema.decodeUnknownEffect(Schema.toType(Schema.Struct(Location.Info.fields)))(origin.value)
  if (location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
    || location.project.id !== ctx.location.project.id || location.project.canonical !== ctx.location.project.canonical) rejectAuthority("binding-mismatch")
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
  if (typeof file !== "string" || !file || lstatSync(file).isSymbolicLink()) rejectAuthority("trust-unavailable")
  const identity = lstatSync(file, { bigint: true })
  if (!identity.isFile() || identity.nlink !== 1n) rejectAuthority("trust-unavailable")
  const daemonStorageID = authorityDigest({ file, dev: String(identity.dev), ino: String(identity.ino), birth: String(identity.birthtimeNs) })
  const signerKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/${input.profileSource.profileID}`
  let secret = yield* ctx.storage.get(signerKey)
  if (secret === undefined && input.action === "play") {
    const keys = generateKeyPairSync("ed25519")
    const created = keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    yield* ctx.storage.set(signerKey, created)
    secret = yield* ctx.storage.get(signerKey)
    if (secret !== created) rejectAuthority("request-conflict")
  }
  if (typeof secret !== "string" || secret.length > 512) rejectAuthority("untrusted-signer")
  const privateKey = createPrivateKey({ key: Buffer.from(secret, "base64"), format: "der", type: "pkcs8" })
  if (privateKey.asymmetricKeyType !== "ed25519") rejectAuthority("untrusted-signer")
  const publicKey = createPublicKey(privateKey), signerDigest = authoritySignerDigest(publicKey)
  const scope = { namespace, daemonStorageID, projectID, projectCanonical, scheduleID: input.scheduleID,
    profileID: input.profileSource.profileID, executionHost: input.profileSource.executionHost }
  const authority = new NativeRecurrenceAuthorityStore({ get: async () => undefined, set: async () => {}, scan: async () => ({ entries: [] }) }, scope)
  const action = input.action === "play" ? "authorize" : input.action === "pause" ? "pause" : "revoke"
  const result = yield* db.db!.transaction!(() => Effect.gen(function* () {
    if ((yield* get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`)) !== namespace
      || (yield* get(signerKey)) !== secret) rejectAuthority("policy-unqualified")
    const raw = yield* get(sourceKey)
    if (raw === undefined) rejectAuthority("observation-unavailable")
    const schedule = parseRecurrenceDocument(raw, projectID, projectCanonical, input.scheduleID)
    const root = schedule.config.roots[0]
    if (schedule.revision !== input.expectedRevision || schedule.state === "stopped"
      || schedule.config.roots.length !== 1 || !root || root.mode !== "git" || root.directory !== location.directory
      || physical(realpathSync(root.directory)) !== root.checkout
      || physical(realpathSync(root.family)) !== root.family || readFamilyAuthorityIdentitySync(root.directory) !== root.family
      || schedule.config.profileID !== scope.profileID || schedule.config.executionHost !== scope.executionHost
      || schedule.pending && input.action === "play") rejectAuthority("revision-conflict")
    const oldRaw = yield* get(authority.key)
    const old = oldRaw === undefined ? undefined : recurrenceAuthorityDocumentSchema.parse(oldRaw)
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
      provisioningGeneration: signerDigest, signerDigest, action, configDigest: authorityDigest(schedule.config),
      config: schedule.config, profileSource: input.profileSource,
      budgets: { effects: 32, nativeCalls: 16, inboxMessages: 128, publications: 8 } })
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
    yield* put(archiveKey, parent)
    yield* put(authority.key, next)
    yield* put(sourceKey, { ...schedule, revision: schedule.revision + 1, state })
    if (canonicalAuthority(yield* get(authority.key)) !== canonicalAuthority(next)
      || (yield* get(sourceKey)) === undefined
      || (yield* get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`)) !== namespace
      || (yield* get(signerKey)) !== secret) rejectAuthority("storage-unavailable")
    return { state, epoch, previousEpoch: old?.parent.body.epoch, scheduleRevision: schedule.scheduleRevision }
  }), { behavior: "immediate" }).pipe(Effect.provide(graph))
  const placement: RecurrenceClockPlacement = { projectID, projectCanonical, directory: location.directory,
    ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }), scheduleID: input.scheduleID,
    profileID: scope.profileID, executionHost: scope.executionHost, epoch: result.epoch }
  if (input.action === "play") {
    // No speculative runner: the due callback cannot dispatch or reserve a
    // passage. It must fail closed until native finite admission is installed.
    yield* startNativeRecurrenceClock(placement, async () => "unknown")
  } else if (result.previousEpoch) {
    yield* cancelNativeRecurrenceClock({ ...placement, epoch: result.previousEpoch })
  }
  return { version: 1 as const, scheduleID: input.scheduleID, revision: input.expectedRevision + 1, state: result.state,
    epoch: result.epoch }
})
