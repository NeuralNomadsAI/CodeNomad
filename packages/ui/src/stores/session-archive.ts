import { instances } from "./instances"
import { getRootClient } from "./opencode-client"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { sessions } from "./session-state"
import { serializeSessionAction } from "./session-action-queue"
import { fetchSessions } from "./session-api"
import { isSessionArchived } from "./session-tree"
import { captureBackendOperation } from "../lib/backend-operation"

/** The native flag is the only archive state. A completed write is followed by
 * the ordinary authoritative list refresh, retaining selection and transcripts. */
export function setSessionArchived(instanceId: string, sessionId: string, archived: boolean): Promise<void> {
  const owner = instances().get(instanceId)?.client
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const operation = captureBackendOperation(instanceId)
  const current = () => operation.current() && owner && instances().get(instanceId)?.client === owner
    && getOpenCodeInstanceGeneration(instanceId) === generation && sessions().get(instanceId)?.has(sessionId)
  return serializeSessionAction(instanceId, sessionId, async () => {
    if (!current()) throw new Error("Session archive owner changed")
    await getRootClient(instanceId).session.update({ sessionID: sessionId, archived }, { signal: AbortSignal.any([operation.signal, AbortSignal.timeout(15000)]) })
    if (!current()) return
    await fetchSessions(instanceId, { reset: true })
    const confirmed = sessions().get(instanceId)?.get(sessionId)
    if (current() && confirmed && isSessionArchived(confirmed) !== archived) throw new Error("Session archive not confirmed")
  })
}
