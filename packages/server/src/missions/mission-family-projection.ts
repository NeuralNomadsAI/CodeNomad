import type { SessionInfo } from "@opencode/client"
import { sameLocation } from "../opencode/compatibility/location"
import { missionTaskExecutionEvidence } from "./execution-evidence"
import { MISSION_MAX_ACTORS, MISSION_MAX_TASKS, type MissionActivityProjection, type MissionMap } from "./model"
import { MAX_MISSION_DESCENDANTS, type NativeMissionFamilyTree } from "./native-session-family"

type FamilyProjection = NonNullable<MissionActivityProjection["missions"][number]["family"]>

/** Joins caller-validated native observations to declared display context only.
 * Ordinary children never become actors, tasks, reports or control targets. */
export function projectMissionFamily(input: {
  mission: MissionMap
  trees: ReadonlyMap<string, NativeMissionFamilyTree>
  observed: boolean
}): FamilyProjection {
  const unknown: FamilyProjection = { state: "unknown", members: [] }
  const { mission, trees } = input
  if (!input.observed || !mission.actors.length || mission.actors.length > MISSION_MAX_ACTORS
    || mission.tasks.length > MISSION_MAX_TASKS) return unknown
  const declared = new Map(mission.actors.map(actor => [actor.sessionId, actor]))
  if (declared.size !== mission.actors.length) return unknown
  const sessions = new Map<string, SessionInfo>()
  for (const actor of mission.actors) {
    const tree = trees.get(actor.sessionId), root = tree?.get(actor.sessionId)
    if (!tree || !root || tree.size > MAX_MISSION_DESCENDANTS + 1 || root.id !== actor.sessionId
      || root.projectID !== mission.projectID || !sameLocation(root.location, actor.location)) return unknown
    for (const [id, session] of tree) {
      if (!id.trim() || id !== session.id || session.projectID !== root.projectID
        || !sameLocation(session.location, root.location)) return unknown
      // Each observed tree must terminate at its own actual root, independent of
      // catalog order. Overlapping actor trees must agree on every native identity.
      const ancestry = new Set<string>()
      let current = session
      while (current.id !== root.id) {
        if (ancestry.has(current.id) || !current.parentID || !tree.has(current.parentID)) return unknown
        ancestry.add(current.id)
        current = tree.get(current.parentID)!
      }
      const existing = sessions.get(id)
      if (existing && (existing.parentID !== session.parentID || existing.projectID !== session.projectID
        || !sameLocation(existing.location, session.location))) return unknown
      sessions.set(id, session)
    }
  }
  // A declared child fetched independently must also occur in its observed
  // parent's complete catalog; its saved actor row cannot fill a missing edge.
  for (const actor of mission.actors) {
    const tree = trees.get(actor.sessionId)!
    for (const session of sessions.values()) {
      if (session.parentID && tree.has(session.parentID) && !tree.has(session.id)) return unknown
    }
  }
  // Also reject cycles through overlapping roots (not visible in a single tree).
  for (const session of sessions.values()) {
    const seen = new Set<string>()
    let current: typeof session | undefined = session
    while (current) {
      if (seen.has(current.id)) return unknown
      seen.add(current.id)
      current = current.parentID ? sessions.get(current.parentID) : undefined
    }
  }
  const contexts = new Map<string, string | undefined>()
  for (const actor of mission.actors) {
    const candidates = mission.tasks.filter(task => task.actorSessionId === actor.sessionId).map(task => ({
      task, evidence: missionTaskExecutionEvidence(task),
    }))
    // No native invocation clock exists here: updatedAt can be a later report.
    // A unique live call wins over historical settled tasks; otherwise only a
    // unique evidenced task can be selected. Unknown/tied context stays absent.
    const invalid = candidates.some(({ task, evidence }) => evidence.nativeCall === "unknown"
      || (task.nativeExecution && task.nativeExecution.binding.parentSessionID !== sessions.get(actor.sessionId)!.parentID))
    const active = candidates.filter(({ evidence }) => evidence.nativeCall === "active")
    const known = candidates.filter(({ evidence }) => evidence.hasExecution)
    const selected = !invalid && (active.length === 1 ? active[0] : active.length === 0 && known.length === 1 ? known[0] : undefined)
    contexts.set(actor.sessionId, selected ? selected.task.key : undefined)
  }
  const members: FamilyProjection["members"] = []
  for (const session of sessions.values()) {
    let ancestor: typeof session | undefined = session
    while (ancestor && !declared.has(ancestor.id)) ancestor = ancestor.parentID ? sessions.get(ancestor.parentID) : undefined
    if (!ancestor) return unknown
    const taskKey = contexts.get(ancestor.id)
    members.push({ sessionId: session.id, ...(session.parentID ? { parentSessionId: session.parentID } : {}),
      actorSessionId: ancestor.id, ...(taskKey ? { taskKey } : {}), kind: declared.has(session.id) ? "declared" : "ordinary" })
  }
  return { state: "observed", members }
}
