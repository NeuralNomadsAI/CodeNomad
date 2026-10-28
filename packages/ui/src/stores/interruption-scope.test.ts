import assert from "node:assert/strict"
import { it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, addPermissionToQueue, removeInstance } from "./instances.ts"
import { getInterruptionQueue } from "./interruption-scope.ts"
import { ensureWorktreesLoaded } from "./worktrees.ts"

it("a nested repository's request is shown by the open project listing it, else by the parent folder that owns it (#1154)", async () => {
  const parent = "interruption-parent", nested = "interruption-nested"
  const folders: Record<string, string> = { [parent]: "/home", [nested]: "/home/projects/repo-b" }
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async (instanceId: string) => ({ isGitRepo: instanceId === nested,
    worktrees: [{ slug: "root", directory: folders[instanceId], directoryOnly: instanceId === parent }] }) as any
  const open = async (id: string) => {
    const client = { session: { active: async () => ({}) } } as any
    ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
    addInstance({ id, folder: folders[id], port: 0, pid: 0, proxyPath: "", status: "ready", client })
    await ensureWorktreesLoaded(id)
  }
  const close = (id: string) => { removeInstance(id, { authoritative: false }); sdkManager.destroyClientsForInstance(id) }
  const permission = (id: string) => ({ id, sessionID: `ses_${id}`, action: "bash", resources: ["git status"], metadata: {} }) as any
  try {
    await open(parent)
    await open(nested)
    addPermissionToQueue(parent, permission("own"), "/home")
    addPermissionToQueue(parent, permission("nested"), "/home/projects/repo-b")
    addPermissionToQueue(nested, permission("nested"), "/home/projects/repo-b")
    const shown = (id: string) => getInterruptionQueue(id).map(item => item.payload.id).sort()
    assert.deepEqual(shown(parent), ["own"], "the open nested project shows its own request")
    assert.deepEqual(shown(nested), ["nested"])
    close(nested)
    assert.deepEqual(shown(parent), ["nested", "own"], "without it, the owning parent folder keeps the request visible")
  } finally {
    serverApi.fetchWorktrees = original
    close(parent)
    close(nested)
  }
})
