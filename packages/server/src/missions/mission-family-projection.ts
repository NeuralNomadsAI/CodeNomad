import type { SessionInfo } from "@opencode/client"
import { sameLocation } from "../opencode/compatibility/location"
import { missionTaskExecutionEvidence } from "./execution-evidence"
import type { MissionActivityProjection, MissionActor, MissionPanelMap } from "./model"
import { MAX_MISSION_DESCENDANTS, type NativeMissionFamilyTree } from "./native-session-family"

type FamilyProjection = NonNullable<MissionActivityProjection["missions"][number]["family"]>

/** Bounded per-actor task attribution, equivalent to scanning all its task candidates. */
export interface MissionFamilyTaskContext { taskKey?: string; parentSessionID?: string; invalid: boolean }
export type MissionFamilyContext = Pick<MissionPanelMap, "projectID" | "tasks"> & {
  actors: Pick<MissionActor, "sessionId" | "location">[]
  taskContexts?: Record<string, MissionFamilyTaskContext>
}

export function missionFamilyTaskContexts(tasks: MissionPanelMap["tasks"]): Record<string, MissionFamilyTaskContext> {
  const actors = new Map<string, { active: number; known: number; activeKey?: string; knownKey?: string; parent?: string; invalid: boolean }>()
  for (const task of tasks) {
    if (!task.actorSessionId) continue
    const value = actors.get(task.actorSessionId) ?? { active: 0, known: 0, invalid: false }
    const evidence = missionTaskExecutionEvidence(task), parent = task.nativeExecution?.binding.parentSessionID
    value.invalid ||= evidence.nativeCall === "unknown" || (parent !== undefined && value.parent !== undefined && parent !== value.parent)
    if (parent !== undefined) value.parent = parent
    if (evidence.nativeCall === "active") { value.active++; value.activeKey = task.key }
    if (evidence.hasExecution) { value.known++; value.knownKey = task.key }
    actors.set(task.actorSessionId, value)
  }
  return Object.fromEntries([...actors].map(([id, value]) => [id, { invalid: value.invalid,
    ...(value.parent === undefined ? {} : { parentSessionID: value.parent }),
    ...(!value.invalid && (value.active === 1 || value.active === 0 && value.known === 1)
      ? { taskKey: value.active === 1 ? value.activeKey : value.knownKey } : {}),
  }]))
}

/** Joins caller-validated native observations to declared display context only.
 * Ordinary children never become actors, tasks, reports or control targets. */
export function projectMissionFamily(input: {
  mission: MissionFamilyContext
  trees: ReadonlyMap<string, NativeMissionFamilyTree>
  observed: boolean
  /** Declared actors this refresh did not read (its actor budget): the family is partial without them. */
  unread?: ReadonlySet<string>
}): FamilyProjection {
  const unknown: FamilyProjection = { state: "unknown", members: [] }
  const { mission, trees } = input
  if (!input.observed || !mission.actors.length) return unknown
  const declared = new Map(mission.actors.map(actor => [actor.sessionId, actor]))
  if (declared.size !== mission.actors.length) return unknown
  // Every read actor needs its observed tree; any failure still clears the whole membership.
  const read = mission.actors.filter(actor => !input.unread?.has(actor.sessionId))
  if (!read.length) return unknown
  const sessions = new Map<string, SessionInfo>()
  for (const actor of read) {
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
  for (const actor of read) {
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
  const contexts = new Map<string, string | undefined>(), taskContexts = mission.taskContexts ?? missionFamilyTaskContexts(mission.tasks)
  for (const actor of read) {
    const context = taskContexts[actor.sessionId]
    contexts.set(actor.sessionId, context && !context.invalid
      && (context.parentSessionID === undefined || context.parentSessionID === sessions.get(actor.sessionId)!.parentID) ? context.taskKey : undefined)
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
  return { state: read.length < mission.actors.length ? "partial" : "observed", members }
}
