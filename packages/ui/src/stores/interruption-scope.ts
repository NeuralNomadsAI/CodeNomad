import type { Session } from "../types/session"
import { getDescendantSessionsFromMap } from "./session-tree"
import { getPendingRequestDirectory, getPendingRequestServerId, getPermissionQueue, instances } from "./instances"
import { getFormQueue } from "./forms"
import { getWorktrees } from "./worktrees"
import { isWorkspaceSessionDirectory } from "./workspace-session-scope"
import { isSessionInWorkspaceScope, sessions } from "./session-state"
import { getPermissionSessionId } from "../types/permission"
import { projectIdentity } from "../lib/project-identity"

function queuedRequests(instanceId: string) {
  const key = (item: Parameters<typeof getPendingRequestDirectory>[1]) => JSON.stringify([instanceId,
    projectIdentity(getPendingRequestDirectory(instanceId, item) ?? "", getPendingRequestServerId(instanceId, item)),
    item.kind, item.payload.sessionID, item.payload.id])
  return [
    ...getPermissionQueue(instanceId).map(payload => ({ key: key({ kind: "permission", payload }), kind: "permission" as const, payload })),
    ...getFormQueue(instanceId).map(payload => ({ key: key({ kind: "form", payload }), kind: "form" as const, payload })),
  ]
}

// An opened folder also owns the requests of nested checkouts of other
// repositories. Such a request is shown by another open project that lists its
// directory (its folder or a registered worktree) and holds it in its own queue;
// otherwise the owning folder shows it, so no request is left without a dock. A
// request of a session in this project's scope (its list, or the active
// session's family) is always shown with that session.
function requestSessionId(item: ReturnType<typeof queuedRequests>[number]): string | undefined {
  return item.kind === "permission" ? getPermissionSessionId(item.payload) : item.payload.sessionID
}

function shownHere(instanceId: string, item: ReturnType<typeof queuedRequests>[number]): boolean {
  if (getPendingRequestServerId(instanceId, item) !== (instances().get(instanceId)?.binding?.serverId ?? "local-shared")) return true
  const sessionId = requestSessionId(item)
  if (sessionId && sessions().get(instanceId)?.has(sessionId) && isSessionInWorkspaceScope(instanceId, sessionId)) return true
  const directory = getPendingRequestDirectory(instanceId, item)
  if (!directory) return true
  const instance = instances().get(instanceId)
  const serverId = instance?.binding?.serverId ?? "local-shared"
  const lists = (id: string) => {
    const other = instances().get(id)
    if ((other?.binding?.serverId ?? "local-shared") !== serverId) return false
    return serverId !== "local-shared" ? other?.binding?.directory === directory
      : isWorkspaceSessionDirectory(directory, other?.folder ?? "", getWorktrees(id))
  }
  if (lists(instanceId)) return true
  return ![...instances().keys()].some(id => id !== instanceId && lists(id)
    && queuedRequests(id).some(other => other.kind === item.kind && other.payload.id === item.payload.id
      && getPendingRequestServerId(id, other) === getPendingRequestServerId(instanceId, item)
      && requestSessionId(other) === sessionId && getPendingRequestDirectory(id, other) === directory))
}

/** The requests this project shows and counts; answering and recovery use the full native queues. */
export function getInterruptionQueue(instanceId: string) {
  return queuedRequests(instanceId).filter(item => shownHere(instanceId, item))
}

/** Whether this project's dock shows a request of the session. */
export function showsRequestOfSession(instanceId: string, sessionId: string): boolean {
  return getInterruptionQueue(instanceId).some(item => requestSessionId(item) === sessionId)
}

// Conversation affinity classifies provenance and automatic expansion only;
// the native pending queue remains authoritative for all answerable requests.
// Sessionless Forms are always explicitly expanded by the dock.
export function getInterruptionScope(instanceSessions: Map<string, Session> | undefined, sessionId: string | null | undefined) {
  if (sessionId === null) return new Set(["global"])
  if (!sessionId || sessionId === "info" || !instanceSessions?.has(sessionId)) return new Set<string>()
  return new Set([sessionId, ...getDescendantSessionsFromMap(instanceSessions, sessionId).map(session => session.id)])
}
