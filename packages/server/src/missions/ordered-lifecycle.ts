import { projectControl, projectPauseEvidence, type MissionControlAppliedEvent, type MissionControlRequestedEvent,
  type MissionLifecycleReceipt, type projectLifecycle } from "./lifecycle-model"
import { controlReceiptID, isControlReceipt } from "./receipt-identity"
import { compareEvents, type MissionEvent } from "./model"

/** Exact lookup from the same immutable observation as the ordered batches. */
export type ReadRangeEvent = (id: string) => MissionEvent | undefined

/** Keeps the current operation and the bounded evidence inherited from its
 * preceding Pause. Historical operations are read by their deterministic key. */
export function orderedLifecycle(read: ReadRangeEvent) {
  let prepared = false
  let seenCreation = false
  let current: MissionControlRequestedEvent | undefined
  let receiptEvents: MissionControlAppliedEvent[] = []
  let inherited: ReturnType<typeof projectPauseEvidence> | undefined
  let lastRevision = 0
  let invalid = false
  let cached: ReturnType<typeof projectLifecycle> | undefined

  function apply(event: MissionEvent, revision: number) {
    if (event.type === "mission.created" && !seenCreation) {
      seenCreation = true
      prepared = event.prepared === true
      cached = undefined
    }
    if (event.type === "mission.control-requested") {
      inherited = undefined
      if (event.action === "start" && current?.action === "pause") {
        const bySession = new Map(receiptEvents.map(receipt => [receipt.sessionID, receipt.nativeAcknowledgement]))
        inherited = projectPauseEvidence(current, id => bySession.get(id))
      }
      current = event
      receiptEvents = []
      lastRevision = revision
      cached = undefined
      for (const sessionID of new Set(event.targets.map(target => target.sessionID))) {
        const slot = read(controlReceiptID(event.id, sessionID))
        if (!slot) continue
        if (slot.type !== "mission.control-applied" || !isControlReceipt(slot, event, sessionID)) invalid = true
        else if (compareEvents(slot, event) < 0) receiptEvents.push(slot)
      }
      receiptEvents.sort(compareEvents)
    }
    if (event.type === "mission.control-applied") {
      const intent = current?.id === event.operationID ? current : read(event.operationID)
      if (intent?.type !== "mission.control-requested" || !isControlReceipt(event, intent, event.sessionID)) invalid = true
      else if (intent === current) {
        receiptEvents.push(event)
        lastRevision = revision
      }
      cached = undefined
    }
  }

  function project(): ReturnType<typeof projectLifecycle> {
    if (cached) return cached
    const unavailable = invalid ? { controlUnavailable: true as const } : {}
    const operation = current
    if (!operation) return cached = { ...unavailable, runState: prepared ? "prepared" : "running" }
    const receipts: MissionLifecycleReceipt[] = receiptEvents.map(event => ({
      receiptID: event.id, sessionID: event.sessionID, acknowledgementState: event.nativeAcknowledgement ? "known" : "unknown",
      ...(event.nativeAcknowledgement ? { nativeAcknowledgement: event.nativeAcknowledgement } : {}),
    }))
    return cached = projectControl(operation, receipts, lastRevision, inherited, invalid)
  }
  return { apply, project }
}
