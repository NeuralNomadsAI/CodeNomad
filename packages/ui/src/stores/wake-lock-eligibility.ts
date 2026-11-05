import type { Session } from "../types/session"

export function shouldAppHoldWakeLock(keepComputerAwake: boolean, hasEligibleWork: boolean): boolean {
  return keepComputerAwake || hasEligibleWork
}

export function shouldSessionHoldWakeLock(
  session: Pick<Session, "status" | "pendingPermission" | "pendingForm">,
): boolean {
  if (session.pendingPermission || session.pendingForm) {
    return false
  }

  return session.status === "working" || session.status === "compacting"
}
