import { canonicalAuthority } from "../../missions/authority-protocol"
import type { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { missionLaunchLimit } from "../../missions/launch-policy"
import { stableToken } from "../../missions/receipt-identity"
import type { MissionScheduleRequest } from "../../missions/mission-schedule-contract"
import type { MissionDocument } from "../../missions/mission-document"

/** The first Play's desired-state receipt remains addressable while its native
 * original is unconfirmed, even through later explicit Checks. */
export function immediateMissionControlReceipts(doc: MissionDocument, operation: NonNullable<MissionDocument["calendarOwner"]>["operation"]) {
  const receipts = [...doc.calendarOwner?.receipts ?? [], operation]
  const requestID = doc.pending?.origin.kind === "immediate" && doc.pending.admittedAt === null ? doc.pending.origin.requestID : undefined
  const first = requestID ? receipts.find(receipt => receipt.requestID === requestID) : undefined
  return first ? [first, ...receipts.filter(receipt => receipt !== first).slice(-15)] : receipts.slice(-16)
}

/** Commit desired control and the first original reservation together. Admission
 * completion is projected from that original's persisted proof, not this intent. */
export function prepareNativeImmediateMissionControl(store: NativeMissionDocumentStore,
  input: Pick<MissionScheduleRequest, "missionID" | "requestID" | "expectedRevision" | "action" | "deleteManagedSessions">,
  current: () => true, now = Date.now) {
  const { missionID, requestID, expectedRevision, action } = input
  const fingerprint = stableToken(canonicalAuthority({ action, configuration: null, deleteManagedSessions: input.deleteManagedSessions ?? false }), 64)
  return store.withExclusion(async locked => {
    current()
    const before = await locked.read(missionID)
    if (!before || "deletedAt" in before || !before.calendarOwner || before.oneTime) throw new Error("Immediate Mission unavailable")
    const replay = before.calendarOwner.receipts.find(item => item.requestID === requestID)
    if (replay) {
      if (replay.expectedRevision !== expectedRevision || replay.fingerprint !== fingerprint) throw new Error("Mission control request conflict")
      current(); return before
    }
    const at = now()
    return locked.change(missionID, expectedRevision, current, value => {
      if (action === "play" && value.firstPlayedAt === null) {
        changes.play(value, requestID, at, [])
        changes.reserve(value, { kind: "immediate", requestID }, at, [])
      } else if (action === "resume" || action === "play") {
        if (!value.pending || value.pending.admittedAt === null || value.blocked === "unknown" || value.state === "stopped" || value.deletion)
          throw new Error("Immediate pending resume unavailable")
        value.blocked = null
        const limit = missionLaunchLimit(value.configuration.launch)
        value.state = limit !== null && value.launchedCount >= limit ? "finished" : "running"
      } else if (action === "pause") { value.state = "paused"; if (value.pending) value.pending.manualAllowed = false }
      else if (action === "stop") { value.state = "stopped"; if (value.pending) value.pending.manualAllowed = false }
      else if (action !== "check") throw new Error("Immediate Mission action unavailable")
      const operation = { requestID, expectedRevision, fingerprint, action: action as "play" | "pause" | "stop" | "check" | "resume", pending: false, startedAt: at }
      value.calendarOwner!.receipts = immediateMissionControlReceipts(value, operation)
      value.calendarOwner!.operation = operation
    })
  })
}
