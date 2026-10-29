import { canonicalAuthority } from "./authority-protocol"
import { stableToken } from "./receipt-identity"
import { missionCoordinatorSessionID } from "./session-identity"
import { documentID, documentTimestamp, missionConfigurationSchema, missionLaunchLimit, missionSlotEndsAt,
  requiresMissionCalendar, type MissionConfiguration } from "./launch-policy"
import { missionCheckpointsSchema, missionDocumentPassageID, missionSourceKey, missionWakeSchema, projectMissionDocument,
  type MissionCalendar, type MissionDocument, type MissionDocumentPending, type MissionSourceCheckpoint, type MissionWake } from "./mission-document"
import { missionDocumentDeletionIdentitySchema } from "./mission-document"

const same = (a: unknown, b: unknown) => canonicalAuthority(a) === canonicalAuthority(b)
function available(doc: MissionDocument) {
  if (doc.deletion || doc.synchronization || doc.blocked || doc.state !== "running") throw new Error("Mission admission blocked")
  const limit = missionLaunchLimit(doc.configuration.launch)
  if (limit !== null && doc.launchedCount >= limit) throw new Error("Mission launch budget exhausted")
}
function oneShotAt(config: MissionConfiguration, now: number): number | null {
  const timing = config.launch.timing
  if (timing.kind === "at") {
    if (timing.at <= now) throw new Error("Mission date has passed")
    return timing.at
  }
  return timing.kind === "in" ? documentTimestamp.parse(now + timing.delayMs) : null
}
function baseline(config: MissionConfiguration, checkpoints: MissionSourceCheckpoint[]) {
  const condition = config.launch.condition
  if (condition && !checkpoints.some(item => item.kind === condition.kind && item.key === missionSourceKey(condition)))
    throw new Error("Mission source baseline required")
}

/** Mutates a detached, validated document under the store's CAS. Native evidence
 * and ownership are supplied by the caller's fresh synchronous commit guard. */
export const missionDocumentChanges = {
  configure(doc: MissionDocument, input: MissionConfiguration, now: number) {
    const config = missionConfigurationSchema.parse(input), edit = projectMissionDocument(doc).edit
    if (!edit.structural) {
      const { objective: _oldObjective, notes: _oldNotes, ...oldStructure } = doc.configuration
      const { objective: _objective, notes: _notes, ...structure } = config
      if (!["passage", "launched-once"].includes(edit.reason ?? "") || !same(oldStructure, structure)) throw new Error("Mission configuration locked")
      // Keep the pending's frozen instructions/profile unchanged.
      doc.configuration = config
      return
    }
    if (doc.everCreatedTask && config.template !== doc.configuration.template) throw new Error("Mission template locked")
    const temporal = (value: MissionConfiguration) => ({ timing: value.launch.timing, at: value.launch.ends.at, afterMs: value.launch.ends.afterMs })
    const changedTime = !same(temporal(config), temporal(doc.configuration))
    if (doc.firstPlayedAt !== null && !same(config.launch.condition, doc.configuration.launch.condition))
      throw new Error("Mission condition baseline reconciliation required")
    if (doc.calendars.some(item => item.pendingWake || item.wakePreparing)) throw new Error("Mission wake unresolved")
    doc.configuration = config
    doc.configurationGeneration++
    if (changedTime) {
      doc.timeGeneration++
      if (doc.firstPlayedAt !== null) {
        doc.oneShotAt = oneShotAt(config, now)
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
    if (doc.firstPlayedAt !== null || doc.state !== "paused" || doc.pending || doc.synchronization || doc.deletion) throw new Error("Mission cannot first Play")
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
    const running = doc.state === "running" && requiresMissionCalendar(doc.configuration.launch)
    const count = doc.configuration.launch.timing.kind === "multi" ? doc.configuration.launch.timing.calendars.length : 1
    if (running && (calendars.filter(item => item.role === "principal").length !== count
      || calendars.filter(item => item.role === "reconciliation").length !== 1)
      || !running && calendars.length) throw new Error("Mission calendar coverage incomplete")
    if (calendars.some(item => item.highWater !== 0 || item.pendingWake || item.wakePreparing
      || doc.synchronization!.retiredCalendars.some(old => old.scheduleID === item.scheduleID || old.sessionID === item.sessionID)))
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
  processWake(doc: MissionDocument, input: MissionWake) {
    const wake = missionWakeSchema.parse(input), calendar = exactCalendar(doc, wake)
    if (calendar.pendingWake) throw new Error("Mission wake still pending")
    // Caller proves this exact technical occurrence was ignored/consumed, even
    // when paused or overlapping; a gap is never a license to skip ahead.
    calendar.highWater = wake.run
    calendar.wakePreparing = null
  },
  reserve(doc: MissionDocument, input: MissionDocumentPending["origin"], now: number, checkpoints: MissionSourceCheckpoint[]) {
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
      }
    } else {
      documentID.parse(origin.requestID)
      if (origin.kind === "immediate" && requiresMissionCalendar(doc.configuration.launch)) throw new Error("Mission needs native wake")
    }
    const dueAt = origin.kind === "wake" ? Math.max(...origin.wakes.map(wake => wake.dueAt)) : now
    // ends.at bounds recorded slots, never the wall-clock arrival of a late wake.
    if (doc.slotEndsAt !== null && dueAt > doc.slotEndsAt) throw new Error("Mission slot past end")
    const proof = missionCheckpointsSchema.parse(checkpoints)
    baseline(doc.configuration, proof)
    const id = missionDocumentPassageID(doc, doc.configurationGeneration, origin), missionID = `msn_${stableToken(`${doc.projectID}\0${id}`, 24)}`
    doc.pending = { id, missionID, coordinatorSessionID: missionCoordinatorSessionID(missionID, now),
      messageID: `msg_${stableToken(`${id}\0start`, 40)}`, origin, configurationGeneration: doc.configurationGeneration,
      timeGeneration: doc.timeGeneration, createdAt: now, dueAt, configuration: structuredClone(doc.configuration), checkpoints: proof, admittedAt: null }
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
    if (outcome === "completed") doc.checkpoints = [...new Map([...doc.checkpoints, ...checkpoints].map(item => [item.key, item])).values()]
    else doc.blocked = outcome
    if (pending.origin.kind === "wake") for (const wake of pending.origin.wakes) {
      const calendar = doc.calendars.find(item => item.scheduleID === wake.scheduleID)!
      calendar.highWater = wake.run
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
  if (!calendar || calendar.timeGeneration !== doc.timeGeneration || wake.run !== calendar.highWater + 1
    || calendar.pendingWake && !same(calendar.pendingWake, wake)) throw new Error("Mission stale or gapped wake")
  return calendar
}
function exactPending(doc: MissionDocument, passageID: string) {
  if (!doc.pending || doc.pending.id !== passageID) throw new Error("Mission passage mismatch")
  return doc.pending
}
