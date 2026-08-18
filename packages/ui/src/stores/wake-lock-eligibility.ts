import type { Session } from "../types/session"

export function shouldSessionHoldWakeLock(
  session: Pick<Session, "status" | "pendingPermission" | "pendingQuestion" | "pendingForm">,
): boolean {
  if (session.pendingPermission || session.pendingQuestion || session.pendingForm) {
    return false
  }

  return session.status === "working" || session.status === "compacting"
}
