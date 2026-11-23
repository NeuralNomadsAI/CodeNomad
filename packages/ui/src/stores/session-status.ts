import type { Session, SessionRetryState, SessionStatus } from "../types/session"
import { getInstanceSessionIndicatorStatusCached, isSessionInWorkspaceScope, sessions } from "./session-state"
import { shouldSessionHoldWakeLock } from "./wake-lock-eligibility"
import { createSignal } from "solid-js"
import { sessionIndicatorRows } from "./session-projection"

export const IDLE_STATUS_VISIBILITY_MS = 5000

const [idleFades, setIdleFades] = createSignal<Map<string, number>>(new Map())

function idleFadeKey(instanceId: string, sessionId: string): string {
  return `${instanceId}:${sessionId}`
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

  for (const session of sessionIndicatorRows(instanceSessions).values()) {
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
  const idleSince = session.idleSince
  const key = idleFadeKey(instanceId, sessionId)
  setIdleFades((prev) => {
    if (prev.get(key) === idleSince) return prev
    const next = new Map(prev)
    next.set(key, idleSince)
    return next
  })
}

export function clearSessionIdleFade(instanceId: string, sessionId: string, idleSince?: number): void {
  const key = idleFadeKey(instanceId, sessionId)
  setIdleFades((prev) => {
    if (!prev.has(key) || (idleSince !== undefined && prev.get(key) !== idleSince)) return prev
    const next = new Map(prev)
    next.delete(key)
    return next
  })
}

export function idleFadeClassForSession(instanceId: string, session: Session | null): string {
  if (!session || session.status !== "idle") return ""
  const fadingIdleSince = idleFades().get(idleFadeKey(instanceId, session.id))
  if (fadingIdleSince === undefined) return ""
  if (typeof session.idleSince === "number" && session.idleSince !== fadingIdleSince) return ""
  return "session-status-fading"
}

function* idleIndicatorRows(instanceId: string, rows: Map<string, Session>): Iterable<Session> {
  const candidates = sessionIndicatorRows(rows)
  yield* candidates.values()
  // A fade may briefly outlive the cleared unread marker.
  const prefix = `${instanceId}:`
  for (const key of idleFades().keys()) {
    if (!key.startsWith(prefix)) continue
    const id = key.slice(prefix.length)
    const row = rows.get(id)
    if (row && !candidates.has(id)) yield row
  }
}

export function shouldShowIdleStatus(
  session: Pick<Session, "status" | "idleSince" | "parentId"> | null | undefined,
  now = Date.now(),
  keepUnseenSubagentIdleStatus = false,
  wakeAt?: (deadline: number) => void,
): boolean {
  if (!session || session.status !== "idle") {
    return false
  }

  if (typeof session.idleSince !== "number") {
    return false
  }

  if (session.parentId && !keepUnseenSubagentIdleStatus) {
    const deadline = session.idleSince + IDLE_STATUS_VISIBILITY_MS
    if (!(deadline > now)) return false
    wakeAt?.(deadline)
  }

  return true
}

export function shouldShowSessionStatusForRow(
  instanceId: string,
  session: Session | null,
  now: number,
  keepUnseenSubagentIdleStatus: boolean,
  wakeAt?: (deadline: number) => void,
): boolean {
  if (!session) {
    return false
  }

  if (session.pendingPermission || session.pendingForm || session.retry) {
    return true
  }

  if (idleFadeClassForSession(instanceId, session)) {
    return true
  }

  return session.status !== "idle" || shouldShowIdleStatus(session, now, keepUnseenSubagentIdleStatus, wakeAt)
}

export function getRetrySeconds(next: number, now = Date.now(), wakeAt?: (deadline: number) => void): number {
  const seconds = Math.max(0, Math.round((next - now) / 1000))
  // Math.round keeps the higher count at exactly the half-second boundary.
  if (seconds > 0) wakeAt?.(Math.floor(next - (seconds - 0.5) * 1000) + 1)
  return seconds
}

export type InstanceSessionIndicatorStatus = "permission" | SessionStatus

export function getInstanceStatusPresentation(
  instanceId: string,
  now: number,
  keepUnseenSubagentIdleStatus: boolean,
  wakeAt?: (deadline: number) => void,
): { status: InstanceSessionIndicatorStatus | null; fade: string } {
  const aggregated = getInstanceSessionIndicatorStatusCached(instanceId)
  if (aggregated !== "idle") {
    return { status: aggregated, fade: "" }
  }

  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) {
    return { status: null, fade: "" }
  }

  let fading = false
  let lastDeadline = 0
  for (const session of idleIndicatorRows(instanceId, instanceSessions)) {
    if (!isSessionInWorkspaceScope(instanceId, session.id)) continue
    if (idleFadeClassForSession(instanceId, session)) {
      fading = true
      continue
    }
    let deadline = 0
    if (shouldShowIdleStatus(session, now, keepUnseenSubagentIdleStatus, value => { deadline = value })) {
      if (!deadline) return { status: "idle", fade: "" }
      lastDeadline = Math.max(lastDeadline, deadline)
    }
  }

  if (lastDeadline) {
    wakeAt?.(lastDeadline)
    return { status: "idle", fade: "" }
  }
  return fading ? { status: "idle", fade: "session-status-fading" } : { status: null, fade: "" }
}

export function isSessionBusy(instanceId: string, sessionId: string): boolean {
  const status = getSessionStatus(instanceId, sessionId)
  return status === "working" || status === "compacting"
}
