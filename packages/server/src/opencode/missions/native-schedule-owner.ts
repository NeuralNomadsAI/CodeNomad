import { canonicalAuthority } from "../../missions/authority-protocol"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import { missionDocumentChanges } from "../../missions/mission-document-state"
import { missionCalendarPlans, MISSION_RECONCILIATION_INTERVAL_MS } from "../../missions/mission-calendar-plan"
import { assertMissionCalendarPlacement, captureMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import { missionLaunchLimit, requiresMissionCalendar, missionConfigurationSchema } from "../../missions/launch-policy"
import { stableToken } from "../../missions/receipt-identity"
import { MISSION_SCHEDULE_CARRIER_SESSION_PREFIX } from "../../missions/mission-schedule-carrier-identity"
import type { MissionConfiguration } from "../../missions/launch-policy"
import type { MissionCalendar, MissionDocument, MissionSourceCheckpoint } from "../../missions/mission-document"
import type { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import type { MissionCalendarOwnerSlot, MissionCalendarOwnerState } from "../../missions/mission-calendar-owner-state"
import type { NativeScheduleCarrierInstallation } from "./native-schedule-carrier-binding"
import { assertNativeScheduleCarrierArtifacts } from "./native-schedule-carrier-binding"
import type { NativeScheduleCalendarInfo, NativeScheduleCalendarService } from "./native-schedule-calendar-service"
import { nativeScheduleCalendarMatches as exact } from "./native-schedule-calendar-service"
import type { NativeScheduleWake } from "./native-schedule-transport-contract"
import type { NativeScheduleOwnerBindings } from "./native-schedule-owner-bindings"

export type NativeScheduleOwnerControl = { missionID: string; requestID: string; expectedRevision: number;
  action: "play" | "resume" | "pause" | "stop" | "check" | "configure" | "delete";
  configuration?: MissionConfiguration; checkpoints?: MissionSourceCheckpoint[]; deleteManagedSessions?: boolean }
export type NativeScheduleOwnerOptions = { store: NativeMissionDocumentStore; native: NativeScheduleCalendarService;
  bindings: NativeScheduleOwnerBindings; installation: NativeScheduleCarrierInstallation;
  profileSource: { profileID: string; executionHost: string; configYamlPath: string }; current(): true; now?: () => number;
  resumePending?: (locked: NativeMissionDocumentStore, document: MissionDocument) => Promise<NativeSchedulePendingResumeProof | undefined>;
  sources?: (document: MissionDocument, locked: NativeMissionDocumentStore) => Promise<{ checkpoints: MissionSourceCheckpoint[]; current(): true; revalidate?(): Promise<void> }> }
export type NativeSchedulePendingResumeProof = { passageID: string; messageID: string; coordinatorSessionID: string; current(): true }
const same = (a: unknown, b: unknown) => canonicalAuthority(a) === canonicalAuthority(b)
const target = (doc: MissionDocument, descriptor: MissionCalendarOwnerSlot) => ({ missionID: doc.id, descriptor })
const calendarForSlot = (doc: MissionDocument, slot: MissionCalendarOwnerSlot): MissionCalendar => {
  if (slot.creation !== "adopted" || !slot.scheduleID) throw new Error("Mission calendar mapping lacks adoption")
  const current = doc.calendars.find(item => item.scheduleID === slot.scheduleID || item.sessionID === slot.sessionID)
  if (current) {
    if (current.scheduleID !== slot.scheduleID || current.sessionID !== slot.sessionID || current.timeGeneration !== slot.timeGeneration
      || current.role !== slot.role || current.slot !== slot.slot) throw new Error("Mission calendar mapping differs")
    return current
  }
  return { role: slot.role, slot: slot.slot, timeGeneration: slot.timeGeneration, sessionID: slot.sessionID,
    scheduleID: slot.scheduleID, highWater: 0, pendingWake: null, wakePreparing: null }
}
const publishAuxiliary = (doc: MissionDocument, slot: MissionCalendarOwnerSlot) => {
  if (slot.role !== "reconciliation" || slot.timeGeneration !== doc.timeGeneration) throw new Error("Mission current auxiliary required")
  const calendar = calendarForSlot(doc, slot)
  if (!doc.calendars.includes(calendar)) {
    if (doc.calendars.some(item => item.role === "reconciliation")) throw new Error("Mission auxiliary mapping conflict")
    doc.calendars.push(calendar)
  }
}
class OwnerPending extends Error { constructor(readonly code: NonNullable<MissionCalendarOwnerState["error"]>) { super(code) } }

export function missionCalendarOwnerReady(doc: MissionDocument): boolean {
  const owner = doc.calendarOwner
  return !!owner && !owner.operation.pending && owner.auxiliaryReady && !doc.synchronization && !doc.deletion
    && doc.state === "running" && !doc.blocked && owner.slots.every(slot => slot.creation === "adopted")
    && owner.slots.filter(slot => slot.role === "principal").length === (doc.configuration.launch.timing.kind === "multi" ? doc.configuration.launch.timing.calendars.length : 1)
}
export function nativeScheduleOwnerControlReceipt(doc: MissionDocument, requestID: string) {
  const owner = doc.calendarOwner
  const direct = (id: string) => owner?.receipts.find(item => item.requestID === id)
    ?? (owner?.operation.requestID === id ? owner.operation : undefined)
  const receipt = direct(requestID)
  if (receipt) return receipt
  const check = owner?.checks.find(item => item.requestID === requestID), original = check && direct(check.originalRequestID)
  return check && original ? { ...original, requestID: check.requestID, expectedRevision: check.expectedRevision,
    fingerprint: check.fingerprint, action: "check" as const } : undefined
}

/** Native effect owner. Every public mutation uses one project exclusion and
 * short document CASes around I/O; the caller supplies authenticated authority. */
export class NativeScheduleCalendarOwner {
  constructor(private readonly options: NativeScheduleOwnerOptions) {}
  private now() { return this.options.now?.() ?? Date.now() }
  private async required(locked: NativeMissionDocumentStore, id: string) {
    const doc = await locked.read(id)
    if (!doc || "deletedAt" in doc) throw new Error("Mission calendar document missing")
    return doc
  }
  private slots(doc: MissionDocument, now: number, principalAnchorAt?: number): MissionCalendarOwnerSlot[] {
    if (doc.firstPlayedAt === null) return []
    return missionCalendarPlans(doc, now, principalAnchorAt).map(plan => {
      const token = stableToken(canonicalAuthority([doc.projectID, doc.projectCanonical, doc.id, doc.timeGeneration, plan.role, plan.slot]), 40)
      return { ...plan, timeGeneration: doc.timeGeneration, sessionID: `${MISSION_SCHEDULE_CARRIER_SESSION_PREFIX}${token}`, name: `cm_${token}`,
        creation: "prepared", scheduleID: null, ambiguous: [] }
    })
  }
  control(input: NativeScheduleOwnerControl): Promise<MissionDocument> {
    return this.applyControl(input, true)
  }
  /** Publish the guarded request before its bounded external execution. */
  prepareControl(input: NativeScheduleOwnerControl): Promise<MissionDocument> {
    return this.applyControl(input, false)
  }
  /** Commit interruption intent before actor control. The caller reconciles
   * calendars separately after the original actor interruption is attempted. */
  prepareInterruption(input: NativeScheduleOwnerControl & { action: "pause" | "stop" | "delete" }): Promise<MissionDocument> {
    const intent = { ...input }
    if (!["pause", "stop", "delete"].includes(intent.action)) return Promise.reject(new Error("Mission calendar interruption action required"))
    return this.prepareControl(intent)
  }
  private applyControl(input: NativeScheduleOwnerControl, processAfterCommit: boolean): Promise<MissionDocument> {
    return this.options.store.withExclusion(async locked => {
      let doc = await this.required(locked, input.missionID)
      const fingerprint = stableToken(canonicalAuthority({ action: input.action, configuration: input.configuration ?? null,
        deleteManagedSessions: input.deleteManagedSessions ?? false }), 64)
      const previous = doc.calendarOwner?.operation
      const replay = nativeScheduleOwnerControlReceipt(doc, input.requestID)
      if (replay) {
        if (replay.expectedRevision !== input.expectedRevision || replay.fingerprint !== fingerprint) throw new Error("Mission calendar request conflict")
        return replay.pending && processAfterCommit ? this.process(locked, doc) : doc
      }
      if (doc.revision !== input.expectedRevision) throw new Error("Mission document revision conflict")
      if (input.action === "configure" && doc.firstPlayedAt === null && input.configuration && !requiresMissionCalendar(input.configuration.launch)) {
        const configuration = missionConfigurationSchema.parse(input.configuration), now = this.now()
        return locked.change(doc.id, doc.revision, this.options.current, value => {
          if (value.calendarOwner?.slots.length || value.calendarOwner?.retired.length) throw new Error("Mission calendar cleanup pending")
          missionDocumentChanges.configure(value, configuration, now)
          const operation = { requestID: input.requestID, expectedRevision: input.expectedRevision, fingerprint, action: "configure" as const, pending: false, startedAt: now }
          value.calendarOwner = { version: 1, installation: value.calendarOwner?.installation ?? this.options.installation,
            profileSource: this.options.profileSource, placement: captureMissionCalendarPlacement(configuration.roots), operation,
            receipts: [...value.calendarOwner?.receipts ?? [], operation].slice(-16), checks: value.calendarOwner?.checks ?? [], slots: [], retired: [], auxiliaryReady: false, error: null }
        })
      }
      const convertingOneTime = input.action === "configure" && !!input.configuration && requiresMissionCalendar(input.configuration.launch)
        && !!doc.oneTime && doc.firstPlayedAt === null && !doc.everCreatedTask && !doc.pending && !doc.oneTime.firstPlay
        && !doc.synchronization && !doc.blocked && !doc.deletion && !previous?.pending
      if (!requiresMissionCalendar(input.configuration?.launch ?? doc.configuration.launch) || doc.oneTime && !convertingOneTime) throw new Error("Use immediate Mission control")
      if (previous?.pending && !["pause", "stop", "check", "delete"].includes(input.action)) throw new Error("Mission calendar control uncertain")
      if (input.action === "check" && previous?.pending) {
        doc = await locked.change(doc.id, doc.revision, this.options.current, value => {
          value.calendarOwner!.checks = [...value.calendarOwner!.checks, { requestID: input.requestID,
            expectedRevision: input.expectedRevision, fingerprint, originalRequestID: previous.requestID }].slice(-16)
        })
        return processAfterCommit ? this.process(locked, doc) : doc
      }
      let resumeProof: NativeSchedulePendingResumeProof | undefined
      if (["play", "resume"].includes(input.action) && doc.pending) {
        if (doc.pending.admittedAt === null || doc.blocked === "unknown") throw new Error("Mission pending admission is uncertain")
        resumeProof = await this.options.resumePending?.(locked, doc)
        if (!resumeProof || resumeProof.passageID !== doc.pending.id || resumeProof.messageID !== doc.pending.messageID
          || resumeProof.coordinatorSessionID !== doc.pending.coordinatorSessionID) throw new Error("Mission pending resume proof unavailable")
        assertSynchronousAuthorityGuard(resumeProof.current, "policy-unqualified")
      }
      if (input.action === "configure") missionConfigurationSchema.parse(input.configuration)
      const configuration = input.configuration ? missionConfigurationSchema.parse(input.configuration) : doc.configuration
      const wasPlayed = doc.firstPlayedAt !== null
      if (input.action === "play" || input.action === "resume") {
        assertNativeScheduleCarrierArtifacts(wasPlayed ? doc.calendarOwner?.installation ?? this.options.installation : this.options.installation)
        if (doc.scheduleActivation?.state !== "ready") throw new Error("Mission schedule activation required")
      }
      if (configuration.profileID !== this.options.profileSource.profileID || configuration.executionHost !== this.options.profileSource.executionHost
        || !configuration.roots.some(root => root.directory === this.options.native.directory)) throw new Error("Mission calendar profile/Location differs")
      if (doc.calendarOwner && doc.calendarOwner.installation.registrationFile !== this.options.installation.registrationFile)
        throw new Error("Mission calendar registration namespace differs")
      const placement = wasPlayed && doc.calendarOwner && same(configuration.roots, doc.configuration.roots)
        ? doc.calendarOwner.placement : captureMissionCalendarPlacement(configuration.roots)
      let phase: NativeScheduleCalendarInfo | undefined
      if (input.action === "configure" && wasPlayed && same(configuration.launch.timing, doc.configuration.launch.timing)
        && (configuration.launch.ends.afterMs !== doc.configuration.launch.ends.afterMs || configuration.launch.ends.at !== doc.configuration.launch.ends.at)) {
        const slot = doc.calendarOwner?.slots.find(item => item.role === "principal" && item.when.type === "every")
        if (slot) {
          if (!slot.scheduleID) throw new Error("Mission native phase unavailable")
          const guard = (): true => { locked.assertActive(); this.options.native.assertCurrent(); this.options.current(); return assertMissionCalendarPlacement(placement, configuration.roots) }
          phase = await this.options.native.get(target(doc, slot), slot.scheduleID, guard)
          if (!phase || !exact(phase, slot)) throw new Error("Mission native phase unavailable")
        }
      }
      const now = this.now()
      const interval = configuration.launch.timing.kind === "every" ? configuration.launch.timing.intervalMs : MISSION_RECONCILIATION_INTERVAL_MS
      const phaseDue = phase && (phase.nextDueAt ?? phase.createdAt + interval)
      const principalAnchorAt = phaseDue === undefined ? undefined : phaseDue + Math.max(0, Math.floor((now - phaseDue) / interval) + 1) * interval - interval
      const syncID = `cal_${stableToken(input.requestID, 40)}`
      const needsSources = input.action === "play" && !wasPlayed || input.action === "configure"
        && (!same(configuration.launch.condition, doc.configuration.launch.condition)
          || !same(configuration.watchedConversationIDs, doc.configuration.watchedConversationIDs))
      const sources = needsSources ? await this.options.sources?.({ ...doc, configuration }, locked) : undefined
      if (needsSources && configuration.launch.condition && !sources) throw new Error("Mission condition baseline unavailable")
      doc = await locked.change(doc.id, doc.revision, () => { locked.assertActive(); sources?.current(); if (resumeProof) assertSynchronousAuthorityGuard(resumeProof.current, "policy-unqualified"); return this.options.current() }, value => {
        const old = value.calendarOwner
        if (input.action === "play" && value.firstPlayedAt === null) missionDocumentChanges.play(value, syncID, now, sources?.checkpoints ?? input.checkpoints ?? [])
        else if (["play", "resume"].includes(input.action)) {
          if (value.state === "stopped" || value.state === "finished" && !resumeProof || value.deletion || value.pending && !resumeProof || value.synchronization)
            throw new Error("Mission calendar cannot resume before reconciliation")
          value.state = "running"; value.blocked = null
          const maximum = missionLaunchLimit(value.configuration.launch)
          if (maximum !== null && value.launchedCount >= maximum) value.state = "finished"
        } else if (input.action === "pause") { if (value.state === "stopped" || value.state === "finished" && !value.pending) throw new Error("Mission calendar terminal"); value.state = "paused" }
        else if (input.action === "stop") value.state = "stopped"
        else if (input.action === "delete") missionDocumentChanges.requestDeletion(value, input.requestID, now,
          { expectedRevision: input.expectedRevision, deleteManagedSessions: input.deleteManagedSessions ?? false })
        else if (input.action === "configure") { if (convertingOneTime) value.oneTime = null; missionDocumentChanges.configure(value, input.configuration!, now, sources?.checkpoints) }
        if (["pause", "stop", "delete"].includes(input.action) && value.pending) value.pending.manualAllowed = false
        if (value.state !== "running" && value.fanIn && !value.fanIn.completed) value.fanIn.suppress = true
        const replaced = old && old.slots.some(slot => slot.timeGeneration !== value.timeGeneration)
        if (replaced && old.retired.length) throw new Error("Mission previous calendar cleanup pending")
        const retired = replaced ? old.slots.map(descriptor => ({ descriptor, highWater: value.synchronization?.retiredCalendars.find(item => item.scheduleID === descriptor.scheduleID)?.highWater ?? 0,
          scheduleRemoved: false, sessionRemoved: false, indexRemoved: false })) : old?.retired ?? []
        value.calendarOwner = { version: 1, installation: wasPlayed ? old?.installation ?? this.options.installation : this.options.installation,
          profileSource: !wasPlayed || input.action === "configure" ? this.options.profileSource : old?.profileSource ?? this.options.profileSource, placement,
          operation: { requestID: input.requestID, expectedRevision: input.expectedRevision, fingerprint,
            action: input.action, pending: true, startedAt: now }, receipts: old?.receipts ?? [], checks: old?.checks ?? [],
           slots: !old || replaced || !wasPlayed ? this.slots(value, now, principalAnchorAt) : old.slots, retired, auxiliaryReady: replaced ? false : old?.auxiliaryReady ?? false, error: null }
       }, sources?.revalidate)
      return processAfterCommit ? this.process(locked, doc) : doc
    })
  }
  reconcile(missionID: string): Promise<MissionDocument> {
    return this.options.store.withExclusion(async locked => {
      let doc = await this.required(locked, missionID)
      if (!doc.calendarOwner) return doc
      if (!doc.calendarOwner.operation.pending) doc = await locked.change(doc.id, doc.revision, this.options.current, value => {
        value.calendarOwner!.operation = { requestID: `reconcile_${doc.revision}`, expectedRevision: doc.revision,
          fingerprint: stableToken(canonicalAuthority([doc.state, doc.blocked, doc.launchedCount, doc.pending?.id ?? null]), 64), action: "reconcile", pending: true, startedAt: this.now() }
      })
      return this.process(locked, doc)
    })
  }
  /** Recover only an existing current auxiliary row, before its claimed technical
   * wake is consumed. Never creates a carrier/calendar or processes principals. */
  adoptAuxiliary(wake: NativeScheduleWake): Promise<MissionDocument> {
    return this.options.store.withExclusion(async locked => {
      let doc: MissionDocument | undefined
      const guard = (): true => {
        locked.assertActive(); this.options.native.assertCurrent(); assertSynchronousAuthorityGuard(this.options.current, "policy-unqualified")
        if (doc) return assertMissionCalendarPlacement(doc.calendarOwner!.placement, doc.configuration.roots)
        return true
      }
      const binding = await this.options.bindings.readAuxiliaryWake(wake, this.options.native, guard)
      if (!binding) throw new Error("Mission auxiliary adoption unqualified")
      doc = await this.required(locked, wake.missionID)
      if (doc.revision !== binding.document.revision) throw new Error("Mission auxiliary adoption changed")
      assertMissionCalendarPlacement(doc.calendarOwner!.placement, doc.configuration.roots)
      return locked.change(doc.id, doc.revision, guard, value => {
        const slot = value.calendarOwner!.slots.find(item => item.sessionID === wake.sessionID)!
        slot.creation = "adopted"; slot.scheduleID = wake.scheduleID; slot.ambiguous = []
        publishAuxiliary(value, slot)
      })
    })
  }
  private async process(locked: NativeMissionDocumentStore, initial: MissionDocument): Promise<MissionDocument> {
    let doc = initial
    const native = this.options.native
    const guard = (): true => {
      locked.assertActive(); native.assertCurrent(); assertSynchronousAuthorityGuard(this.options.current, "policy-unqualified")
      if (!doc.calendarOwner) throw new Error("Mission calendar owner missing")
      if (doc.state === "running" && !doc.blocked) assertNativeScheduleCarrierArtifacts(doc.calendarOwner.installation)
      return assertMissionCalendarPlacement(doc.calendarOwner.placement, doc.configuration.roots)
    }
    const change = async (update: (value: MissionDocument) => void) => { doc = await locked.change(doc.id, doc.revision, guard, update) }
    const owner = () => doc.calendarOwner!
    const updateSlot = async (index: number, update: (slot: MissionCalendarOwnerSlot) => void) => change(value => update(value.calendarOwner!.slots[index]))
    const ensure = async (index: number) => {
      let slot = owner().slots[index]
      await this.options.bindings.register(locked, doc.id, slot, guard)
      await native.ensureCarrier(target(doc, slot), guard)
      let info: NativeScheduleCalendarInfo | undefined
      if (slot.creation === "adopted") {
        info = await native.get(target(doc, slot), slot.scheduleID!, guard)
        if (!info || !exact(info, slot)) throw new OwnerPending("native-uncertain")
      } else {
        const list = await native.list(target(doc, slot), guard), matches = list.filter(item => exact(item, slot))
        if (list.length !== matches.length) throw new OwnerPending("native-uncertain")
        if (matches.length > 1) {
          await updateSlot(index, value => { value.ambiguous = matches.map(item => item.id) })
          for (const value of matches) if (value.status === "active") await native.pause(target(doc, slot), value.id, guard)
          throw new OwnerPending("ambiguous-create")
        }
        info = matches[0]
        if (!info) {
          if (slot.creation === "attempted") throw new OwnerPending("native-uncertain")
          await updateSlot(index, value => { value.creation = "attempted" })
          slot = owner().slots[index]
          info = await native.create(target(doc, slot), guard)
        }
        if (!exact(info, slot)) throw new OwnerPending("native-uncertain")
        const id = info.id
        await updateSlot(index, value => { value.creation = "adopted"; value.scheduleID = id; value.ambiguous = [] })
      }
      if (owner().slots[index].role === "reconciliation") await change(value => publishAuxiliary(value, value.calendarOwner!.slots[index]))
      return info
    }
    const running = () => doc.state === "running" && !doc.blocked && (missionLaunchLimit(doc.configuration.launch) === null
      || doc.launchedCount < missionLaunchLimit(doc.configuration.launch)!)
    const unresolved = () => !!doc.pending || !!doc.fanIn && !doc.fanIn.completed
      || [...doc.calendars, ...(doc.synchronization?.retiredCalendars ?? [])].some(item => item.pendingWake || item.wakePreparing)
    const resumeAuxiliary = async () => {
      const index = owner().slots.findIndex(slot => slot.role === "reconciliation")
      if (index < 0) throw new OwnerPending("cleanup-pending")
      const info = await ensure(index), slot = owner().slots[index]
      const fresh = info.status === "paused" ? await native.resume(target(doc, slot), info.id, guard) : info
      if (fresh.status !== "active") throw new OwnerPending("native-uncertain")
      if (!owner().auxiliaryReady) await change(value => { value.calendarOwner!.auxiliaryReady = true })
    }
    try {
      guard()
      if (doc.deletion) await locked.reserveDeletion(doc.id, doc.revision, guard)
      // Temporal replacement creates its new observation carrier first; retired
      // principals remain frozen until preparations and claims reconcile.
      if (running()) await resumeAuxiliary()
      if (!running() && (["stopped", "finished"].includes(doc.state) || doc.deletion)) {
        const preparations = doc.calendars.filter(calendar => calendar.wakePreparing).map(calendar => {
          const descriptor = owner().slots.find(slot => slot.sessionID === calendar.sessionID && slot.scheduleID === calendar.scheduleID
            && slot.timeGeneration === doc.timeGeneration && slot.role === calendar.role && slot.slot === calendar.slot && slot.creation === "adopted")
          if (!descriptor) throw new OwnerPending("wake-unresolved")
          return { descriptor, wake: calendar.wakePreparing! }
        })
        for (const { descriptor, wake } of preparations) {
          const info = await native.get(target(doc, descriptor), wake.scheduleID, guard)
          if (!info) throw new OwnerPending("wake-unresolved")
          if (descriptor.role === "principal" && info.status === "active") await native.pause(target(doc, descriptor), info.id, guard)
          if (!await native.wakeAcknowledged(target(doc, descriptor), wake, guard)) throw new OwnerPending("wake-unresolved")
        }
        // Recheck the whole prepared group before its one technical CAS. Unknown
        // or still-in-flight admission keeps every original preparation intact.
        for (const { descriptor, wake } of preparations)
          if (!await native.wakeAcknowledged(target(doc, descriptor), wake, guard)) throw new OwnerPending("wake-unresolved")
        if (preparations.length) {
          await change(value => { for (const { wake } of preparations) missionDocumentChanges.processWake(value, wake) })
          if (!await this.options.bindings.close(locked, doc.id, guard)) throw new OwnerPending("claim-held")
        }
      }
      for (const old of owner().retired) {
        const descriptor = old.descriptor
        if (descriptor.scheduleID && !old.scheduleRemoved) {
          const info = await native.get(target(doc, descriptor), descriptor.scheduleID, guard)
          if (descriptor.role === "principal" && info?.status === "active") await native.pause(target(doc, descriptor), info.id, guard)
        }
        const preparation = doc.synchronization?.retiredCalendars.find(item => item.sessionID === descriptor.sessionID)?.wakePreparing
        if (preparation) {
          if (!await native.wakeAcknowledged(target(doc, descriptor), preparation, guard)) throw new OwnerPending("wake-unresolved")
          await change(value => {
            const calendar = value.synchronization!.retiredCalendars.find(item => item.sessionID === descriptor.sessionID)!
            calendar.highWater = preparation.run; calendar.wakePreparing = null
          })
        }
      }
      if (owner().retired.length && !await this.options.bindings.close(locked, doc.id, guard)) throw new OwnerPending("claim-held")
      for (let index = 0; index < owner().retired.length; index++) {
        let retired = owner().retired[index]
        if (retired.descriptor.role === "reconciliation" && !retired.scheduleRemoved
          && !await native.carrierQuiet(target(doc, retired.descriptor), guard)) throw new OwnerPending("cleanup-pending")
        if (retired.descriptor.scheduleID && !retired.scheduleRemoved) {
          await native.remove(target(doc, retired.descriptor), retired.descriptor.scheduleID, guard)
          await change(value => { value.calendarOwner!.retired[index].scheduleRemoved = true })
        }
        retired = owner().retired[index]
        if (!retired.sessionRemoved) {
          await native.removeCarrier(target(doc, retired.descriptor), guard)
          await change(value => { value.calendarOwner!.retired[index].sessionRemoved = true })
        }
        retired = owner().retired[index]
        if (!retired.indexRemoved) {
          await this.options.bindings.remove(locked, doc.id, retired.descriptor, guard)
          await change(value => { value.calendarOwner!.retired[index].indexRemoved = true })
        }
      }
      if (running()) {
        const principalInfos: NativeScheduleCalendarInfo[] = []
        for (let index = 0; index < owner().slots.length; index++) if (owner().slots[index].role === "principal") {
          if (!owner().auxiliaryReady) throw new OwnerPending("native-uncertain")
          const info = await ensure(index)
          principalInfos.push(info)
          if (info.status === "paused") await native.resume(target(doc, owner().slots[index]), info.id, guard)
        }
        if (doc.synchronization) await change(value => {
          const calendars = value.calendarOwner!.slots.map(slot => calendarForSlot(value, slot))
          missionDocumentChanges.synchronized(value, value.synchronization!.requestID, calendars)
        })
        if (principalInfos.length && principalInfos.every(info => info.status === "done" && doc.calendars.some(item =>
          item.scheduleID === info.id && item.highWater >= info.runCount)) && !unresolved()
          && await this.options.bindings.close(locked, doc.id, guard)) {
          await change(value => { value.state = "finished" })
          return this.process(locked, doc)
        }
      } else {
         const terminal = ["stopped", "finished"].includes(doc.state) || !!doc.deletion
         if (doc.state === "paused" && doc.synchronization && !doc.deletion) {
           for (let index = 0; index < owner().slots.length; index++) {
             const info = await ensure(index)
             if (info.status === "active") await native.pause(target(doc, owner().slots[index]), info.id, guard)
           }
           await change(value => {
              const calendars = value.calendarOwner!.slots.map(slot => calendarForSlot(value, slot))
             missionDocumentChanges.synchronized(value, value.synchronization!.requestID, calendars)
             value.calendarOwner!.auxiliaryReady = false
           })
         }
        const closed = await this.options.bindings.close(locked, doc.id, guard)
        for (let index = 0; index < owner().slots.length; index++) {
          const slot = owner().slots[index]
          if (slot.creation !== "adopted") {
            if (slot.creation === "attempted") await ensure(index)
            else continue
          }
          const fresh = owner().slots[index]
          const keep = fresh.role === "reconciliation" && (unresolved() || !closed)
          const info = await native.get(target(doc, fresh), fresh.scheduleID!, guard)
          if (!info) throw new OwnerPending("native-uncertain")
          if (keep && info.status === "paused") await native.resume(target(doc, fresh), info.id, guard)
          else if (!keep && info.status === "active") await native.pause(target(doc, fresh), info.id, guard)
        }
        if (!closed) throw new OwnerPending("claim-held")
        if (terminal && !unresolved()) {
          if (owner().slots.length) {
            await change(value => {
              value.calendarOwner!.retired = value.calendarOwner!.slots.map(descriptor => ({ descriptor,
                highWater: value.calendars.find(item => item.scheduleID === descriptor.scheduleID)?.highWater ?? 0,
                scheduleRemoved: descriptor.creation === "prepared", sessionRemoved: false, indexRemoved: false }))
              value.calendarOwner!.slots = []
            })
            return this.process(locked, doc)
          }
          await change(value => { value.calendars = []; value.synchronization = null })
        }
      }
      await change(value => {
        const state = value.calendarOwner!
        state.retired = []; state.operation.pending = false; state.error = null
        if (state.operation.action !== "reconcile" && !state.receipts.some(item => item.requestID === state.operation.requestID))
          state.receipts = [...state.receipts, { ...state.operation }].slice(-16)
      })
      return doc
    } catch (error) {
      // An admitted create attempt remains attempted. Rereads can adopt its exact
      // candidate, while missing evidence never authorizes a second create.
      const code = error instanceof OwnerPending ? error.code : "native-uncertain"
      // Retain an existing observation wake while cleanup is blocked by a live
      // technical carrier/child; an after-idle caller can finish the same intent.
      const auxiliary = owner().slots.find(item => item.role === "reconciliation")
        ?? owner().retired.find(item => item.descriptor.role === "reconciliation" && !item.scheduleRemoved)?.descriptor
      if (auxiliary?.scheduleID) try {
        const info = await native.get(target(doc, auxiliary), auxiliary.scheduleID, guard)
        if (info?.status === "paused") await native.resume(target(doc, auxiliary), auxiliary.scheduleID, guard)
      } catch {}
      try { await change(value => { value.calendarOwner!.error = code }) } catch {}
      return doc
    }
  }
}
