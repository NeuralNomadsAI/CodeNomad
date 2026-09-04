import type { Session } from "../types/session"

export function shouldSessionHoldWakeLock(
  session: Pick<Session, "status" | "pendingPermission" | "pendingForm">,
): boolean {
  if (session.pendingPermission || session.pendingForm) {
    return false
  }

  return session.status === "working" || session.status === "compacting"
}
