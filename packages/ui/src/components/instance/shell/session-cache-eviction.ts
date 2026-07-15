interface SessionMessageCache {
  clearSession: (sessionId: string, options?: { preserveScroll?: boolean; notify?: boolean }) => void
}

export function clearEvictedSessionMessages(store: SessionMessageCache | undefined, sessionId: string): void {
  store?.clearSession(sessionId, { preserveScroll: true })
}
