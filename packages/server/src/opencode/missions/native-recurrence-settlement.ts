import { MAX_CONTROL_FAMILY_SESSIONS } from "../../missions/native-session-family"
import { isMissionTaskSession } from "../../missions/session-identity"
import type { MissionMap } from "../../missions/model"
import { samePassageObservation, type NativePassageObservation, type PassageSessionObservation } from "./native-passage-observation"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { stableToken } from "../../missions/receipt-identity"
import type { CoordinatorBaseline, CoordinatorInputOwner } from "../../missions/mission-coordinator-baseline"

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

/** Shared native H11 proof. Callers supply their own typed durable document and
 * archive CAS; every original input, claim, family and background delivery is covered. */
export async function observePassageFamilySettlement(input: {
  projectID: string; mission: MissionMap; coordinatorSessionID: string; messageID: string;
  native: Pick<NativePassageObservation, "session" | "children" | "requests" | "assertCurrent">;
  directory: string; workspaceID?: string; signal: AbortSignal; current(): true; uncertain?(): void
  reusedCoordinator?: boolean
  coordinatorBaseline?: CoordinatorBaseline
  coordinatorOwner?: CoordinatorInputOwner
}) {
  const { native, mission, signal } = input
  const actorIDs = mission.actors.map(actor => actor.sessionId)
  const baseline = new Map(input.coordinatorBaseline?.map(row => [row[0], row]))
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
    .map(id => ({ id, parentID: undefined as string | undefined, adopted: input.reusedCoordinator && id === input.coordinatorSessionID }))
  const seen = new Set<string>(), adoptedIDs = new Set<string>(), children = new Map<string, string[]>()
  while (queue.length) {
    signal.throwIfAborted(); input.current()
    const next = queue.shift()!
    if (seen.has(next.id)) throw new Error("Passage family moved")
    seen.add(next.id)
    if (next.adopted) adoptedIDs.add(next.id)
    const owner = next.adopted && !originalInputs.has(next.id) ? input.coordinatorOwner : undefined
    const session = await native.session(next.id, originalInputs.get(next.id), originalInputs.has(next.id) ? undefined : baseline.get(next.id), owner)
    // Every claim blocks, including old claims absent from process-local active:
    // native restart recovery can resume them after this asynchronous read.
    const historical = input.reusedCoordinator && session.historical === true
    // An inherited descendant untouched since the baseline (a move would advance its
    // sequence) keeps whatever Location it already had, such as an earlier worktree.
    if (session.projectID !== input.projectID || session.parentID !== next.parentID
      || !historical && (session.directory !== input.directory || session.workspaceID !== input.workspaceID)) throw new Error("Passage family moved")
    if (session.active || session.inbox || session.suspended || session.runningTools || !historical && !session.terminal) {
      if (!session.active && (session.suspended || !session.terminal && !session.inbox && !session.runningTools)) input.uncertain?.()
      return undefined
    }
    if (originalInputs.has(next.id) && session.terminal?.inputMessageID !== originalInputs.get(next.id)) { input.uncertain?.(); return undefined }
    // A pruned original input keeps the correlation uncertain; admission remains
    // recorded and the original prompt is never resent.
    family.push(session)
    const ids = await native.children(next.id)
    // The shared whole-family control ceiling: beyond it coverage is unknown, so the
    // passage stays pending (never archived, cursors unchanged), not assumed complete.
    if (seen.size + queue.length + ids.length > MAX_CONTROL_FAMILY_SESSIONS) throw new Error("Passage family capacity")
    children.set(next.id, ids)
    queue.push(...ids.map(id => ({ id, parentID: next.id, adopted: next.adopted })))
  }
  // A journal actor outside every walked native tree has moved.
  if (actorIDs.some(id => !seen.has(id))) throw new Error("Passage family moved")
  if (await native.requests([...seen])) return undefined
  if (mission.control?.pending.length) return undefined
  const outcome: PassageOutcome = mission.status === "completed" ? "completed"
    : family.some(session => session.failed && !session.historical) || mission.status === "failed" ? "failed" : "ended-without-report"
  // Recheck after the asynchronous journal and request reads. Unknown changes
  // park the same pending passage; they never admit another turn.
  for (const session of family) {
    if (!samePassageObservation(session, await native.session(session.id, originalInputs.get(session.id), originalInputs.has(session.id) ? undefined : baseline.get(session.id),
      adoptedIDs.has(session.id) && !originalInputs.has(session.id) ? input.coordinatorOwner : undefined))
      || !samePassageObservation(children.get(session.id), await native.children(session.id))) { input.uncertain?.(); return undefined }
  }
  if (await native.requests([...seen])) return undefined
  signal.throwIfAborted(); input.current(); native.assertCurrent()
  return { outcome, proof: { revision: mission.revision,
    familyDigest: stableToken(canonicalAuthority({ family, children: [...children] }, 16 * 1024 * 1024), 64) } }
}

