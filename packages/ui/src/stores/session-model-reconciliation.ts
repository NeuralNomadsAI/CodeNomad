import { getLogger } from "../lib/logger"
import { instances } from "./instances"
import { getRootClient } from "./opencode-client"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { serializeSessionAction } from "./session-action-queue"
import { sessions, withSession } from "./session-state"

const log = getLogger("actions")
const pending = new Map<string, { dirty: boolean; current: () => boolean; promise: Promise<void> }>()

// SSE echoes can arrive after a newer HTTP selection has already succeeded.
// Treat them as invalidations, not current selection values. Reading on the
// admission queue also prevents a read of pre-mutation state during a switch.
export function reconcileSessionModel(instanceId: string, sessionId: string): Promise<void> {
  const key = `${instanceId}\0${sessionId}`
  const previous = pending.get(key)
  if (previous?.current()) {
    previous.dirty = true
    return previous.promise
  }
  const owner = instances().get(instanceId)?.client
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const current = () => Boolean(owner && instances().get(instanceId)?.client === owner &&
    getOpenCodeInstanceGeneration(instanceId) === generation)
  const state = { dirty: false, current, promise: Promise.resolve() }
  state.promise = serializeSessionAction(instanceId, sessionId, async () => {
    do {
      state.dirty = false
      const captured = sessions().get(instanceId)?.get(sessionId)
      if (!current() || !captured) return
      const info = await getRootClient(instanceId).session.get({ sessionID: sessionId }, { signal: AbortSignal.timeout(8000) })
      if (!current()) return
      if (state.dirty) continue
      withSession(instanceId, sessionId, session => {
        // Session replacement or another authoritative refresh owns its newer
        // selection; never resurrect a removed session or overwrite that value.
        if (session.model !== captured.model || !info.model) return false
        session.model = { providerId: info.model.providerID, modelId: info.model.id }
      })
    } while (state.dirty)
  }).catch(error => {
    log.warn("Failed to reconcile session model", { instanceId, sessionId, error })
  }).finally(() => {
    if (pending.get(key) === state) pending.delete(key)
  })
  pending.set(key, state)
  return state.promise
}
