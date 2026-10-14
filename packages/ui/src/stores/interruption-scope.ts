import type { Session } from "../types/session"
import { getDescendantSessionsFromMap } from "./session-tree"
import { getPermissionQueue } from "./instances"
import { getFormQueue } from "./forms"

export function getInterruptionQueue(instanceId: string) {
  return [
    ...getPermissionQueue(instanceId).map(payload => ({ key: `permission:${payload.id}`, kind: "permission" as const, payload })),
    ...getFormQueue(instanceId).map(payload => ({ key: `form:${payload.id}`, kind: "form" as const, payload })),
  ]
}

// Conversation affinity classifies provenance and automatic expansion only;
// the native pending queue remains authoritative for all answerable requests.
// Sessionless Forms are always explicitly expanded by the dock.
export function getInterruptionScope(instanceSessions: Map<string, Session> | undefined, sessionId: string | null | undefined) {
  if (sessionId === null) return new Set(["global"])
  if (!sessionId || sessionId === "info" || !instanceSessions?.has(sessionId)) return new Set<string>()
  return new Set([sessionId, ...getDescendantSessionsFromMap(instanceSessions, sessionId).map(session => session.id)])
}
