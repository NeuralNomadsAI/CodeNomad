import { canonicalAuthority } from "../../missions/authority-protocol"
import { missionTombstoneSchema, parseMissionDocument, type MissionDocument } from "../../missions/mission-document"
import { scheduledPassageMarker } from "./native-scheduled-passage-business"

/** A reused root returns to ordinary routing only with positive archived/deleted
 * ownership. Missing or mismatched evidence retains its original uncertainty. */
export function scheduledPassageOwner(raw: unknown, identity: Pick<MissionDocument, "projectID" | "projectCanonical">,
  sessionID: string, marker: { missionID?: unknown; document?: { missionID?: unknown; passageID?: unknown; coordinatorReused?: unknown } }) {
  const source = marker.document
  if (typeof source?.missionID !== "string" || typeof source.passageID !== "string" || typeof marker.missionID !== "string")
    throw new Error("Scheduled passage marker unavailable")
  if (raw && typeof raw === "object" && "deletedAt" in raw) {
    const tombstone = missionTombstoneSchema.parse(raw)
    if (source.coordinatorReused !== true || tombstone.id !== source.missionID || tombstone.projectID !== identity.projectID
      || tombstone.projectCanonical !== identity.projectCanonical) throw new Error("Scheduled passage tombstone differs")
    return undefined
  }
  const doc = parseMissionDocument(raw, { ...identity, id: source.missionID })
  if (doc.pending && doc.pending.coordinatorSessionID === sessionID && doc.pending.missionID === marker.missionID
    && canonicalAuthority(source) === canonicalAuthority(scheduledPassageMarker(doc))) return doc
  if (source.coordinatorReused === true && doc.history.some(receipt => receipt.coordinatorReused
    && receipt.id === source.passageID && receipt.missionID === marker.missionID && receipt.coordinatorSessionID === sessionID)) return undefined
  if (source.coordinatorReused === true && doc.coordinatorReleases.some(receipt => receipt.id === source.passageID
    && receipt.missionID === marker.missionID && receipt.coordinatorSessionID === sessionID)) return undefined
  throw new Error(doc.pending ? "Scheduled passage pending differs" : "Scheduled passage archive unavailable")
}
