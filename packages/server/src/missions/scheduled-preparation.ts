import { canonicalAuthority } from "./authority-protocol"
import { sameMissionCreationChoices } from "./creation-defaults"
import type { MissionPrepareRequest } from "./control-types"
import type { MissionDocument } from "./mission-document"
import { missionScheduleView } from "./mission-schedule-view"
import { automaticMissionStartID, type PreparationResult } from "./preparation-result"
import { samePreparationOptions, type PreparationAuthor } from "./preparation-input"
import { missionRecoveryControlError } from "./recovery-error"

export function assertScheduledPreparation(doc: MissionDocument, author: PreparationAuthor, requestID: string, input: MissionPrepareRequest) {
  const creation = doc.creation, original = creation?.input
  if (!creation || creation.requestID !== requestID || !original
    || canonicalAuthority(creation.author) !== canonicalAuthority(author)
    || original.objective !== input.objective || original.title !== input.title || original.notes !== input.notes
    || original.template !== input.template || original.startOnCreation !== Boolean(input.startOnCreation)
    || !samePreparationOptions(original, input)
    || !sameMissionCreationChoices(creation.creationDefaults?.request ?? original, input)) throw missionRecoveryControlError("prepare-conflict")
}

/** Recovery observes the consumed first Play; it never sends a control. */
export function recoveredScheduledPreparation(doc: MissionDocument): PreparationResult {
  const target = { kind: "schedule" as const, document: missionScheduleView(doc) }
  const automatic = doc.creation?.automaticStart
  if (!automatic?.attempted) return { outcome: "prepared", acknowledgement: "recovered", target }
  const requestID = automaticMissionStartID(doc.creation!.requestID)
  const control = [doc.calendarOwner?.operation, ...doc.calendarOwner?.receipts ?? []]
    .find(item => item?.requestID === requestID && item.action === "play")
  if (doc.firstPlayedAt !== null && control && !control.pending)
    return { outcome: "activated", acknowledgement: "recovered", target }
  return { outcome: "uncertain", phase: "start", requestID, missionID: doc.id, target }
}
