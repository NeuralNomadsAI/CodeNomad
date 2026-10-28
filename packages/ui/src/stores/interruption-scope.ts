import type { Session } from "../types/session"
import { getDescendantSessionsFromMap } from "./session-tree"
import { getPendingRequestDirectory, getPermissionQueue, instances } from "./instances"
import { getFormQueue } from "./forms"
import { getWorktrees } from "./worktrees"
import { isWorkspaceSessionDirectory } from "./workspace-session-scope"

function queuedRequests(instanceId: string) {
  return [
    ...getPermissionQueue(instanceId).map(payload => ({ key: `permission:${payload.id}`, kind: "permission" as const, payload })),
    ...getFormQueue(instanceId).map(payload => ({ key: `form:${payload.id}`, kind: "form" as const, payload })),
  ]
}

// An opened folder also owns the requests of nested checkouts of other
// repositories. When another open project lists that directory (its folder or
// a registered worktree), the request is shown there only; otherwise the
// owning folder shows it, so no request is left without a dock.
function shownHere(instanceId: string, directory: string | undefined): boolean {
  if (!directory) return true
  const lists = (id: string) => isWorkspaceSessionDirectory(directory, instances().get(id)?.folder ?? "", getWorktrees(id))
  if (lists(instanceId)) return true
  return ![...instances().keys()].some(id => id !== instanceId && lists(id))
}

/** The requests this project shows and counts; answering and recovery use the full native queues. */
export function getInterruptionQueue(instanceId: string) {
  return queuedRequests(instanceId).filter(item => shownHere(instanceId, getPendingRequestDirectory(instanceId, item)))
}

// Conversation affinity classifies provenance and automatic expansion only;
// the native pending queue remains authoritative for all answerable requests.
// Sessionless Forms are always explicitly expanded by the dock.
export function getInterruptionScope(instanceSessions: Map<string, Session> | undefined, sessionId: string | null | undefined) {
  if (sessionId === null) return new Set(["global"])
  if (!sessionId || sessionId === "info" || !instanceSessions?.has(sessionId)) return new Set<string>()
  return new Set([sessionId, ...getDescendantSessionsFromMap(instanceSessions, sessionId).map(session => session.id)])
}
