import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, stableToken, type MissionStorage } from "./journal"
import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import { parseRecurrenceDocument, RECURRENCE_STORAGE_PREFIX, type RecurrenceDocument } from "./recurrence-contract"

/** Storage isolation only, never an ownership grant. The caller supplies its
 * current protected-writer fence; ordinary MissionControl can use this storage
 * unchanged, with passage.id as its creation requestID and the real project.
 * Authority storage must NOT use this adapter or acquire a new namespace. */
export function recurrencePassage(storage: MissionStorage, input: RecurrenceDocument, current: () => true,
  now: () => number = Date.now) {
  const doc = parseRecurrenceDocument(input, input.projectID, input.projectCanonical, input.id)
  if (!doc.pending) throw new Error("Recurrence passage missing")
  const passage = doc.pending.passage
  const isolated = passageJournal(storage, doc, passage.id, current, now)
  if (doc.pending.admission && doc.pending.admission.missionID !== isolated.missionID) throw new Error("Recurrence mission conflict")
  return { passageID: passage.id, messageID: passage.messageID,
    coordinatorSessionID: passage.coordinatorSessionID, ...isolated }
}

/** Archived display authority comes only from the exact durable receipt. No
 * browser mission/session selectors and no reconstructed pending passage. */
export function archivedRecurrencePassage(storage: MissionStorage, input: RecurrenceDocument, passageID: string) {
  const doc = parseRecurrenceDocument(input, input.projectID, input.projectCanonical, input.id)
  const receipt = doc.history.find(item => item.passage.id === passageID)
  if (!receipt || !("missionID" in receipt.result)) throw new Error("Archived recurrence result unavailable")
  const isolated = passageJournal(storage, doc, receipt.passage.id, () => { throw new Error("Archived recurrence is read-only") })
  if (receipt.result.missionID !== isolated.missionID
    || receipt.result.conversationID !== `ses_${stableToken(`${isolated.missionID}\0coordinator`, 26)}`)
    throw new Error("Archived recurrence mission conflict")
  return { receipt, ...isolated }
}

function passageJournal(storage: MissionStorage, doc: RecurrenceDocument, passageID: string, current: () => true, now: () => number = Date.now) {
  const projectToken = stableToken(`${doc.projectID}\0${doc.projectCanonical}`, 24)
  // Exactly the existing MissionControl creation identity, not a second scheme.
  const missionID = `msn_${stableToken(`${doc.projectID}\0${passageID}`, 24)}`
  const virtual = `${MISSION_JOURNAL_STORAGE_PREFIX}/${projectToken}`
  const physical = `${RECURRENCE_STORAGE_PREFIX}/passages/${projectToken}/${doc.id}/${passageID}`
  const suffix = (key: string) => {
    const tail = key.slice(virtual.length)
    if (!key.startsWith(`${virtual}/${missionID}/`) || !new RegExp(`^/${missionID}/[A-Za-z0-9_-]{3,100}$`).test(tail)) {
      throw new Error("Recurrence journal scope conflict")
    }
    return tail
  }
  const scoped: MissionStorage = {
    get: async key => storage.get(`${physical}${suffix(key)}`),
    set: async (key, value, supplied) => {
      const target = `${physical}${suffix(key)}`
      const fence = () => { assertSynchronousAuthorityGuard(current, "policy-unqualified"); supplied?.() }
      fence()
      // Repeat the same fence after the native adapter's async preparation.
      await storage.set(target, value, fence)
    },
    scan: async ({ prefix, after, limit = 100 }) => {
      if (prefix !== virtual || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Recurrence journal scan conflict")
      const nativeAfter = after === undefined ? undefined : `${physical}${suffix(after)}`
      const page = await storage.scan({ prefix: `${physical}/`, after: nativeAfter, limit })
      if (!Array.isArray(page.entries) || page.entries.length > limit) throw new Error("Invalid recurrence journal page")
      let previous = nativeAfter ?? `${physical}/`
      const entries = page.entries.map(entry => {
        if (!entry.key.startsWith(`${physical}/`) || entry.key <= previous) throw new Error("Invalid recurrence journal placement")
        const key = `${virtual}${entry.key.slice(physical.length)}`
        suffix(key)
        previous = entry.key
        return { key, value: entry.value }
      })
      if (page.next !== undefined && (!entries.length || page.next !== previous)) throw new Error("Invalid recurrence journal cursor")
      return { entries, ...(page.next === undefined ? {} : { next: entries.at(-1)!.key }) }
    },
  }
  return { missionID, inputKey: `${RECURRENCE_STORAGE_PREFIX}/inputs/${projectToken}/${doc.id}/${passageID}`, storage: scoped,
    journal: new MissionJournal(scoped, doc.projectID, doc.projectCanonical, now) }
}
