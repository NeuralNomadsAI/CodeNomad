import { backendOf } from "../../../src/lib/backend-client"
import { parseInstanceKey } from "../../../src/lib/backend-identity"
import { addInstance } from "../../../src/stores/instances"
import { setSessions } from "../../../src/stores/session-state"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { runMemoryCleanup } from "../../../src/stores/agent-memory-cleanup"

export const releaseCleanupOpener = (instanceId: string) => backendOf(instanceId).sdk.destroyClientsForInstance(instanceId)

/** Simulated opener SDK; the cleanup action and backend memory HTTP remain real. */
export function installCleanupOpener(instanceId: string) {
  const calls: string[] = []
  const session = (id: string) => ({ id, title: id, parentID: null, agent: "", model: null, projectID: "project",
    location: { directory: "/homonym" }, time: { created: 1, updated: 1 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  const client = {
    model: { default: async () => ({ data: null }) },
    session: {
      create: async () => { calls.push("create"); return session("cleanup-new") },
      prompt: async () => { calls.push("prompt") },
      switchAgent: async () => {}, switchModel: async () => {},
      instructions: { entry: { put: async () => {}, remove: async () => {} } },
      list: async () => ({ data: [], cursor: {} }), get: async () => session("cleanup-new"),
      active: async () => ({}), inbox: { list: async () => [] },
    }, message: { list: async () => ({ data: [], cursor: {} }) },
  } as any
  const { backendId, workspaceId } = parseInstanceKey(instanceId)
  ;(backendOf(instanceId).sdk as any).clients.set(`${instanceId}:/workspaces/${workspaceId}/instance`, client)
  addInstance({ id: instanceId, ...(backendId === "local" ? {} : { backendId }), folder: "/homonym", port: 0, pid: 0,
    proxyPath: `/workspaces/${workspaceId}/instance`, status: "ready", client })
  setSessions(previous => new Map(previous).set(instanceId, new Map()))
  messageStoreBus.getOrCreate(instanceId)
  ;(window as any).fixtureRunCleanup = runMemoryCleanup
  ;(window as any).cleanupCalls = calls
}
