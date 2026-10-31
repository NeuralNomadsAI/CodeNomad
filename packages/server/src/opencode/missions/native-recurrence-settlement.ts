import type { MissionStorage } from "../../missions/journal"
import type { RecurrenceDocument } from "../../missions/recurrence-contract"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { MAX_CONTROL_FAMILY_SESSIONS } from "../../missions/native-session-family"
import { isMissionTaskSession } from "../../missions/session-identity"
import { passageSourceCursors, passageStartInput, type PassageSource } from "../../missions/recurrence-input"
import type { MissionMap } from "../../missions/model"
import { samePassageObservation, type NativePassageObservation, type PassageSessionObservation } from "./native-passage-observation"

export type PassageOutcome = "completed" | "failed" | "ended-without-report"

/** Walk seeds: the coordinator and every journal actor that is a native root.
 * A native-bound child actor is reached through its parent, never seeded as a
 * root (its parent would mismatch, or the walk would visit it twice). */
export async function passageFamilyRoots(native: Pick<NativePassageObservation, "session">, coordinatorSessionID: string,
  actorIDs: readonly string[]): Promise<string[]> {
  const roots = [coordinatorSessionID]
  for (const id of new Set(actorIDs)) if (id !== coordinatorSessionID && !(await native.session(id)).parentID) roots.push(id)
  return roots
}

/** Native quiescence, not an allowlist or exact replay of tool/event history.
 * Background subagents are ordinary descendants and must also be inactive. */
export async function observeNativePassageSettlement(input: {
  document: RecurrenceDocument; storage: MissionStorage; native: NativePassageObservation;
  directory: string; workspaceID?: string; current(): true; signal: AbortSignal;
  /** Display-only uncertainty; this callback grants no execution authority. */
  uncertain?(): void
}) {
  const { document: doc, native, signal } = input
  if (!doc.pending?.admission) return undefined
  const passage = recurrencePassage(input.storage, doc, input.current)
  if (doc.pending.admission.conversationID !== passage.coordinatorSessionID) throw new Error("Passage coordinator differs")
  const snapshot = await passage.journal.snapshot(), mission = snapshot.missions[0]
  if (snapshot.missions.length !== 1 || snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable
    || !mission || mission.id !== passage.missionID || mission.coordinatorSessionId !== passage.coordinatorSessionID)
    throw new Error("Passage journal unavailable")
  const frozen = await input.storage.get(passage.inputKey) as unknown as { sources: PassageSource[]; input: ReturnType<typeof passageStartInput> } | undefined
  if (!frozen || !samePassageObservation(frozen.input, passageStartInput(doc, passage, frozen.sources)))
    throw new Error("Passage frozen input unavailable")
  const settled = await observePassageFamilySettlement({ ...input, projectID: doc.projectID, mission,
    coordinatorSessionID: passage.coordinatorSessionID, messageID: passage.messageID })
  if (!settled) return undefined
  const result = { passageID: passage.passageID, messageID: passage.messageID, missionID: passage.missionID,
    conversationID: passage.coordinatorSessionID, outcome: settled.outcome, ...(settled.interrupted ? { reason: "interrupted" as const } : {}), artifactMessageIDs: [],
    cursors: settled.outcome === "completed" ? passageSourceCursors(frozen.sources) : [] }
  return { result, expectedRevision: doc.revision }
}

/** Shared native H11 proof. Callers supply their own typed durable document and
 * archive CAS; every original input, claim, family and background delivery is covered. */
export async function observePassageFamilySettlement(input: {
  projectID: string; mission: MissionMap; coordinatorSessionID: string; messageID: string;
  native: Pick<NativePassageObservation, "session" | "children" | "requests" | "assertCurrent">;
  directory: string; workspaceID?: string; signal: AbortSignal; current(): true; uncertain?(): void
}) {
  const { native, mission, signal } = input
  const actorIDs = mission.actors.map(actor => actor.sessionId)
  const originalInputs = new Map([[input.coordinatorSessionID, input.messageID]])
  const roots = await passageFamilyRoots(native, input.coordinatorSessionID, actorIDs)
  for (const id of roots.slice(1)) {
    // Fresh managed roots and all their descendants belong to this passage. A
    // reused external root needs separate input/family provenance qualification.
    const actor = mission.actors.find(actor => actor.sessionId === id)
    const source = mission.tasks.find(task => task.actorSessionId === id && isMissionTaskSession(id, mission.id, task.id))
    if (!actor?.managed || !source?.admissionId) { input.uncertain?.(); return undefined }
    originalInputs.set(id, source.admissionId)
  }
  const family: PassageSessionObservation[] = [], queue = roots
    .map(id => ({ id, parentID: undefined as string | undefined }))
  const seen = new Set<string>(), children = new Map<string, string[]>()
  while (queue.length) {
    signal.throwIfAborted(); input.current()
    const next = queue.shift()!
    if (seen.has(next.id)) throw new Error("Passage family moved")
    seen.add(next.id)
    const session = await native.session(next.id, originalInputs.get(next.id))
    if (session.projectID !== input.projectID || session.directory !== input.directory || session.workspaceID !== input.workspaceID
      || session.parentID !== next.parentID) throw new Error("Passage family moved")
    // Every claim blocks, including old claims absent from process-local active:
    // native restart recovery can resume them after this asynchronous read.
    if (session.active || session.inbox || session.suspended || session.runningTools || !session.terminal) {
      if (!session.active && (session.suspended || !session.terminal && !session.inbox && !session.runningTools)) input.uncertain?.()
      return undefined
    }
    if (originalInputs.has(next.id) && session.terminal.inputMessageID !== originalInputs.get(next.id)) { input.uncertain?.(); return undefined }
    // A pruned original input keeps the correlation uncertain; admission remains
    // recorded and the original prompt is never resent.
    family.push(session)
    const ids = await native.children(next.id)
    // The shared whole-family control ceiling: beyond it coverage is unknown, so the
    // passage stays pending (never archived, cursors unchanged), not assumed complete.
    if (seen.size + queue.length + ids.length > MAX_CONTROL_FAMILY_SESSIONS) throw new Error("Passage family capacity")
    children.set(next.id, ids)
    queue.push(...ids.map(id => ({ id, parentID: next.id })))
  }
  // A journal actor outside every walked native tree has moved.
  if (actorIDs.some(id => !seen.has(id))) throw new Error("Passage family moved")
  if (await native.requests([...seen])) return undefined
  if (mission.control?.pending.length) return undefined
  const outcome: PassageOutcome = mission.status === "completed" ? "completed"
    : family.some(session => session.failed) || mission.status === "failed" ? "failed" : "ended-without-report"
  // Recheck after the asynchronous journal and request reads. Unknown changes
  // park the same pending passage; they never admit another turn.
  for (const session of family) {
    if (!samePassageObservation(session, await native.session(session.id, originalInputs.get(session.id)))
      || !samePassageObservation(children.get(session.id), await native.children(session.id))) { input.uncertain?.(); return undefined }
  }
  if (await native.requests([...seen])) return undefined
  signal.throwIfAborted(); input.current(); native.assertCurrent()
  const interrupted = outcome === "ended-without-report" && family.some(session => session.terminal?.outcome === "interrupted")
  return { outcome, interrupted }
}

