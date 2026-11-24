export function shouldWaitForSavedSessionList(
  activeParentSessionId: string | null | undefined,
  activeSessionId: string | null | undefined,
  unavailableSessionIds: Set<string> | null,
) {
  if (!unavailableSessionIds) return false
  return [activeParentSessionId, activeSessionId]
    .some((sessionId) => Boolean(sessionId && sessionId !== "info" && unavailableSessionIds.has(sessionId)))
}
