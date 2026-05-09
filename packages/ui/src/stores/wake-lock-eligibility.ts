import type { Session } from "../types/session"

export function shouldSessionHoldWakeLock(
  session: Pick<Session, "status" | "pendingPermission" | "pendingQuestion">,
): boolean {
  if (session.pendingPermission || session.pendingQuestion) {
    return false
  }

  return session.status === "working" || session.status === "compacting"
}
