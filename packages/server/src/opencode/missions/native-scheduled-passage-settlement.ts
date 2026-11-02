import { canonicalAuthority } from "../../missions/authority-protocol"
import { documentPassageStartInput } from "../../missions/mission-document-passage-input"
import { nativeScheduledPassageBusiness, type NativeScheduledPassageContext } from "./native-scheduled-passage-business"
import { observePassageFamilySettlement } from "./native-recurrence-settlement"

export async function observeNativeScheduledPassage(input: NativeScheduledPassageContext) {
  const doc = input.document
  if (!doc.pending || doc.pending.admittedAt === null) return undefined
  const business = nativeScheduledPassageBusiness(input)
  const snapshot = await business.control.snapshot(), mission = snapshot.missions[0]
  if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.missions.length !== 1
    || mission.id !== doc.pending.missionID || mission.coordinatorSessionId !== doc.pending.coordinatorSessionID) throw new Error("Document passage journal unavailable")
  const frozen = await input.storage.get(business.inputKey)
  if (canonicalAuthority(frozen) !== canonicalAuthority({ input: documentPassageStartInput(doc) })) throw new Error("Document passage frozen input unavailable")
  const result = await observePassageFamilySettlement({ projectID: doc.projectID, mission, coordinatorSessionID: doc.pending.coordinatorSessionID,
    messageID: doc.pending.messageID, native: input.observation, directory: input.native.location.directory,
    workspaceID: input.native.location.workspaceID, signal: input.signal, current: () => input.authority(doc, "observe") })
  if (!result) return undefined
  return { outcome: result.outcome, current: (): true => { input.signal.throwIfAborted(); input.current(); return input.locked.assertActive() } }
}
