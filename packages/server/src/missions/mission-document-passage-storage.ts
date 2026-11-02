import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, missionDeletionRecordKey, stableToken, type MissionStorage } from "./journal"
import { MISSION_DOCUMENT_PREFIX, type MissionDocument } from "./mission-document"

/** Storage isolation shared by daily and document passages. The native caller
 * owns authorization and the document exclusion throughout every mutation. */
export function isolatedMissionPassageJournal(storage: MissionStorage, identity: {
  projectID: string; projectCanonical: string; ownerID: string; passageID: string; storagePrefix: string
}, current: () => true, now: () => number = Date.now) {
  const projectToken = stableToken(`${identity.projectID}\0${identity.projectCanonical}`, 24)
  const missionID = `msn_${stableToken(`${identity.projectID}\0${identity.passageID}`, 24)}`
  const virtual = `${MISSION_JOURNAL_STORAGE_PREFIX}/${projectToken}`
  const physical = `${identity.storagePrefix}/passages/${projectToken}/${identity.ownerID}/${identity.passageID}`
  const suffix = (key: string) => {
    const tail = key.slice(virtual.length)
    if (!key.startsWith(`${virtual}/${missionID}/`) || !new RegExp(`^/${missionID}/[A-Za-z0-9_-]{3,100}$`).test(tail))
      throw new Error("Passage journal scope conflict")
    return tail
  }
  const record = missionDeletionRecordKey(projectToken, missionID)
  const scoped: MissionStorage = {
    isolated: true,
    get: async key => key === record ? undefined : storage.get(`${physical}${suffix(key)}`),
    set: async (key, value, supplied) => {
      const target = `${physical}${suffix(key)}`
      const fence = () => { assertSynchronousAuthorityGuard(current, "policy-unqualified"); supplied?.() }
      fence()
      await storage.set(target, value, fence)
    },
    scan: async ({ prefix, after, limit = 100 }) => {
      const range = prefix === virtual ? "/" : prefix === `${virtual}/${missionID}/` ? `/${missionID}/` : undefined
      if (!range || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Passage journal scan conflict")
      const nativeAfter = after === undefined ? undefined : `${physical}${suffix(after)}`
      const page = await storage.scan({ prefix: `${physical}${range}`, after: nativeAfter, limit })
      if (!Array.isArray(page.entries) || page.entries.length > limit) throw new Error("Invalid passage journal page")
      let previous = nativeAfter ?? `${physical}${range}`
      const entries = page.entries.map(entry => {
        if (!entry.key.startsWith(`${physical}${range}`) || entry.key <= previous) throw new Error("Invalid passage journal placement")
        const key = `${virtual}${entry.key.slice(physical.length)}`
        suffix(key); previous = entry.key
        return { key, value: entry.value }
      })
      if (page.next !== undefined && (!entries.length || page.next !== previous)) throw new Error("Invalid passage journal cursor")
      return { entries, ...(page.next === undefined ? {} : { next: entries.at(-1)!.key }) }
    },
  }
  return { missionID, inputKey: `${identity.storagePrefix}/inputs/${projectToken}/${identity.ownerID}/${identity.passageID}`,
    storage: scoped, journal: new MissionJournal(scoped, identity.projectID, identity.projectCanonical, now) }
}

export function missionDocumentPassage(storage: MissionStorage, doc: MissionDocument, current: () => true, now?: () => number) {
  const pending = doc.pending
  if (!pending) throw new Error("Document passage unavailable")
  const journal = isolatedMissionPassageJournal(storage, { projectID: doc.projectID, projectCanonical: doc.projectCanonical,
    ownerID: doc.id, passageID: pending.id, storagePrefix: MISSION_DOCUMENT_PREFIX }, current, now)
  if (journal.missionID !== pending.missionID) throw new Error("Document passage mission identity differs")
  return { ...journal, passageID: pending.id, messageID: pending.messageID, coordinatorSessionID: pending.coordinatorSessionID }
}
