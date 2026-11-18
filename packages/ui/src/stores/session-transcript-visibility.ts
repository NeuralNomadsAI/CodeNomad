/** Reference-counted transcript watch marks: sessions whose transcript a
 * mounted view — the active session's own view or a task renderer's child
 * transcript — is currently showing.
 *
 * Leaf module by design: both the transcript memory coordinator and the
 * instance layer's projection gates read these marks, so it must stay free
 * of store imports to keep their module graphs acyclic. */
const visible = new Map<string, number>()
const key = (instanceId: string, sessionId: string) => `${instanceId}\u0000${sessionId}`

export function retainSessionTranscriptVisible(instanceId: string, sessionId: string): void {
  const entryKey = key(instanceId, sessionId)
  visible.set(entryKey, (visible.get(entryKey) ?? 0) + 1)
}

/** Drops one watch; returns whether other watchers keep the session visible. */
export function releaseSessionTranscriptVisible(instanceId: string, sessionId: string): boolean {
  const entryKey = key(instanceId, sessionId)
  const count = (visible.get(entryKey) ?? 0) - 1
  if (count > 0) visible.set(entryKey, count)
  else visible.delete(entryKey)
  return count > 0
}

export function isSessionTranscriptVisible(instanceId: string, sessionId: string): boolean {
  return visible.has(key(instanceId, sessionId))
}

/** Drops every watch mark an instance owned; a destroyed instance has no views. */
export function clearInstanceTranscriptVisible(instanceId: string): void {
  for (const entryKey of visible.keys()) {
    if (entryKey.startsWith(`${instanceId}\u0000`)) visible.delete(entryKey)
  }
}
