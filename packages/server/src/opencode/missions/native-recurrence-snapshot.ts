import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import { createPrivateKey, createPublicKey } from "node:crypto"
import { lstatSync } from "node:fs"
import type { SqlClient } from "effect/unstable/sql"
import { authorityDigest, authoritySignerDigest, canonicalAuthority, MISSION_AUTHORITY_POLICY } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { authenticateRecurrenceStanding } from "../../missions/recurrence-authority-contract"
import { NativeRecurrenceAuthorityStore } from "../../missions/recurrence-authority-store"
import type { RecurrenceDocument } from "../../missions/recurrence-contract"
import { readNativeRecurrenceClock } from "./native-service-clock"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"

const locationTag = Context.Service<never, unknown>("@opencode/Location")
const dbTag = Context.Service<never, unknown>("@opencode/storage/Database")
const info = Schema.toType(Schema.Struct(Location.Info.fields))

/** A stored JSON state is not a signer. Missing/corrupt ledger, mismatched
 * signer or changed native DB must leave the schedule unavailable. */
const signed = Effect.fn("missions.signedRecurrenceRead")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location">, schedule: RecurrenceDocument,
) {
  const found = yield* Effect.serviceOption(dbTag)
  if (Option.isNone(found)) return null
  const client = (found.value as { db?: { $client?: SqlClient.SqlClient } }).db?.$client
  if (!Predicate.isFunction(client) || !Predicate.isFunction(client.unsafe)) return null
  const rows = yield* client.unsafe("PRAGMA database_list", []).withoutTransform
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.file !== "string") return null
  const file = rows[0].file, identity = lstatSync(file, { bigint: true })
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1n) return null
  const namespace = yield* ctx.storage.get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`)
  if (typeof namespace !== "string") return null
  const scope = { namespace, projectID: schedule.projectID, projectCanonical: schedule.projectCanonical,
    scheduleID: schedule.id, profileID: schedule.config.profileID, executionHost: schedule.config.executionHost,
    daemonStorageID: authorityDigest({ file, dev: String(identity.dev), ino: String(identity.ino), birth: String(identity.birthtimeNs) }) }
  const authority = new NativeRecurrenceAuthorityStore({ get: key => Effect.runPromise(ctx.storage.get(key)),
    set: async () => { throw new Error("Read only") }, scan: async () => ({ entries: [] }) }, scope)
  const ledger = yield* Effect.promise(() => authority.read())
  if (!ledger || ledger.parent.body.scheduleRevision !== schedule.scheduleRevision
    || canonicalAuthority(ledger.parent.body.config) !== canonicalAuthority(schedule.config)
    || ledger.parent.body.action !== (schedule.state === "running" ? "authorize" : schedule.state === "paused" ? "pause" : "revoke")) return null
  const secret = yield* ctx.storage.get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/${scope.profileID}`)
  if (typeof secret !== "string" || secret.length > 512) return null
  const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(secret, "base64"), format: "der", type: "pkcs8" }))
  const body = ledger.parent.body
  authenticateRecurrenceStanding(ledger.parent, [{ authorityID: body.authorityID, keyID: body.keyID,
    profileID: scope.profileID, executionHost: scope.executionHost, namespace, projectID: scope.projectID,
    projectCanonical: scope.projectCanonical, roots: body.roots, publicKey,
    provisioningGeneration: authoritySignerDigest(publicKey), policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" }])
  if (body.signerDigest !== authoritySignerDigest(publicKey) || body.profileSource.profileID !== scope.profileID) return null
  return body.epoch
})

/** No scan beyond the bounded native project prefix, no state/Job writes. */
export const readNativeRecurrenceSnapshot = Effect.fn("missions.readNativeRecurrenceSnapshot")(function* (
  ctx: Pick<Plugin.Context, "location" | "storage">,
) {
  const origin = yield* Effect.serviceOption(locationTag)
  if (Option.isNone(origin)) throw new Error("Native Location graph unavailable")
  const location = yield* Schema.decodeUnknownEffect(info)(origin.value)
  if (location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
    || location.project.id !== ctx.location.project.id || location.project.canonical !== ctx.location.project.canonical) {
    throw new Error("Recurrence Location changed")
  }
  const store = yield* acquireNativeRecurrenceStore(ctx)
  const schedules = (yield* Effect.promise(() => store.list())).filter(schedule =>
    schedule.config.roots.some(root => root.directory === location.directory))
  const results = [] as Array<{ id: string; revision: number; scheduleRevision: number;
    state: "paused" | "interrupted" | "unavailable" | "stopped"; clock: typeof schedules[number]["config"]["clock"];
    pendingPassageID: string | null; settledCount: number }>
  for (const schedule of schedules) {
    // A signed ledger is necessary but never sufficient to advertise dispatch:
    // Job status is volatile, and finite due admission is not enabled yet.
    const epoch = yield* signed(ctx, schedule).pipe(Effect.catchCause(() => Effect.succeed(null)))
    const clock = epoch !== null && schedule.state === "running" ? yield* readNativeRecurrenceClock({
      projectID: schedule.projectID, projectCanonical: schedule.projectCanonical, directory: location.directory,
      ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }),
      scheduleID: schedule.id, profileID: schedule.config.profileID, executionHost: schedule.config.executionHost,
      epoch,
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined))) : undefined
    const state = epoch === null ? "unavailable" : schedule.state === "running" ? clock === true ? "unavailable" : "interrupted" : schedule.state
    results.push({ id: schedule.id, revision: schedule.revision, scheduleRevision: schedule.scheduleRevision,
      state, clock: schedule.config.clock, pendingPassageID: schedule.pending?.passage.id ?? null,
      settledCount: schedule.settledCount })
  }
  return { version: 1 as const, projectID: location.project.id, projectCanonical: location.project.canonical,
    location: { directory: location.directory, ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }) },
    schedules: results }
})
