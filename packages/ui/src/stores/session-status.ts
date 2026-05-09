import type { Session, SessionRetryState, SessionStatus } from "../types/session"
import { getInstanceSessionIndicatorStatusCached, sessions } from "./session-state"
import { shouldSessionHoldWakeLock } from "./wake-lock-eligibility"
import { createSignal } from "solid-js"

export const IDLE_STATUS_VISIBILITY_MS = 5000

const [idleFadeStarts, setIdleFadeStarts] = createSignal<Map<string, number>>(new Map())

function idleFadeKey(instanceId: string, sessionId: string, idleSince: number): string {
  return `${instanceId}:${sessionId}:${idleSince}`
}

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

export function markSessionIdleFadeStarted(instanceId: string, sessionId: string): void {
  const session = getSession(instanceId, sessionId)
  if (!session || session.status !== "idle" || typeof session.idleSince !== "number") return
  const key = idleFadeKey(instanceId, sessionId, session.idleSince)
  setIdleFadeStarts((prev) => {
    if (prev.has(key)) return prev
    const next = new Map(prev)
    next.set(key, Date.now())
    return next
  })
}

export function clearSessionIdleFade(instanceId: string, sessionId: string, idleSince: number): void {
  const key = idleFadeKey(instanceId, sessionId, idleSince)
  setIdleFadeStarts((prev) => {
    if (!prev.has(key)) return prev
    const next = new Map(prev)
    next.delete(key)
    return next
  })
}

export function getSessionIdleFadeClass(instanceId: string, sessionId: string): string {
  const session = getSession(instanceId, sessionId)
  if (!session || session.status !== "idle" || typeof session.idleSince !== "number") return ""
  const startedAt = idleFadeStarts().get(idleFadeKey(instanceId, sessionId, session.idleSince))
  return typeof startedAt === "number" ? "session-status-fading" : ""
}

export function getInstanceIdleFadeClass(instanceId: string, now = Date.now(), keepUnseenSubagentIdleStatus = false): string {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return ""

  let hasVisibleIdle = false
  for (const session of instanceSessions.values()) {
    if (!session.id) continue
    if (!shouldShowIdleStatus(session, now, keepUnseenSubagentIdleStatus)) continue
    hasVisibleIdle = true
    if (!getSessionIdleFadeClass(instanceId, session.id)) return ""
  }

  return hasVisibleIdle ? "session-status-fading" : ""
}

export function shouldShowIdleStatus(
  session: Pick<Session, "status" | "idleSince" | "parentId"> | null | undefined,
  now = Date.now(),
  keepUnseenSubagentIdleStatus = false,
): boolean {
  if (!session || session.status !== "idle") {
    return false
  }

  if (typeof session.idleSince !== "number") {
    return false
  }

  if (session.parentId && !keepUnseenSubagentIdleStatus) {
    return now - session.idleSince < IDLE_STATUS_VISIBILITY_MS
  }

  return true
}

export function shouldShowSessionStatus(
  instanceId: string,
  sessionId: string,
  now = Date.now(),
  keepUnseenSubagentIdleStatus = false,
): boolean {
  const session = getSession(instanceId, sessionId)
  if (!session) {
    return false
  }

  if (session.pendingPermission || session.pendingQuestion || session.retry) {
    return true
  }

  return session.status !== "idle" || shouldShowIdleStatus(session, now, keepUnseenSubagentIdleStatus)
}

export function getRetrySeconds(next: number, now = Date.now()): number {
  return Math.max(0, Math.round((next - now) / 1000))
}

export type InstanceSessionIndicatorStatus = "permission" | SessionStatus

export function getInstanceSessionIndicatorStatus(
  instanceId: string,
  now = Date.now(),
  keepUnseenSubagentIdleStatus = false,
): InstanceSessionIndicatorStatus | null {
  const aggregated = getInstanceSessionIndicatorStatusCached(instanceId)
  if (aggregated !== "idle") {
    return aggregated
  }

  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) {
    return null
  }

  for (const session of instanceSessions.values()) {
    if (shouldShowIdleStatus(session, now, keepUnseenSubagentIdleStatus)) {
      return "idle"
    }
  }

  return null
}

export function isSessionBusy(instanceId: string, sessionId: string): boolean {
  const status = getSessionStatus(instanceId, sessionId)
  return status === "working" || status === "compacting"
}
