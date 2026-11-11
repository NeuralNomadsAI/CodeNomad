import { canonicalAuthority } from "../../missions/authority-protocol"
import { documentPassageStartInput } from "../../missions/mission-document-passage-input"
import { nativeScheduledPassageBusiness, type NativeScheduledPassageContext } from "./native-scheduled-passage-business"
import { observePassageFamilySettlement, passageFamilyRoots } from "./native-recurrence-settlement"

export async function observeNativeScheduledPassage(input: NativeScheduledPassageContext) {
  const doc = input.document
  if (!doc.pending || doc.pending.admittedAt === null) return undefined
  const fence = input.settlementFence?.()
  if (doc.pending.coordinatorReused && !fence) throw new Error("Reused coordinator settlement fence unavailable")
  fence?.family(doc.pending.coordinatorSessionID, doc.pending.messageID, false, doc.pending.coordinatorBaseline)
  const business = nativeScheduledPassageBusiness(input)
  const snapshot = await business.control.snapshot(), mission = snapshot.missions[0]
  if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.missions.length !== 1
    || mission.id !== doc.pending.missionID || mission.coordinatorSessionId !== doc.pending.coordinatorSessionID) throw new Error("Document passage journal unavailable")
  for (const id of (await passageFamilyRoots(input.observation, doc.pending.coordinatorSessionID, mission.actors.map(actor => actor.sessionId))).slice(1))
    fence?.family(id, mission.tasks.find(task => task.actorSessionId === id)?.admissionId)
  const frozen = await input.storage.get(business.inputKey)
  if (canonicalAuthority(frozen) !== canonicalAuthority({ input: documentPassageStartInput(doc) })) throw new Error("Document passage frozen input unavailable")
  const result = await observePassageFamilySettlement({ projectID: doc.projectID, mission, coordinatorSessionID: doc.pending.coordinatorSessionID,
    messageID: doc.pending.messageID, native: input.observation, directory: input.native.location.directory,
    workspaceID: input.native.location.workspaceID, signal: input.signal, reusedCoordinator: doc.pending.coordinatorReused,
    coordinatorBaseline: doc.pending.coordinatorBaseline,
    coordinatorOwner: doc.pending.coordinatorReused ? { passageID: doc.pending.id, missionID: doc.pending.missionID, coordinatorSessionID: doc.pending.coordinatorSessionID } : undefined,
    current: () => input.authority(doc, "observe") })
  if (!result) return undefined
  fence?.current()
  return { outcome: result.outcome, ...(doc.pending.coordinatorReused ? { proof: result.proof } : {}),
    current: (): true => { input.signal.throwIfAborted(); input.current(); fence?.current(); return input.locked.assertActive() } }
}
