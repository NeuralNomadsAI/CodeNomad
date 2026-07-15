import { invalidateSessionMessageLoad } from "../../../stores/session-state"

interface SessionMessageCache {
  clearSession: (sessionId: string, options?: { preserveScroll?: boolean; notify?: boolean }) => void
}

export function clearEvictedSessionMessages(instanceId: string, store: SessionMessageCache | undefined, sessionId: string): void {
  invalidateSessionMessageLoad(instanceId, sessionId)
  store?.clearSession(sessionId, { preserveScroll: true, notify: false })
}
