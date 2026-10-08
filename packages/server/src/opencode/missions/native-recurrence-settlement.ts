import type { MissionStorage } from "../../missions/journal"
import type { RecurrenceDocument } from "../../missions/recurrence-contract"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { passageSourceCursors, passageStartInput, type PassageSource } from "../../missions/recurrence-input"
import { samePassageObservation, type NativePassageObservation, type PassageSessionObservation } from "./native-passage-observation"

export type PassageOutcome = "completed" | "failed" | "stopped" | "ended-without-report"

/** Native quiescence, not an allowlist or exact replay of tool/event history.
 * Background subagents are ordinary descendants and must also be inactive. */
export async function observeNativePassageSettlement(input: {
  document: RecurrenceDocument; storage: MissionStorage; native: NativePassageObservation;
  directory: string; workspaceID?: string; current(): true; signal: AbortSignal
}) {
  const { document: doc, native, signal } = input
  if (!doc.pending?.admission) return undefined
  const passage = recurrencePassage(input.storage, doc, input.current)
  if (doc.pending.admission.conversationID !== passage.coordinatorSessionID) throw new Error("Passage coordinator differs")
  const snapshot = await passage.journal.snapshot(), mission = snapshot.missions[0]
  if (snapshot.missions.length !== 1 || snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable
    || !mission || mission.id !== passage.missionID || mission.coordinatorSessionId !== passage.coordinatorSessionID)
    throw new Error("Passage journal unavailable")
  const family: PassageSessionObservation[] = [], queue = [...new Set([passage.coordinatorSessionID,
    ...mission.actors.map(actor => actor.sessionId)])].map(id => ({ id, parentID: undefined as string | undefined }))
  const seen = new Set<string>(), children = new Map<string, string[]>()
  while (queue.length) {
    signal.throwIfAborted(); input.current()
    const next = queue.shift()!
    if (seen.has(next.id) || seen.size >= 32) throw new Error("Passage family capacity")
    seen.add(next.id)
    const session = await native.session(next.id, next.id === passage.coordinatorSessionID ? passage.messageID : undefined)
    if (session.projectID !== doc.projectID || session.directory !== input.directory || session.workspaceID !== input.workspaceID
      || session.parentID !== next.parentID) throw new Error("Passage family moved")
    if (session.active || session.inbox || session.pending || session.suspended || session.runningTools) return undefined
    if (next.id === passage.coordinatorSessionID && !session.messagePresent) return undefined
    family.push(session)
    const ids = await native.children(next.id)
    children.set(next.id, ids)
    queue.push(...ids.map(id => ({ id, parentID: next.id })))
  }
  if (await native.requests([...seen])) return undefined
  if (mission.control?.pending.length) return undefined
  const outcome: PassageOutcome = mission.status === "completed" ? "completed"
    : family.some(session => session.failed) || mission.status === "failed" ? "failed" : "ended-without-report"
  const frozen = await input.storage.get(passage.inputKey) as unknown as { sources: PassageSource[]; input: ReturnType<typeof passageStartInput> } | undefined
  if (!frozen || !samePassageObservation(frozen.input, passageStartInput(doc, passage, frozen.sources)))
    throw new Error("Passage frozen input unavailable")
  // Recheck after the asynchronous journal and request reads. Unknown changes
  // park the same pending passage; they never admit another turn.
  for (const session of family) {
    if (!samePassageObservation(session, await native.session(session.id,
      session.id === passage.coordinatorSessionID ? passage.messageID : undefined))
      || !samePassageObservation(children.get(session.id), await native.children(session.id))) return undefined
  }
  if (await native.requests([...seen])) return undefined
  signal.throwIfAborted(); input.current(); native.assertCurrent()
  const result = { passageID: passage.passageID, messageID: passage.messageID, missionID: passage.missionID,
    conversationID: passage.coordinatorSessionID, outcome, artifactMessageIDs: [],
    cursors: outcome === "completed" ? passageSourceCursors(frozen.sources) : [] }
  return { result, current: (): true => { signal.throwIfAborted(); input.current(); return native.assertQuiescent(family) } }
}

