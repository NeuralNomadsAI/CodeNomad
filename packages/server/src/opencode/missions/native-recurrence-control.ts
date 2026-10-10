import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Schema } from "effect"
import { verifyRecurrenceBridge } from "../automation-plugin"
import { assertRecurrenceProofFresh, recurrenceControlRequestDigest } from "../../missions/recurrence-control-proof"
import { recurrenceControlRequestSchema } from "../../missions/recurrence-control-contract"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { cancelNativeRecurrenceClock, observeNativeRecurrenceScheduleOnly, readNativeRecurrenceClock, startNativeRecurrenceClock } from "./native-service-clock"
import { nativeRecurrenceDue } from "./native-recurrence-due"
import { startNativeRecurrenceSettlement } from "./native-recurrence-settle-job"
import { qualifyNativeRecurrenceControl } from "./native-recurrence-capability"
import { interruptRecurrenceActors } from "./native-recurrence-actor-controls"
import { createFamilyAuthorityIdentityFence, readFamilyAuthorityPlacement } from "../../workspaces/family-authority-claim"
import { physical } from "../../missions/physical-path"
import { realpathSync } from "node:fs"

const locationTag = Context.Service<never, Location.Info>("@opencode/Location")
export const nativeRecurrenceControlInputSchema = Schema.Struct({ sessionID: Schema.String, workspaceID: Schema.String, requestID: Schema.String,
  location: Schema.Struct({ directory: Schema.String, workspaceID: Schema.optional(Schema.String) }),
  digest: Schema.String, scheduleID: Schema.String, expectedRevision: Schema.Number,
  action: Schema.Literals(["play", "pause", "stop", "resume", "run-now", "check", "create"]), retry: Schema.optional(Schema.Boolean),
  configDigest: Schema.optional(Schema.String),
  profileSource: Schema.Struct({ profileID: Schema.String, executionHost: Schema.String, configYamlPath: Schema.String }),
  issuedAt: Schema.Number, proof: Schema.String })
export type NativeRecurrenceControlInput = typeof nativeRecurrenceControlInputSchema.Type

/** Transport authentication only. It does not mint a grant or authorize a model tool. */
export async function assertRecurrenceBridgeProof(input: NativeRecurrenceControlInput) {
  const { proof, retry: _retry, ...body } = input
  assertRecurrenceProofFresh(input.issuedAt)
  if (!/^[a-f0-9]{64}$/.test(proof) || input.sessionID === "auth-disabled" || !input.sessionID
    || input.sessionID.length > 256 || !input.workspaceID || input.workspaceID.length > 200
    || input.digest !== recurrenceControlRequestDigest((({ digest: _digest, ...identity }) => identity)(body))
    || !await verifyRecurrenceBridge(body, proof)) throw new Error("Recurrence transport authentication failed")
  assertRecurrenceProofFresh(input.issuedAt)
}

export const controlNativeRecurrence = Effect.fn("missions.controlNativeRecurrence")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location" | "session">, raw: unknown,
) {
  const input = yield* Schema.decodeUnknownEffect(nativeRecurrenceControlInputSchema)(raw)
  const request = recurrenceControlRequestSchema.parse({ scheduleID: input.scheduleID, requestID: input.requestID,
    action: input.action, expectedRevision: input.expectedRevision })
  if (input.action === "run-now" || input.action === "create") throw new Error("Use the dedicated recurrence method")
  yield* Effect.tryPromise(() => assertRecurrenceBridgeProof(input))
  yield* qualifyNativeRecurrenceControl()
  const location = yield* locationTag
  if (location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
    || location.project.id !== ctx.location.project.id || location.project.canonical !== ctx.location.project.canonical
    || input.location.directory !== location.directory || input.location.workspaceID !== location.workspaceID) throw new Error("Recurrence Location changed")
  const store = yield* acquireNativeRecurrenceStore(ctx)
  const before = yield* Effect.promise(() => store.read(input.scheduleID))
  if (!before || before.config.roots.length !== 1 || before.config.roots[0].directory !== location.directory) throw new Error("Recurrence scope changed")
  const root = before.config.roots[0]
  if (root.mode !== "git") throw new Error("Recurrence physical root changed")
  // Resolve with Git once, asynchronously; every synchronous CAS guard then rereads
  // the captured routing inputs and falls back to Git only when they changed.
  // A per-guard spawnSync timed out on loaded hosts as policy-unqualified.
  const family = yield* Effect.promise(() => createFamilyAuthorityIdentityFence(root.directory))
  const actual = yield* Effect.tryPromise({ try: () => readFamilyAuthorityPlacement(root.directory), catch: error => error })
  if (actual.checkout !== root.checkout || actual.family !== root.family) throw new Error("Recurrence physical root changed")
  const physicalCurrent = (): true => {
    if (family() !== root.family || physical(realpathSync(root.family)) !== root.family) throw new Error("Recurrence physical root changed")
    return true
  }
  physicalCurrent()
  const placement = { projectID: location.project.id, projectCanonical: location.project.canonical,
    directory: location.directory, workspaceID: location.workspaceID, scheduleID: input.scheduleID,
    profileID: before.config.profileID, executionHost: before.config.executionHost }
  const previous = before.controls.find(item => item.requestID === input.requestID)
  const current = (): true => { assertRecurrenceProofFresh(input.issuedAt); return physicalCurrent() }
  if (!previous && input.action === "resume" && before.state === "running"
    && (yield* readNativeRecurrenceClock(placement)) !== false) throw new Error("Recurrence is not interrupted")
  const document = yield* Effect.promise(() => store.beginControl(input.scheduleID, request, current, input.profileSource))
  let record = document.controls.find(item => item.requestID === input.requestID)!
  const response = () => ({ version: 1 as const, scheduleID: input.scheduleID, ...record })
  if (record.controlsComplete || previous && !(input.retry && (input.action === "pause" || input.action === "stop"))) return response()
  if (input.action === "play" || input.action === "resume") {
    // One Job per running schedule: the daily Job also settles a pending passage,
    // so a paused Run now's settlement-only observer is retired, not kept beside it.
    yield* cancelNativeRecurrenceClock(placement, "settle").pipe(Effect.catchCause(() => Effect.void))
    yield* startNativeRecurrenceClock(placement, nativeRecurrenceDue(ctx, { ...placement,
      profileSource: document.profileSource }), ctx)
    const single = yield* observeNativeRecurrenceScheduleOnly(placement).pipe(Effect.catchCause(() => Effect.succeed(false)))
    record = { ...record, controlsComplete: single, targetsKnown: true }
  } else if (input.action === "check") {
    // Reconcile-only: restarts settlement observation, never daily scheduling.
    yield* startNativeRecurrenceSettlement(ctx, placement, document)
    record = { ...record, controlsComplete: true, targetsKnown: true }
  } else {
    let cancelled = false
    yield* cancelNativeRecurrenceClock(placement, "settle").pipe(Effect.catchCause(() => Effect.void))
    yield* cancelNativeRecurrenceClock(placement).pipe(Effect.flatMap(() => readNativeRecurrenceClock(placement)),
      Effect.tap(value => Effect.sync(() => { cancelled = value === false })), Effect.catchCause(() => Effect.void))
    const actors = yield* Effect.scoped(interruptRecurrenceActors(ctx, { scheduleID: input.scheduleID, requestID: input.requestID,
      action: input.action, record })).pipe(Effect.catchCause(() => Effect.succeed(record)))
    record = { ...actors, schedulerCancellation: cancelled ? "acknowledged" : "unknown",
      controlsComplete: cancelled && actors.targetsKnown && actors.targets.every(target => target.outcome === "acknowledged") }
    // Stop is terminal for scheduling, not for honest observation: keep a settlement-only
    // observer until the pending passage archives, then it exits. Pause keeps it cancelled.
    const stopped = input.action === "stop" ? yield* Effect.promise(() => store.read(input.scheduleID)) : undefined
    if (stopped?.state === "stopped" && stopped.pending)
      yield* startNativeRecurrenceSettlement(ctx, placement, stopped).pipe(Effect.catchCause(() => Effect.void))
  }
  yield* Effect.promise(() => store.recordControl(input.scheduleID, record, () => true))
  return response()
})
