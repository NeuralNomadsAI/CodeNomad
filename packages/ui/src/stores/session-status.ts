import type { Session, SessionStatus } from "../types/session"
import { getInstanceSessionIndicatorStatusCached, sessions } from "./session-state"

function getSession(instanceId: string, sessionId: string): Session | null {
  const instanceSessions = sessions().get(instanceId)
  return instanceSessions?.get(sessionId) ?? null
}

export function getSessionStatus(instanceId: string, sessionId: string): SessionStatus {
  const session = getSession(instanceId, sessionId)
  if (!session) {
    return "idle"
  }
  return session.status ?? "idle"
}

export type InstanceSessionIndicatorStatus = "permission" | SessionStatus

export function getInstanceSessionIndicatorStatus(instanceId: string): InstanceSessionIndicatorStatus {
  return getInstanceSessionIndicatorStatusCached(instanceId)
}

export function isSessionBusy(instanceId: string, sessionId: string): boolean {
  const status = getSessionStatus(instanceId, sessionId)
  return status === "working" || status === "compacting"
}
