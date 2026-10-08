import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import { createPrivateKey, createPublicKey } from "node:crypto"
import type { SqlClient } from "effect/unstable/sql"
import { authoritySignerDigest, canonicalAuthority, MISSION_AUTHORITY_POLICY, type ProvisionedAuthoritySigner } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { authenticateRecurrenceStanding } from "../../missions/recurrence-authority-contract"
import { NativeRecurrenceAuthorityStore } from "../../missions/recurrence-authority-store"
import type { RecurrenceDocument } from "../../missions/recurrence-contract"
import { readNativeRecurrenceClock } from "./native-service-clock"
import { nativeDatabaseStorageID } from "./native-database-identity"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { qualifyNativeRecurrenceControl } from "./native-recurrence-capability"
import type { MissionRecurrenceSnapshot } from "../../api-types"
import { recurrenceControlStatusSchema } from "../../missions/recurrence-control-contract"
import { assertRecurrenceDispatchFeasible } from "../../missions/recurrence-read-budget"

const locationTag = Context.Service<never, unknown>("@opencode/Location")
const dbTag = Context.Service<never, unknown>("@opencode/storage/Database")
const info = Schema.toType(Schema.Struct(Location.Info.fields))

/** A stored JSON state is not a signer. Missing/corrupt ledger, mismatched
 * signer or changed native DB must leave the schedule unavailable. */
export const readSignedRecurrence = Effect.fn("missions.signedRecurrenceRead")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location">, schedule: RecurrenceDocument,
) {
  const found = yield* Effect.serviceOption(dbTag)
  if (Option.isNone(found)) return null
  const client = (found.value as { db?: { $client?: SqlClient.SqlClient } }).db?.$client
  if (!Predicate.isFunction(client) || !Predicate.isFunction(client.unsafe)) return null
  const rows = yield* client.unsafe("PRAGMA database_list", []).withoutTransform
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.file !== "string") return null
  const file = rows[0].file
  const namespace = yield* ctx.storage.get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`)
  if (typeof namespace !== "string") return null
  const scope = { namespace, projectID: schedule.projectID, projectCanonical: schedule.projectCanonical,
    scheduleID: schedule.id, profileID: schedule.config.profileID, executionHost: schedule.config.executionHost,
    daemonStorageID: nativeDatabaseStorageID(file) }
  const graph = yield* Effect.context<never>()
  const authority = new NativeRecurrenceAuthorityStore({ get: key => Effect.runPromise(ctx.storage.get(key).pipe(Effect.provide(graph))),
    set: async () => { throw new Error("Read only") }, scan: async () => ({ entries: [] }) }, scope)
  const raw = yield* ctx.storage.get(authority.key)
  if (raw === undefined && schedule.state === "paused" && schedule.revision === 0 && schedule.scheduleRevision === 0
    && !schedule.pending && schedule.settledCount === 0 && !schedule.history.length
    && (yield* ctx.storage.get(`${authority.parentKey}/parents/1`)) === undefined) {
    // Positive native absence on a fresh inert CREATE is epoch zero, not a
    // signed grant. Missing, corrupt or unreadable prior authority stays unknown.
    return { epoch: 0, ledger: null, authority, signers: [] as ProvisionedAuthoritySigner[] }
  }
  const ledger = yield* Effect.promise(() => authority.read())
  if (!ledger || ledger.parent.body.scheduleRevision !== schedule.scheduleRevision
    || canonicalAuthority(ledger.parent.body.config) !== canonicalAuthority(schedule.config)
    || ledger.parent.body.action !== (schedule.state === "running" ? "authorize" : schedule.state === "paused" ? "pause" : "revoke")) return null
  const secret = yield* ctx.storage.get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/${scope.profileID}`)
  if (typeof secret !== "string" || secret.length > 512) return null
  const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(secret, "base64"), format: "der", type: "pkcs8" }))
  const body = ledger.parent.body
  const signers: ProvisionedAuthoritySigner[] = [{ authorityID: body.authorityID, keyID: body.keyID,
    profileID: scope.profileID, executionHost: scope.executionHost, namespace, projectID: scope.projectID,
    projectCanonical: scope.projectCanonical, roots: body.roots, publicKey,
    provisioningGeneration: authoritySignerDigest(publicKey), policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" as const }]
  authenticateRecurrenceStanding(ledger.parent, signers)
  if (body.signerDigest !== authoritySignerDigest(publicKey) || body.profileSource.profileID !== scope.profileID) return null
  return { epoch: body.epoch, ledger, authority, signers }
})

/** No scan beyond the bounded native project prefix, no state/Job writes. */
export const readNativeRecurrenceSnapshot = Effect.fn("missions.readNativeRecurrenceSnapshot")(function* (
  ctx: Pick<Plugin.Context, "location" | "storage">,
) {
  const origin = yield* Effect.serviceOption(locationTag)
  if (Option.isNone(origin)) throw new Error("Native Location graph unavailable")
  const location = yield* Schema.decodeUnknownEffect(info)(origin.value)
  const assertLocation = () => {
    if (location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
      || location.project.id !== ctx.location.project.id || location.project.canonical !== ctx.location.project.canonical) {
      throw new Error("Recurrence Location changed")
    }
  }
  assertLocation()
  const store = yield* acquireNativeRecurrenceStore(ctx)
  const schedules = (yield* Effect.promise(() => store.list())).filter(schedule =>
    schedule.config.roots.some(root => root.directory === location.directory))
  const qualified = yield* qualifyNativeRecurrenceControl().pipe(Effect.catchCause(() => Effect.succeed(false)))
  const results: MissionRecurrenceSnapshot["schedules"] = []
  for (const schedule of schedules) {
    // A signed parent and exact live Job are both necessary for Running.
    const authenticated = yield* readSignedRecurrence(ctx, schedule).pipe(Effect.catchCause(() => Effect.succeed(null)))
    const epoch = authenticated?.epoch ?? null
    const controlReceipt = authenticated?.ledger ? yield* ctx.storage.get(`${authenticated.authority.parentKey}/controls/${epoch}`) : undefined
    const actorControl = controlReceipt && typeof controlReceipt === "object" && !Array.isArray(controlReceipt)
      ? recurrenceControlStatusSchema.safeParse({ ...controlReceipt, expectedRevision: authenticated!.ledger!.parent.body.expectedScheduleRevision,
        outcome: "controlsComplete" in controlReceipt && controlReceipt.controlsComplete === true ? "committed" : "unknown" }) : undefined
    const clock = epoch !== null && epoch > 0 ? yield* readNativeRecurrenceClock({
      projectID: schedule.projectID, projectCanonical: schedule.projectCanonical, directory: location.directory,
      ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }),
      scheduleID: schedule.id, profileID: schedule.config.profileID, executionHost: schedule.config.executionHost,
      epoch,
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined))) : undefined
    const state = epoch === null ? "unavailable" : schedule.state === "running"
      ? clock === false ? "interrupted" : clock === true ? "running" : "unavailable" : schedule.state
    const actions: Array<"play" | "pause" | "stop"> = []
    let feasible = false
    if (schedule.config.budgets) { try { feasible = assertRecurrenceDispatchFeasible(schedule.config, schedule.config.budgets) } catch { /* No budget increase or optimistic capability. */ } }
    if (qualified && schedule.state !== "stopped" && feasible && schedule.config.publication.policy === "disabled"
      && schedule.config.roots.length === 1 && schedule.config.roots[0]?.mode === "git") {
      if (authenticated && !schedule.pending && !authenticated.ledger?.child && (schedule.state === "paused" || clock === false)) actions.push("play")
      // Action capability is not activity. This implementation nevertheless
      // requires the SAME current Map/Location claim as the Job read; unknown
      // placement cannot advertise denial controls until freshly revalidated.
      if (epoch !== null && epoch > 0 && clock !== undefined) {
        if (schedule.state === "running") actions.push("pause")
        actions.push("stop")
      }
    }
    const retry = authenticated?.ledger && authenticated.ledger.parent.body.action !== "authorize"
      && authenticated.ledger.parent.body.expectedScheduleRevision !== undefined && actorControl?.success && actorControl.data.controlsComplete === false
      ? { scheduleID: schedule.id, requestID: authenticated.ledger.parent.body.requestID,
        action: authenticated.ledger.parent.body.action === "pause" ? "pause" as const : "stop" as const,
        expectedRevision: authenticated.ledger.parent.body.expectedScheduleRevision, expectedEpoch: authenticated.epoch - 1 } : undefined
    if (retry && qualified && clock !== undefined && !actions.includes(retry.action)) actions.push(retry.action)
    const history = schedule.history.map(({ passage, settledAt, result }) => ({
      passageID: passage.id, messageID: result.messageID, dueAt: passage.due.at, settledAt,
      status: "kind" in result ? result.kind : result.outcome,
      ...("missionID" in result ? { missionID: result.missionID, conversationID: result.conversationID,
        artifactMessageIDs: result.artifactMessageIDs } : {}),
    }))
    results.push({ id: schedule.id, revision: schedule.revision, scheduleRevision: schedule.scheduleRevision,
      state, clock: schedule.config.clock, pendingPassageID: schedule.pending?.passage.id ?? null,
      settledCount: schedule.settledCount, epoch,
      pendingStatus: schedule.pending ? schedule.pending.admission ? "admitted" : "unknown" : null,
      pendingAdmission: schedule.pending?.admission ? { missionID: schedule.pending.admission.missionID,
        conversationID: schedule.pending.admission.conversationID } : null,
      latestResult: history.at(-1) ?? null, history,
      ...(actorControl?.success ? { controlsComplete: actorControl.data.controlsComplete } : {}),
      ...(actorControl?.success && actorControl.data.nativeControl ? { nativeControl: actorControl.data.nativeControl } : {}),
      ...(retry ? { controlRetry: retry } : {}),
      ...(actions.length ? { controlCapability: { version: 1 as const, actions } } : {}) })
  }
  assertLocation()
  return { version: 1 as const, projectID: location.project.id, projectCanonical: location.project.canonical,
    location: { directory: location.directory, ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }) },
    schedules: results }
})
