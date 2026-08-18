type SessionPendingState = {
  id: string
  pendingPermission?: boolean
  pendingQuestion?: boolean
  pendingForm?: boolean
}

export function applySessionPendingState<T extends SessionPendingState>(
  sessions: Map<string, T>,
  permissionSessionIds: ReadonlySet<string>,
  questionSessionIds: ReadonlySet<string>,
  formSessionIds: ReadonlySet<string> = new Set(),
): Map<string, T> {
  let next = sessions

  for (const [sessionId, session] of sessions) {
    const pendingPermission = permissionSessionIds.has(sessionId)
    const pendingQuestion = questionSessionIds.has(sessionId)
    const pendingForm = formSessionIds.has(sessionId)
    if (
      session.pendingPermission === pendingPermission
      && session.pendingQuestion === pendingQuestion
      && session.pendingForm === pendingForm
    ) continue

    if (next === sessions) next = new Map(sessions)
    next.set(sessionId, { ...session, pendingPermission, pendingQuestion, pendingForm })
  }

  return next
}
