import type { MissionSnapshot } from "./model"
import type { MissionJournal, MissionStorage } from "./journal"
import type { MissionCreationIntents } from "./creation-intent"
import type { MissionDocumentAccess } from "./mission-document-one-time"
import { readMissionDocumentPage } from "./mission-document-page"
import { missionRecoveryControlError } from "./recovery-error"
import { stableToken } from "./receipt-identity"

const nativeRequestID = (sessionID: string, requestID: string, source?: string) =>
  `prepare_${stableToken(`${source ?? "outside-mission"}\0${sessionID}\0${requestID}`, 24)}`

/** Read all retained author/source domains before choosing an identity for creation.
 * Released passage markers change admission, while the original provenance owns replay. */
export async function missionPreparationIdentity(args: {
  sessionID: string; requestID: string; sourceMissionID?: string; snapshot: MissionSnapshot
  journal: MissionJournal; intents: MissionCreationIntents; storage: MissionStorage
  project: { id: string; canonical: string }; documents?: MissionDocumentAccess
}) {
  const { sessionID, requestID, project } = args
  const sources = new Set<string | undefined>([args.sourceMissionID, undefined])
  for (const mission of args.snapshot.missions) {
    if (mission.preparedBy?.coordinatorSessionId === sessionID) sources.add(mission.preparedBy.missionId)
  }
  const bindings = await args.intents.preparationBindings(sessionID)
  for (const binding of bindings) sources.add(binding.author.missionID)
  if (args.documents) {
    let after: string | undefined
    do {
      const page = await readMissionDocumentPage(args.storage, project, { after })
      for (const doc of page.documents) {
        if (doc.creation?.author?.coordinatorSessionID === sessionID) sources.add(doc.creation.author.missionID)
      }
      after = page.next
    } while (after)
  }
  const existing: Array<{ requestID: string; sourceMissionID?: string }> = []
  for (const sourceMissionID of sources) {
    const id = nativeRequestID(sessionID, requestID, sourceMissionID)
    const intentID = `msn_${stableToken(`${project.id}\0${id}`, 24)}`
    if (bindings.some(binding => binding.creationRequestID === id)
      || args.snapshot.missions.some(mission => mission.id === intentID)
      || await args.journal.deletionRecord(intentID)
      || args.documents && await args.documents(store => store.read(intentID))) {
      existing.push({ requestID: id, sourceMissionID })
    }
  }
  if (existing.length > 1) throw missionRecoveryControlError("prepare-conflict")
  return existing[0] ?? { requestID: nativeRequestID(sessionID, requestID, args.sourceMissionID), sourceMissionID: args.sourceMissionID }
}
