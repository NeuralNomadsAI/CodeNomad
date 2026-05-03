import type { Session, SessionRetryState, SessionStatus } from "../types/session"
import { getInstanceSessionIndicatorStatusCached, sessions } from "./session-state"
import { shouldSessionHoldWakeLock } from "./wake-lock-eligibility"

function getSession(instanceId: string, sessionId: string): Session | null {
  const instanceSessions = sessions().get(instanceId)
  return instanceSessions?.get(sessionId) ?? null
}

export function hasWakeLockEligibleWork(instanceId: string): boolean {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) {
    return false
  }

  for (const session of instanceSessions.values()) {
    if (shouldSessionHoldWakeLock(session)) {
      return true
    }
  }

  return false
}

export function getSessionStatus(instanceId: string, sessionId: string): SessionStatus {
  const session = getSession(instanceId, sessionId)
  if (!session) {
    return "idle"
  }
  return session.status ?? "idle"
}

export function getSessionRetry(instanceId: string, sessionId: string): SessionRetryState | null {
  const session = getSession(instanceId, sessionId)
  return session?.retry ?? null
}

export function getRetrySeconds(next: number, now = Date.now()): number {
  return Math.max(0, Math.round((next - now) / 1000))
}

export type InstanceSessionIndicatorStatus = "permission" | SessionStatus

export function getInstanceSessionIndicatorStatus(instanceId: string): InstanceSessionIndicatorStatus {
  return getInstanceSessionIndicatorStatusCached(instanceId)
}

export function isSessionBusy(instanceId: string, sessionId: string): boolean {
  const status = getSessionStatus(instanceId, sessionId)
  return status === "working" || status === "compacting"
}
