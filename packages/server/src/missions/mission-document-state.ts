import { canonicalAuthority } from "./authority-protocol"
import { stableToken } from "./receipt-identity"
import { missionCoordinatorSessionID } from "./session-identity"
import { documentID, documentTimestamp, missionConfigurationSchema, missionEventPrincipal, missionEventPrincipalSlot, missionLaunchLimit, missionLaunchModel,
  missionPrincipalCount, missionSlotEndsAt, requiresMissionCalendar, type MissionCondition, type MissionConfiguration } from "./launch-policy"
import { missionCheckpointsSchema, missionDocumentPassageID, missionSourceKey, missionWakeSchema, projectMissionDocument,
  type MissionCalendar, type MissionDocument, type MissionDocumentPending, type MissionSourceCheckpoint, type MissionWake } from "./mission-document"
import { missionDocumentDeletionIdentitySchema } from "./mission-document"

const same = (a: unknown, b: unknown) => canonicalAuthority(a) === canonicalAuthority(b)
function available(doc: MissionDocument) {
  if (doc.deletion || doc.preparation?.pending || doc.synchronization || doc.calendarOwner?.operation.pending || doc.blocked || doc.state !== "running") throw new Error("Mission admission blocked")
  const limit = missionLaunchLimit(doc.configuration.launch)
  if (limit !== null && doc.launchedCount >= limit) throw new Error("Mission launch budget exhausted")
}
function oneShotAt(config: MissionConfiguration, now: number): number | null {
  for (const timing of missionLaunchModel(config.launch).schedules) {
    if (timing.kind === "at") {
      if (timing.at <= now) throw new Error("Mission date has passed")
      return timing.at
    }
    if (timing.kind === "in") return documentTimestamp.parse(now + timing.delayMs)
  }
  return null
}
function baseline(config: MissionConfiguration, checkpoints: MissionSourceCheckpoint[]) {
  for (const condition of missionLaunchModel(config.launch).events)
    if (!checkpoints.some(item => item.kind === condition.kind && item.key === missionSourceKey(condition)))
      throw new Error("Mission source baseline required")
}
/** Event changes since the last successful passage: trigger events and conditions, plus
 * the keys of every changed event so each schedule group reads only its own conditions. */
export type MissionEventNews = { triggers: boolean; conditions: boolean; changed?: readonly string[] }
/** An "else" schedule's own period runs from its previous slot (or the arming of its
 * calendar) to this slot. It is free when no passage launched by the criteria above its
 * group, or by Run now, was admitted for a slot in that period, even one that failed later.
 * Such a passage still awaiting admission is uncertain, so no fallback can be proven; so is
 * a period whose origin is not before this slot. */
export function missionFallbackClear(doc: MissionDocument, scheduleID: string, dueAt: number): boolean {
  const launch = doc.configuration.launch, model = missionLaunchModel(launch), eventSlot = missionEventPrincipalSlot(launch)
  const calendar = doc.calendars.find(item => item.scheduleID === scheduleID)
  const group = calendar ? model.plans[calendar.slot]?.group ?? 0 : 0
  const from = calendar?.lastDueAt ?? calendar?.armedAt ?? doc.firstPlayedAt ?? 0
  if (from >= dueAt) return false
  // A re-armed schedule answers for the calendars it replaced (`formerIDs`). A calendar no
  // longer listed belonged to a schedule since removed or changed: its place in the list is
  // unknown, so its passages count, which may skip a fallback slot but never doubles one.
  const above = (id: string) => {
    const item = doc.calendars.find(value => value.role === "principal" && (value.scheduleID === id || value.formerIDs?.includes(id)))
    return !item || item.slot === eventSlot || (model.plans[item.slot]?.group ?? 0) < group
  }
  // Only the calendars that decided a fan-in passage launched it.
  const deciders = (passage: Pick<MissionDocumentPending, "origin" | "launchedBy">) => passage.origin.kind === "wake"
    ? passage.launchedBy ?? passage.origin.wakes.map(wake => wake.scheduleID)
    : passage.origin.kind === "deferred" ? passage.origin.scheduleIDs : undefined
  // A wake passage stands for the latest slot of its deciding wakes, never for a later grouped one.
  const slot = (passage: Pick<MissionDocumentPending, "origin" | "launchedBy" | "dueAt">) => {
    if (passage.origin.kind !== "wake") return passage.dueAt
    const ids = deciders(passage)!
    return Math.max(...passage.origin.wakes.filter(wake => ids.includes(wake.scheduleID)).map(wake => wake.dueAt))
  }
  return ![doc.pending, ...doc.history].some(passage => passage && slot(passage) > from && slot(passage) <= dueAt
    && (passage.admittedAt !== null || passage === doc.pending)
    && (deciders(passage)?.some(above) ?? true))
}
/** Whether any of these principal wakes launches. The event check launches on a changed
 * trigger event; a schedule slot launches when one of its group's conditions changed ("if")
 * and, for a fallback group, when its own period is free ("else"). */
export function missionLaunches(doc: MissionDocument, wakes: readonly { scheduleID: string; dueAt: number }[], news: MissionEventNews): boolean {
  const launch = doc.configuration.launch, model = missionLaunchModel(launch), eventSlot = missionEventPrincipalSlot(launch)
  const changed = (conditions: readonly MissionCondition[]) => !conditions.length
    || (news.changed ? conditions.some(item => news.changed!.includes(missionSourceKey(item))) : news.conditions)
  return wakes.some(wake => {
    const calendar = doc.calendars.find(item => item.scheduleID === wake.scheduleID && item.role === "principal")
    if (!calendar) return false
    if (calendar.slot === eventSlot) return news.triggers
    const plan = model.plans[calendar.slot]
    return !!plan && changed(plan.conditions) && (!plan.fallback || missionFallbackClear(doc, wake.scheduleID, wake.dueAt))
  })
}
/** Saved launch criteria never turn back into a stored legacy policy. Checked by
 * `configure` and, before recording any intent, by one-time preparation. */
export function assertMissionLaunchShape(doc: MissionDocument, config: MissionConfiguration) {
  if ("when" in doc.configuration.launch && !("when" in config.launch)) throw new Error("Mission launch criteria cannot become a legacy policy")
}
/** Calendar-owned timing: schedules, the internal event check and end bounds. */
export function missionTemporalPolicy(config: MissionConfiguration) {
  const model = missionLaunchModel(config.launch)
  return { schedules: model.schedules, eventCheck: missionEventPrincipal(config.launch), until: model.until, endAfterMs: model.endAfterMs }
}

/** Mutates a detached, validated document under the store's CAS. Native evidence
 * and ownership are supplied by the caller's fresh synchronous commit guard. */
export const missionDocumentChanges = {
  configure(doc: MissionDocument, input: MissionConfiguration, now: number, checkpoints?: MissionSourceCheckpoint[]) {
    const config = missionConfigurationSchema.parse(input), edit = projectMissionDocument(doc).edit
    assertMissionLaunchShape(doc, config)
    if (!edit.structural) {
      const { objective: _oldObjective, notes: _oldNotes, ...oldStructure } = doc.configuration
      const { objective: _objective, notes: _notes, ...structure } = config
      if (!["passage", "launched-once"].includes(edit.reason ?? "") || !same(oldStructure, structure)) throw new Error("Mission configuration locked")
      // Keep the pending's frozen instructions/profile unchanged.
      doc.configuration = config
      return
    }
    if (doc.everCreatedTask && config.template !== doc.configuration.template) throw new Error("Mission template locked")
    const temporal = missionTemporalPolicy
    const changedTime = !same(temporal(config), temporal(doc.configuration))
    const changedTiming = !same(temporal(config).schedules, temporal(doc.configuration).schedules)
    if (doc.firstPlayedAt !== null && !same(missionLaunchModel(config.launch).events, missionLaunchModel(doc.configuration.launch).events)) {
      if (!checkpoints) throw new Error("Mission condition baseline reconciliation required")
      baseline(config, checkpoints)
    }
    if (checkpoints) doc.checkpoints = [...new Map([...missionCheckpointsSchema.parse(checkpoints), ...doc.checkpoints].map(item => [item.key, item])).values()]
    if (doc.calendars.some(item => item.pendingWake || item.wakePreparing)) throw new Error("Mission wake unresolved")
    // A deferred launch belongs to the launch criteria it was triggered under; the end
    // date is rechecked when it launches.
    const criteria = (value: MissionConfiguration) => {
      const model = missionLaunchModel(value.launch)
      return { schedules: model.schedules, plans: model.plans, triggers: model.triggers }
    }
    if (!same(criteria(config), criteria(doc.configuration))) {
      doc.deferred = null
      // A kept calendar that never had a slot starts any "else" period at this activation.
      for (const calendar of doc.calendars)
        if (calendar.role === "principal" && calendar.armedAt === undefined && calendar.lastDueAt === undefined) calendar.armedAt = now
    }
    doc.configuration = config
    doc.configurationGeneration++
    if (changedTime) {
      doc.fanIn = null
      doc.timeGeneration++
      if (doc.firstPlayedAt !== null) {
        if (changedTiming) doc.oneShotAt = oneShotAt(config, now)
        doc.synchronization = { requestID: `edit_${doc.revision + 1}`, kind: "replace", retiredCalendars: doc.calendars }
        doc.calendars = []
      }
    }
    if (doc.firstPlayedAt !== null) doc.slotEndsAt = missionSlotEndsAt(config.launch, doc.firstPlayedAt)
    const limit = missionLaunchLimit(config.launch)
    if (limit !== null && doc.launchedCount >= limit) doc.state = "finished"
  },
  play(doc: MissionDocument, requestID: string, now: number, checkpoints: MissionSourceCheckpoint[]) {
    documentID.parse(requestID)
    if (doc.firstPlayedAt !== null || doc.state !== "paused" || doc.pending || doc.preparation?.pending || doc.synchronization || doc.deletion) throw new Error("Mission cannot first Play")
    doc.checkpoints = missionCheckpointsSchema.parse(checkpoints)
    baseline(doc.configuration, doc.checkpoints)
    doc.oneShotAt = oneShotAt(doc.configuration, now)
    doc.firstPlayedAt = now
    doc.slotEndsAt = missionSlotEndsAt(doc.configuration.launch, now)
    if (doc.slotEndsAt !== null && (doc.slotEndsAt <= now || doc.oneShotAt !== null && doc.oneShotAt > doc.slotEndsAt))
      throw new Error("Mission end precedes first eligible slot")
    doc.state = "running"
    if (requiresMissionCalendar(doc.configuration.launch))
      doc.synchronization = { requestID, kind: "arm", retiredCalendars: [] }
  },
  synchronized(doc: MissionDocument, requestID: string, calendars: MissionCalendar[]) {
    if (!doc.synchronization || doc.synchronization.requestID !== requestID) throw new Error("Mission synchronization conflict")
    if (doc.synchronization.retiredCalendars.some(item => item.wakePreparing || item.pendingWake)) throw new Error("Mission retired wake unresolved")
    const running = (doc.state === "running" || doc.state === "paused" && doc.firstPlayedAt !== null) && requiresMissionCalendar(doc.configuration.launch)
    const count = missionPrincipalCount(doc.configuration.launch)
    if (running && (calendars.filter(item => item.role === "principal").length !== count
      || calendars.filter(item => item.role === "reconciliation").length !== 1)
      || !running && calendars.length) throw new Error("Mission calendar coverage incomplete")
    if (running && doc.calendars.some(old => old.role !== "reconciliation" || !calendars.some(item => same(item, old)))
      || calendars.some(item => {
        if (doc.synchronization!.retiredCalendars.some(old => old.scheduleID === item.scheduleID || old.sessionID === item.sessionID)) return true
        const current = doc.calendars.find(old => old.scheduleID === item.scheduleID || old.sessionID === item.sessionID)
        return current ? item.role !== "reconciliation" || !same(item, current) : item.highWater !== 0 || !!item.pendingWake || !!item.wakePreparing
      }))
      throw new Error("Mission replacement calendar identity reused")
    doc.calendars = calendars
    doc.synchronization = null
  },
  prepareWake(doc: MissionDocument, input: MissionWake) {
    available(doc)
    const wake = missionWakeSchema.parse(input), calendar = exactCalendar(doc, wake)
    if (calendar.wakePreparing && !same(calendar.wakePreparing, wake)) throw new Error("Mission wake preparation conflict")
    calendar.wakePreparing = wake
  },
  /** Remember one trigger consumed during a passage; all of them launch once afterwards. */
  defer(doc: MissionDocument, input: MissionWake, afterPassageID: string, news: MissionEventNews) {
    const wake = missionWakeSchema.parse(input), calendar = doc.calendars.find(item => item.scheduleID === wake.scheduleID)
    // A stored legacy policy never groups an overlapping wake into a later passage.
    if (!("when" in doc.configuration.launch)) return
    const passage = [doc.pending, ...doc.history].find(item => item?.id === afterPassageID)
    // A slot due by the passage's reservation is already answered by that passage.
    if (!passage || wake.dueAt <= passage.createdAt || doc.state !== "running" || doc.blocked || calendar?.role !== "principal") return
    // Decided at its slot, from the news observed then: a wake that would not launch now never launches later.
    if (!missionLaunches(doc, [wake], news)) return
    const old = doc.deferred?.afterPassageID === afterPassageID ? doc.deferred : null
    doc.deferred = { afterPassageID, dueAt: Math.max(old?.dueAt ?? 0, wake.dueAt),
      scheduleIDs: [...new Set([...(old?.scheduleIDs ?? []), wake.scheduleID])] }
  },
  processWake(doc: MissionDocument, input: MissionWake) {
    const wake = missionWakeSchema.parse(input), calendar = exactCalendar(doc, wake)
    // Caller proves this exact technical occurrence was ignored/consumed, even
    // when paused or overlapping; a gap is never a license to skip ahead.
    calendar.highWater = wake.run
    calendar.wakePreparing = null
    if (calendar.role === "principal") calendar.lastDueAt = wake.dueAt
  },
  /** `launchedBy`: for a wake origin, the calendars whose slot decided the launch. */
  reserve(doc: MissionDocument, input: MissionDocumentPending["origin"], now: number, checkpoints: MissionSourceCheckpoint[], launchedBy?: readonly string[]) {
    available(doc)
    if (doc.pending) throw new Error("Mission passage pending")
    const origin = structuredClone(input)
    if (origin.kind === "wake") {
      if (!origin.wakes.length || origin.wakes.length > 8 || new Set(origin.wakes.map(wake => wake.scheduleID)).size !== origin.wakes.length)
        throw new Error("Mission wake coverage invalid")
      origin.wakes = origin.wakes.map(wake => missionWakeSchema.parse(wake)).sort((a, b) => a.scheduleID < b.scheduleID ? -1 : 1)
      for (const wake of origin.wakes) {
        const calendar = exactCalendar(doc, wake)
        if (calendar.role !== "principal" || !same(calendar.wakePreparing, wake)) throw new Error("Mission wake not prepared")
        calendar.pendingWake = wake
        calendar.wakePreparing = null
        calendar.highWater = wake.run
        calendar.lastDueAt = wake.dueAt
      }
    } else if (origin.kind === "deferred") {
      if (!doc.deferred || doc.deferred.afterPassageID !== origin.afterPassageID || doc.deferred.dueAt !== origin.dueAt || origin.dueAt > now
        || !same(doc.deferred.scheduleIDs, origin.scheduleIDs))
        throw new Error("Mission deferred launch differs")
    } else {
      documentID.parse(origin.requestID)
      if (origin.kind === "immediate" && requiresMissionCalendar(doc.configuration.launch)) throw new Error("Mission needs native wake")
    }
    // Any reserved passage answers the triggers that waited for the previous one.
    doc.deferred = null
    const dueAt = origin.kind === "wake" ? Math.max(...origin.wakes.map(wake => wake.dueAt)) : origin.kind === "deferred" ? origin.dueAt : now
    // ends.at bounds recorded slots, never the wall-clock arrival of a late wake.
    if (doc.slotEndsAt !== null && dueAt > doc.slotEndsAt) throw new Error("Mission slot past end")
    const proof = missionCheckpointsSchema.parse(checkpoints)
    baseline(doc.configuration, proof)
    const id = missionDocumentPassageID(doc, doc.configurationGeneration, origin), missionID = `msn_${stableToken(`${doc.projectID}\0${id}`, 24)}`
    doc.pending = { id, missionID, coordinatorSessionID: missionCoordinatorSessionID(missionID, now),
      messageID: `msg_${stableToken(`${id}\0start`, 40)}`, origin, configurationGeneration: doc.configurationGeneration,
      timeGeneration: doc.timeGeneration, createdAt: now, dueAt, configuration: structuredClone(doc.configuration), checkpoints: proof, admittedAt: null, manualAllowed: false, admissionAttempted: false,
      ...(origin.kind === "wake" && launchedBy?.length ? { launchedBy: [...launchedBy].sort() } : {}) }
  },
  admitted(doc: MissionDocument, passageID: string, now: number) {
    const pending = exactPending(doc, passageID)
    // Exact native message/inbox readback or ACK, including after Pause/Stop.
    if (pending.admittedAt !== null) return
    pending.admittedAt = now
    doc.launchedCount++
    const limit = missionLaunchLimit(doc.configuration.launch)
    if (limit !== null && doc.launchedCount >= limit && doc.state !== "stopped") doc.state = "finished"
  },
  taskCreated(doc: MissionDocument, missionID: string) {
    if (!doc.pending || doc.pending.missionID !== missionID || doc.pending.admittedAt === null) throw new Error("Mission passage mismatch")
    doc.everCreatedTask = true
  },
  settle(doc: MissionDocument, passageID: string, outcome: "completed" | "failed" | "ended-without-report", now: number, notStarted = false) {
    const pending = exactPending(doc, passageID)
    if (notStarted !== (pending.admittedAt === null) || notStarted && outcome !== "failed") throw new Error("Mission settlement lacks admission proof")
    const { configuration, checkpoints, ...reference } = pending
    doc.history.push({ ...reference, configurationDigest: stableToken(canonicalAuthority(configuration), 64),
      settledAt: now, outcome, ...(notStarted ? { reason: "not-started" as const } : {}) })
    doc.history = doc.history.slice(-30)
    doc.settledCount++
    if (outcome === "completed") {
      doc.successfulCount++
      doc.lastSuccessfulPassageID = pending.id
      doc.checkpoints = [...new Map([...doc.checkpoints, ...checkpoints].map(item => [item.key, item])).values()]
    }
    else {
      doc.blocked = outcome
      // Human recovery resumes at a future slot, never with triggers owed before the failure.
      doc.deferred = null
    }
    if (pending.origin.kind === "wake") for (const wake of pending.origin.wakes) {
      const calendar = doc.calendars.find(item => item.scheduleID === wake.scheduleID)!
      calendar.highWater = Math.max(calendar.highWater, wake.run)
      calendar.pendingWake = null
    }
    doc.pending = null
  },
  requestDeletion(doc: MissionDocument, requestID: string, now: number, input = { expectedRevision: doc.revision, deleteManagedSessions: false }) {
    const identity = missionDocumentDeletionIdentitySchema.parse({ requestID, ...input })
    if (doc.deletion && (doc.deletion.requestID !== requestID || doc.deletion.expectedRevision !== identity.expectedRevision
      || doc.deletion.deleteManagedSessions !== identity.deleteManagedSessions)) throw new Error("Mission deletion conflict")
    doc.state = "stopped"
    doc.deletion ??= { ...identity, requestedAt: now }
    // The native cleanup owner reconciles mappings before compaction.
    doc.synchronization ??= { requestID: missionDeletionSynchronizationID(requestID), kind: "delete", retiredCalendars: [] }
  },
}

export const missionDeletionSynchronizationID = (requestID: string) => `del_${stableToken(requestID, 40)}`

function exactCalendar(doc: MissionDocument, wake: MissionWake) {
  const calendar = doc.calendars.find(item => item.scheduleID === wake.scheduleID)
  if (!calendar || calendar.timeGeneration !== doc.timeGeneration || wake.run !== calendar.highWater + 1) throw new Error("Mission stale or gapped wake")
  return calendar
}
function exactPending(doc: MissionDocument, passageID: string) {
  if (!doc.pending || doc.pending.id !== passageID) throw new Error("Mission passage mismatch")
  return doc.pending
}
