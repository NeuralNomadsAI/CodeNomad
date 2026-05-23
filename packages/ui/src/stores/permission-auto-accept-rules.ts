import type { Session } from "../types/session"

export function isYoloEligibleSubagentSession(session: Pick<Session, "parentId" | "revert">) {
  return Boolean(session.parentId && !session.revert)
}

export function shouldSubagentInheritPermissionAutoAcceptValue(
  session: Pick<Session, "parentId" | "revert">,
  subagentsInheritYoloMode: boolean,
  parentYoloModeEnabled: boolean,
) {
  return Boolean(
    subagentsInheritYoloMode &&
      isYoloEligibleSubagentSession(session) &&
      session.parentId &&
      parentYoloModeEnabled,
  )
}
