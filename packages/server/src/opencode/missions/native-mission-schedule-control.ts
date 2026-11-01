import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { missionSchedulePayloadDigest } from "../../missions/mission-schedule-contract"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { requiresMissionCalendar } from "../../missions/launch-policy"
import { captureMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import { stableToken } from "../../missions/receipt-identity"
import { acquireNativeMissionScheduleAuthority } from "./native-mission-schedule-authority"
import { acquireNativeMissionScheduleOwner } from "./native-mission-schedule-owner"
import { acquireNativeScheduleInstallation, acquireNativeMissionServiceRegistration, type NativeScheduleArtifacts } from "./native-schedule-installation"
import { acquireNativeScheduledActorTransport, scheduledActorCalendarBarrier } from "./native-mission-schedule-actors"
import { acquireNativeScheduledPassageRuntime } from "./native-scheduled-passage-runtime"
import { nativeImmediatePlayPassage, nativeMissionScheduleResult } from "./native-mission-schedule-result"
import { immediateMissionControlReceipts, prepareNativeImmediateMissionControl } from "./native-mission-schedule-immediate"
import { NativeScheduleControlRefusal, nativeScheduleOwnerControlReceipt, type NativeScheduleOwnerControl } from "./native-schedule-owner"
import { finishMissionDocumentDeletion } from "../../missions/mission-document-deletion"
import type { MissionNativeRunner } from "./native-service-adapter"
import { configureNativeMissionPreparation } from "./native-mission-preparation"
import { deleteDormantMissionJournal } from "../../missions/mission-dormant-journal"

type Authority = Effect.Success<ReturnType<typeof acquireNativeMissionScheduleAuthority>>

export const controlNativeMissionSchedule = Effect.fn("missions.controlSchedule")(function* (
  ctx: Plugin.Context, authority: Authority, artifacts: NativeScheduleArtifacts | undefined, run: MissionNativeRunner,
) {
  const { request, store, current, profileSource, admitControl, signal } = authority
  const { missionID, requestID, expectedRevision, action } = request
  current()
  if (action === "create") {
    if (!requiresMissionCalendar(request.configuration!.launch)) throw new Error("Use immediate Mission creation")
    const creation = { requestID, digest: missionSchedulePayloadDigest(request) }
    const created = yield* Effect.tryPromise(() => store.withExclusion(async locked => {
      const before = await locked.read(missionID)
      if (before) {
        if ("deletedAt" in before || canonicalAuthority(before.creation) !== canonicalAuthority(creation))
          throw new Error("Mission schedule creation request conflict")
        return before
      }
      return locked.create(missionID, request.configuration!, Date.now(), current, null, creation)
    }))
    return yield* Effect.promise(() => nativeMissionScheduleResult(ctx, created, run, false, requestID))
  }
  let doc = yield* Effect.promise(() => store.read(missionID))
  if (!doc) throw new Error("Mission schedule unavailable")
  if ("deletedAt" in doc) {
    if (action !== "delete" || doc.requestID !== requestID || doc.expectedRevision !== expectedRevision
      || doc.deleteManagedSessions !== (request.deleteManagedSessions ?? false)) throw new Error("Mission deletion request conflict")
    return yield* Effect.promise(() => nativeMissionScheduleResult(ctx, doc, run, false, requestID))
  }
  // The prepared journal and its coordinator share this object's identity.
  // Calendar-only configuration cannot publish their preparation atomically.
  if (action === "configure" && doc.oneTime && (doc.firstPlayedAt === null || doc.preparation?.requestID === requestID)) {
    doc = yield* configureNativeMissionPreparation(ctx, store, { missionID, requestID, expectedRevision, configuration: request.configuration! }, current, run, admitControl)
    admitControl(doc)
    return yield* Effect.promise(() => nativeMissionScheduleResult(ctx, doc, run, false, requestID))
  }
  if (action === "run-now" && doc.firstPlayedAt === null) throw new Error("Mission requires first Play")
  const entry = { current, signal, missionID }
  if (action === "configure" && request.configuration && !requiresMissionCalendar(request.configuration.launch)
    && (doc.firstPlayedAt === null || !requiresMissionCalendar(doc.configuration.launch))) {
    const fingerprint = stableToken(canonicalAuthority({ action, configuration: request.configuration, deleteManagedSessions: false }), 64)
    const replay = nativeScheduleOwnerControlReceipt(doc, requestID)
    if (replay) {
      if (replay.expectedRevision !== expectedRevision || replay.fingerprint !== fingerprint || replay.pending) throw new Error("Mission control request conflict")
      admitControl(doc)
      return yield* Effect.promise(() => nativeMissionScheduleResult(ctx, doc, run, false, requestID))
    }
    if (doc.calendars.length || doc.calendarOwner?.slots.length || doc.calendarOwner?.retired.length
      || doc.calendarOwner?.operation.pending || doc.synchronization || doc.deletion || doc.blocked)
      throw new Error("Mission calendar reconciliation pending")
    const registration = yield* acquireNativeMissionServiceRegistration()
    const descriptors = artifacts ?? doc.calendarOwner?.installation
    if (!descriptors) throw new Error("Mission runtime descriptor unavailable")
    const installation = { registrationFile: registration.registrationFile, provider: { ...descriptors.provider }, runtime: { ...descriptors.runtime } }
    const prepared = doc, configuration = request.configuration
    doc = yield* Effect.tryPromise(() => store.change(missionID, expectedRevision, () => { registration.assertCurrent(); return current() }, value => {
      changes.configure(value, configuration, Date.now())
      const operation = { requestID, expectedRevision, fingerprint, action: "configure" as const, pending: false, startedAt: Date.now() }
      value.calendarOwner = { version: 1, installation: value.firstPlayedAt === null ? installation : prepared.calendarOwner!.installation,
        profileSource: value.firstPlayedAt === null ? profileSource : prepared.calendarOwner!.profileSource,
        placement: value.firstPlayedAt === null ? captureMissionCalendarPlacement(value.configuration.roots) : prepared.calendarOwner!.placement,
        operation, receipts: immediateMissionControlReceipts(value, operation), checks: value.calendarOwner?.checks ?? [],
        slots: [], retired: [], auxiliaryReady: false, error: null }
    }))
    admitControl(doc)
    return yield* Effect.promise(() => nativeMissionScheduleResult(ctx, doc, run, false, requestID))
  }
  if (!requiresMissionCalendar(doc.configuration.launch) && action !== "configure") {
    // The ordinary immediate path owns documents with a one-time journal binding.
    if (doc.oneTime && !doc.dormantJournal || !doc.calendarOwner) throw new Error("Use immediate Mission control")
    doc = yield* Effect.tryPromise(() => prepareNativeImmediateMissionControl(store, request, current))
    admitControl(doc)
    const immediate = doc
    const lifecycle = yield* acquireNativeScheduledActorTransport(ctx, immediate.calendarOwner!.installation, run, current)
    const runtime = yield* acquireNativeScheduledPassageRuntime(ctx, run, { lifecycle })
    const pending = yield* Effect.promise(async () => {
      if (["pause", "stop", "resume", "play"].includes(action) && !(action === "play" && nativeImmediatePlayPassage(immediate, requestID)) && immediate.pending?.admittedAt !== null
        && immediate.pending) {
        try {
          const result = await runtime.controlPassage({ ...entry, requestID, action: action === "pause" ? "pause" : action === "stop" ? "stop" : "start" })
          if (result.pending) return true
        } catch { return true }
      }
      await runtime.reconcile(entry)
      return false
    })
    return yield* Effect.promise(async () => nativeMissionScheduleResult(ctx, await store.read(missionID), run, pending, requestID))
  }
  let installation = doc.calendarOwner?.installation
  if (!installation) {
    if (!artifacts) throw new Error("Mission schedule artifacts unavailable")
    const acquired = yield* acquireNativeScheduleInstallation(artifacts)
    acquired.assertCurrent()
    installation = acquired.installation
  }
  const { owner } = yield* acquireNativeMissionScheduleOwner(ctx, doc, run, current, installation, profileSource)
  const prepare = (input: NativeScheduleOwnerControl) => owner.prepareControl(input).catch(error => {
    if (error instanceof NativeScheduleControlRefusal) return error
    throw error
  })
  const interruption = action === "pause" || action === "stop" || action === "delete"
  if (interruption) {
    const prepared = yield* Effect.tryPromise(() => prepare({ missionID, requestID, expectedRevision,
      action, deleteManagedSessions: request.deleteManagedSessions }))
    if (prepared instanceof NativeScheduleControlRefusal) return { document: null, pending: false, refusal: prepared.refusal }
    doc = prepared
  }
  if (interruption) admitControl(doc)
  // A durable interruption closes admission before either external branch. Actor
  // capability failure must still let the calendar owner attempt its own cleanup.
  const lifecycle = yield* acquireNativeScheduledActorTransport(ctx, installation, run, current).pipe(Effect.catchCause(cause =>
    interruption ? Effect.succeed(undefined) : Effect.failCause(cause)))
  const runtime = yield* acquireNativeScheduledPassageRuntime(ctx, run, { lifecycle }).pipe(Effect.catchCause(cause =>
    interruption ? Effect.succeed(undefined) : Effect.failCause(cause)))
  let actorPending = false
  if (action === "run-now") {
    yield* Effect.tryPromise(() => runtime!.runNow({ ...entry, requestID, expectedRevision, reserved: admitControl }))
    // Paused calendars stay paused while the reservation makes its auxiliary
    // necessary. Reconcile that observer, then admit only the reserved original.
    yield* Effect.tryPromise(() => owner.reconcile(missionID))
    yield* Effect.tryPromise(() => runtime!.reconcile(entry))
  }
  else {
    if (!interruption) {
      const prepared = yield* Effect.tryPromise(() => prepare({ missionID, requestID, expectedRevision,
        action, configuration: request.configuration, deleteManagedSessions: request.deleteManagedSessions }))
      if (prepared instanceof NativeScheduleControlRefusal) return { document: null, pending: false, refusal: prepared.refusal }
      doc = prepared
      admitControl(doc)
      doc = yield* Effect.tryPromise(() => owner.reconcile(missionID))
    }
    const checkedOriginal = action === "check" && doc.calendarOwner?.checks.find(item => item.requestID === requestID)?.originalRequestID
    const actorControl = checkedOriginal ? nativeScheduleOwnerControlReceipt(doc, checkedOriginal)
      : action === "check" ? [...doc.calendarOwner?.receipts ?? []].reverse().find(item => ["pause", "stop", "resume", "play"].includes(item.action))
      : nativeScheduleOwnerControlReceipt(doc, requestID)
    const actorAction = actorControl?.action === "pause" ? "pause" : actorControl && ["stop", "delete"].includes(actorControl.action) ? "stop" : "start"
    if (actorControl && doc.pending && doc.calendarOwner && scheduledActorCalendarBarrier(doc.calendarOwner, actorControl.requestID, actorAction)) {
      actorPending = !runtime || !lifecycle || (yield* Effect.tryPromise(async () => {
        try { return (await runtime.controlPassage({ ...entry, requestID: actorControl.requestID, action: actorAction })).pending }
        catch { return true }
      }))
    }
    if (interruption) yield* Effect.tryPromise(() => owner.reconcile(missionID))
    if (runtime && ["check", "pause", "stop", "resume", "delete"].includes(action)) yield* Effect.tryPromise(() => runtime.reconcile(entry))
    else if (!runtime && doc.pending) actorPending = true
  }
  // Re-evaluate the quota after admission/settlement, preserving mapping proofs.
  yield* Effect.tryPromise(() => owner.reconcile(missionID))
  if (action === "delete" || action === "check") {
    const deleting = yield* Effect.promise(() => store.read(missionID))
    if (deleting && !("deletedAt" in deleting) && deleting.deletion) {
      const deletion = deleting.deletion
      const managedCleanup = deletion.deleteManagedSessions && deleting.launchedCount > 0
      if (managedCleanup) actorPending = true
      else if (!actorPending && !deleting.pending && !deleting.calendarOwner?.operation.pending
        && !deleting.calendarOwner?.slots.length && !deleting.calendarOwner?.retired.length) {
        yield* Effect.tryPromise(() => store.withExclusion(async locked => {
          await deleteDormantMissionJournal(locked, { get: key => run(ctx.storage.get(key)), scan: input => run(ctx.storage.scan(input)),
            set: async (key, value, guard) => { current(); guard?.(); await run(ctx.storage.set(key, value)) } }, deleting, current)
          await finishMissionDocumentDeletion(use => use(locked), use => use(locked),
            { missionID, ...deletion }, Date.now(), current, true)
        }))
      }
    }
  }
  return yield* Effect.promise(async () => nativeMissionScheduleResult(ctx, await store.read(missionID), run, actorPending, requestID))
})
