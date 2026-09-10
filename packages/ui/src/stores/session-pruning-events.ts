import { PRUNING_EVENT, prunedEventSchema } from "../../../server/src/opencode/session-pruning/contract"
import { activeSessionId, invalidateSessionMessageLoad, sessions } from "./session-state"
import { loadMessages } from "./session-api"
import { getLogger } from "../lib/logger"
import { invalidateOpenCodeSessionContent } from "./opencode-data"

const refreshing = new Map<string, { dirty: boolean }>()
const log = getLogger("sse")

export function handlePruningEvent(instanceId: string, event: { type: string; data: unknown }): boolean {
  if (event.type !== PRUNING_EVENT) return false
  const parsed = prunedEventSchema.safeParse(event.data)
  if (!parsed.success) return true
  const sessionId = parsed.data.sessionID
  if (!sessions().get(instanceId)?.has(sessionId)) return true
  invalidateOpenCodeSessionContent(instanceId, sessionId)
  invalidateSessionMessageLoad(instanceId, sessionId)
  if (activeSessionId().get(instanceId) !== sessionId) return true
  const key = `${instanceId}\0${sessionId}`
  const pending = refreshing.get(key)
  if (pending) { pending.dirty = true; return true }
  const state = { dirty: false }
  refreshing.set(key, state)
  void (async () => {
    try {
      do {
        state.dirty = false
        if (activeSessionId().get(instanceId) !== sessionId || !sessions().get(instanceId)?.has(sessionId)) return
        await loadMessages(instanceId, sessionId, { force: true })
      } while (state.dirty)
    } catch (error) {
      log.warn("Failed to reload pruned history", { instanceId, sessionId, error })
    } finally { refreshing.delete(key) }
  })()
  return true
}
