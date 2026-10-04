import type { MissionActor } from "../../../server/src/api-types"
import { selectMissionFamilyMembers, type MissionObservedFamily } from "./mission-attention-model"

export interface MissionConversationNode {
  sessionId: string
  actorSessionId: string
  actor?: MissionActor
  /** Observed parent within this displayed forest; external ancestors stay private. */
  parentSessionId?: string
  children: MissionConversationNode[]
}

/** Display-only forest. The native observation, never the local session catalogue,
 * supplies ancestry. Invalid observations fail closed while declarations persist. */
export function missionConversationTree(actors: readonly MissionActor[], family?: MissionObservedFamily) {
  const declared = new Map(actors.filter(actor => actor.sessionId && actor.sessionId !== "global")
    .map(actor => [actor.sessionId, actor]))
  const ordered = [...declared.values()].sort((a, b) => Number(b.kind === "coordinator") - Number(a.kind === "coordinator"))
  const fallback = () => ({ known: false, count: ordered.length, roots: ordered.map(actor => ({
    sessionId: actor.sessionId, actorSessionId: actor.sessionId, actor, children: [],
  } as MissionConversationNode)) })
  if (family?.state !== "observed" || family.members.length > 8 * 33) return fallback()
  const ordinary = selectMissionFamilyMembers(ordered, family)
  const members = new Map(family.members.map(member => [member.sessionId, member]))
  if (members.size !== family.members.length || ordinary.length !== family.members.filter(member => member.kind === "ordinary").length) return fallback()
  if (declared.size !== actors.length || ordered.some(actor => members.get(actor.sessionId)?.kind !== "declared")) return fallback()
  const nodes = new Map<string, MissionConversationNode>(ordered.map(actor => [actor.sessionId, {
    sessionId: actor.sessionId, actorSessionId: actor.sessionId, actor, children: [],
  }]))
  for (const member of ordinary.slice().sort((a, b) => a.sessionId.localeCompare(b.sessionId))) nodes.set(member.sessionId, {
    sessionId: member.sessionId, actorSessionId: member.actorSessionId, children: [],
  })
  for (const member of family.members) {
    if ((member.kind !== "declared" && member.kind !== "ordinary") || !nodes.has(member.sessionId)
      || member.kind === "declared" && (!declared.has(member.sessionId) || member.actorSessionId !== member.sessionId)) return fallback()
    // A declared actor's native parent may lie outside this Mission boundary.
    // Ordinary membership must still reach a declared actor inside the forest.
    if (member.kind === "ordinary" && member.parentSessionId && !nodes.has(member.parentSessionId)) return fallback()
    // Include declared parent links too; the ordinary selector alone cannot
    // detect a cycle passing through a declared actor.
    const seen = new Set([member.sessionId])
    let parent = member.parentSessionId
    while (parent) {
      if (seen.has(parent)) return fallback()
      seen.add(parent)
      parent = members.get(parent)?.parentSessionId
    }
    nodes.get(member.sessionId)!.parentSessionId = member.parentSessionId && nodes.has(member.parentSessionId)
      ? member.parentSessionId : undefined
  }
  const roots: MissionConversationNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentSessionId && nodes.get(node.parentSessionId)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return { known: true, count: nodes.size, roots }
}

export type ConversationRuntimeState = "unknown" | "running" | "idle" | "compacting" | "permission" | "form"

/** Exact-session status only. A family's aggregate never supplies child status. */
export function missionConversationRuntimeState(session?: {
  status: "idle" | "working" | "compacting"
  runtimeStatusKnown?: boolean
  pendingForm?: boolean
  pendingPermission?: boolean
}): ConversationRuntimeState {
  if (session?.pendingPermission) return "permission"
  if (session?.pendingForm) return "form"
  if (!session?.runtimeStatusKnown) return "unknown"
  return session.status === "working" ? "running" : session.status
}
