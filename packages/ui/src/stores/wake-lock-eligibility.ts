import type { Session } from "../types/session"
import type { WindowContextKind } from "../lib/runtime-env"

export function shouldAppHoldWakeLock(keepComputerAwake: boolean, hasEligibleWork: boolean, windowContext: WindowContextKind): boolean {
  return (windowContext === "local" && keepComputerAwake) || hasEligibleWork
}

export function shouldSessionHoldWakeLock(
  session: Pick<Session, "status" | "pendingPermission" | "pendingForm">,
): boolean {
  if (session.pendingPermission || session.pendingForm) {
    return false
  }

  return session.status === "working" || session.status === "compacting"
}
