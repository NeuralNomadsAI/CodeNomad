import { agentMemoryFor } from "../lib/agent-memory-api"
import { captureBackendOperation } from "../lib/backend-operation"
import { parseInstanceKey } from "../lib/backend-identity"
import { backendRegistry } from "./remote-backends"
import { memoryCleanupPrompt, type MemoryCleanupRequest } from "../lib/native/memory-cleanup-command"
import { instances } from "./instances"
import { createSession } from "./session-api"
import { sendMessage } from "./session-actions"
import { setActiveParentSession } from "./session-state"
import { selectInstanceTab } from "./app-tabs"

// Retain admitted IDs for this renderer lifetime, including uncertain failures.
const attempts = new Map<string, Promise<void>>()
export function runMemoryCleanup(request: MemoryCleanupRequest): Promise<void> {
  const previous = attempts.get(request.id)
  if (previous) return previous
  if (attempts.size >= 256) return Promise.reject(new Error("Cleanup admission limit reached"))
  const attempt = launchMemoryCleanup(request)
  attempts.set(request.id, attempt)
  return attempt
}

async function launchMemoryCleanup(request: MemoryCleanupRequest): Promise<void> {
  const operation = captureBackendOperation(request.workspaceId)
  const { backendId } = parseInstanceKey(request.workspaceId)
  const api = agentMemoryFor(request.workspaceId)
  const instance = instances().get(request.workspaceId)
  const client = instance?.client, folder = instance?.folder
  const assertCurrent = () => {
    const current = instances().get(request.workspaceId)
    if (!operation.current() || backendId !== "local" && (!request.serverId || backendRegistry.serverId(backendId) !== request.serverId)
      || !client || current?.status !== "ready" || current.client !== client || current.folder !== folder) throw new Error("Cleanup project unavailable")
  }
  assertCurrent()
  // Fresh checks before the sole non-idempotent creation; the proxy authorizes the captured directory.
  const settings = await api.settings()
  assertCurrent()
  if (!settings.enabled) throw new Error("Memory disabled")
  const result = await api.list(request.scope, { workspaceId: request.workspaceId, directory: request.directory })
  if (!result.cleanupDirectory || !result.cleanupWritable || !result.entries.some(entry => !entry.flagged)) throw new Error("Memory empty or unavailable")
  assertCurrent()
  const session = await createSession(request.workspaceId, undefined, { directory: request.directory })
  assertCurrent()
  if (session.location?.directory !== result.cleanupDirectory) throw new Error("Cleanup location changed")
  selectInstanceTab(request.workspaceId)
  setActiveParentSession(request.workspaceId, session.id)
  await sendMessage(request.workspaceId, session.id, memoryCleanupPrompt(request.scope))
}
