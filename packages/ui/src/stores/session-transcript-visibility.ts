/** Reference-counted transcript watch marks: sessions whose transcript a
 * mounted view — the active session's own view or a task renderer's child
 * transcript — is currently showing.
 *
 * Leaf module by design: both the transcript memory coordinator and the
 * instance layer's projection gates read these marks, so it must stay free
 * of store imports to keep their module graphs acyclic. */
type Authority = { signal: AbortSignal; current: () => boolean }
const visible = new Map<string, Set<Authority>>()
const key = (instanceId: string, sessionId: string) => `${instanceId}\u0000${sessionId}`

export function retainSessionTranscriptVisible(instanceId: string, sessionId: string, authority: Authority): () => boolean {
  const entryKey = key(instanceId, sessionId)
  if (authority.signal.aborted || !authority.current()) return () => false
  let watches = visible.get(entryKey)
  if (!watches) visible.set(entryKey, watches = new Set())
  // Each view owns a unique lease, even when views share the same authority.
  const lease = { signal: authority.signal, current: authority.current }
  watches.add(lease)
  const retained = watches
  return () => {
    if (visible.get(entryKey) !== retained || !retained.delete(lease)) return false
    if (!retained.size) visible.delete(entryKey)
    return true
  }
}

export function isSessionTranscriptVisible(instanceId: string, sessionId: string): boolean {
  const entryKey = key(instanceId, sessionId)
  const watches = visible.get(entryKey)
  if (!watches) return false
  for (const watch of watches) {
    if (watch.signal.aborted || !watch.current()) watches.delete(watch)
  }
  if (watches.size) return true
  visible.delete(entryKey)
  return false
}

export function clearSessionTranscriptVisible(instanceId: string, sessionId: string): void {
  visible.delete(key(instanceId, sessionId))
}

/** Drops every watch mark an instance owned; a destroyed instance has no views. */
export function clearInstanceTranscriptVisible(instanceId: string): void {
  for (const entryKey of visible.keys()) {
    if (entryKey.startsWith(`${instanceId}\u0000`)) visible.delete(entryKey)
  }
}
