import { getLogger } from "../lib/logger"
import { getAttachments } from "./attachments"
import { instances } from "./instances"
import { messageStoreBus } from "./message-v2/bus"
import { getOpenCodeInstanceGeneration, getOpenCodeMessageRevision, getOpenCodeMutationRevision } from "./opencode-data"
import { getRootClient } from "./opencode-client"
import { deleteSession } from "./session-api"
import { getChildSessions, getSessionDraftPrompt, loading, sessions } from "./session-state"
import { isSessionPinned, type Session } from "../types/session"

// A timestamp or an empty resident transcript is never proof of an empty native
// session. Keep this destructive admission separate from the explicit deep-clean
// command, which also offers to remove completed subagents and unused forks.
export async function cleanupBlankSession(instanceId: string, sessionId: string): Promise<boolean> {
  const instanceClient = instances().get(instanceId)?.client
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!instanceClient || !session) return false
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const messageRevision = getOpenCodeMessageRevision(instanceId, sessionId)
  const mutationRevision = getOpenCodeMutationRevision(instanceId, sessionId)
  const store = messageStoreBus.getOrCreate(instanceId)
  const revision = store.getSessionRevision(sessionId)
  const current = () => instances().get(instanceId)?.client === instanceClient
    && getOpenCodeInstanceGeneration(instanceId) === generation
    && sessions().get(instanceId)?.get(sessionId) === session
    && getOpenCodeMessageRevision(instanceId, sessionId) === messageRevision
    && getOpenCodeMutationRevision(instanceId, sessionId) === mutationRevision
    && store.getSessionRevision(sessionId) === revision
    && session.status === "idle"
    && !isSessionPinned(session)
    && !session.pendingPermission && !session.pendingForm
    && !session.generationRecovery && session.generationAdmissionToken === undefined
    && !session.revert && !session.fork
    && !loading().deletingSession.get(instanceId)?.has(sessionId)
    && !getSessionDraftPrompt(instanceId, sessionId)
    && getAttachments(instanceId, sessionId).length === 0
    && getChildSessions(instanceId, sessionId).length === 0
    && store.getSessionMessageIds(sessionId).length === 0
  if (!current()) return false

  try {
    const client = getRootClient(instanceId)
    // No type/revert/visibility filter: even a hidden system message or a
    // staged-away prompt means the session is not blank. Do not use display caches.
    const messages = await client.message.list({ sessionID: sessionId, limit: 1 })
    if (!current() || !Array.isArray(messages.data) || messages.data.length || messages.cursor?.next) return false

    const info = await client.session.get({ sessionID: sessionId })
    if (!current() || info.id !== sessionId || !info.projectID
      || info.projectID !== session.projectID || info.location.directory !== session.location.directory
      || info.revert || info.fork || isSessionPinned(info as unknown as Session)) return false
    const [inbox, children, active] = await Promise.all([
      client.session.inbox.list({ sessionID: sessionId }),
      client.session.list({ parentID: sessionId, project: info.projectID, limit: 1 }),
      client.session.active(),
    ])
    if (!Array.isArray(inbox) || inbox.length
      || !Array.isArray(children.data) || children.data.length || children.cursor?.next
      || !active || typeof active !== "object" || Array.isArray(active) || active[sessionId]) return false

    // Other clients may have sent while ancillary reads were pending, before
    // their SSE reached this window. Refresh the empty-message proof last.
    if (!current()) return false
    const latest = await client.message.list({ sessionID: sessionId, limit: 1 })
    if (!Array.isArray(latest.data) || latest.data.length || latest.cursor?.next) return false

    // Recheck local activity, drafts and connection authority immediately before
    // dispatch. No asynchronous work between this check and deleteSession's call.
    if (!current()) return false
    await deleteSession(instanceId, sessionId)
    return true
  } catch (error) {
    // An unavailable/failed read is unknown, never empty. Failed deletions also
    // must not contribute to the cleanup toast's success count.
    getLogger("session").warn("Skipping unconfirmed blank session cleanup", { instanceId, sessionId, error })
    return false
  }
}
