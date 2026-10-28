import assert from "node:assert/strict"
import { it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { handleSessionUpdate } from "./session-events.ts"
import {
  clearInstanceDeletedSessionAuthority, getInstanceSessionIndicatorStatusCached, getSessionThreads, sessions, setActiveSession,
  setSessionStatus, setSessions,
} from "./session-state.ts"
import { ensureWorktreesLoaded, reloadWorktrees } from "./worktrees.ts"

// #1154: an opened parent folder also holds the sessions of nested repositories
// (it receives their live events); its list and tab indicator show only the
// inventory's scope, which follows the worktree inventory and either family order.
it("a parent folder's list and indicator show only its workspace scope, converging with the inventory", async () => {
  const instanceId = "workspace-scope-parent"
  const client = { session: { active: async () => ({}) } } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/home", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  const original = serverApi.fetchWorktrees
  let inventory: () => Promise<any> = async () => { throw new Error("inventory unavailable") }
  serverApi.fetchWorktrees = (() => inventory()) as any
  const created = (sessionID: string, directory: string, parentID?: string) => handleSessionUpdate(instanceId, {
    id: `created-${sessionID}`, type: "session.created", created: 1, location: { directory },
    data: { sessionID, title: sessionID, version: "1", ...(parentID ? { parentID } : {}), location: { directory } },
  } as any)
  const listed = () => {
    const ids: string[] = []
    const walk = (threads: ReturnType<typeof getSessionThreads>) => { for (const thread of threads) { ids.push(thread.session.id); walk(thread.children) } }
    walk(getSessionThreads(instanceId))
    return ids.sort()
  }
  try {
    await ensureWorktreesLoaded(instanceId)
    created("own", "/home")
    created("nested", "/home/projects/repo-b")
    assert.deepEqual(listed(), ["nested", "own"], "a failed inventory is no proof that a session is foreign")

    inventory = async () => ({ isGitRepo: false, worktrees: [{ slug: "root", directory: "/home" }] })
    await reloadWorktrees(instanceId)
    assert.deepEqual(listed(), ["own"], "the nested repository's session stays held but out of the list")
    assert.equal(sessions().get(instanceId)?.has("nested"), true)

    setSessionStatus(instanceId, "nested", "working")
    assert.equal(getInstanceSessionIndicatorStatusCached(instanceId), "idle", "its activity does not light the parent's tab")
    setSessionStatus(instanceId, "own", "working")
    assert.equal(getInstanceSessionIndicatorStatusCached(instanceId), "working")
    setSessionStatus(instanceId, "own", "idle")

    // A worktree registered after its session's event: the list follows the inventory.
    created("late", "/home-wt")
    assert.deepEqual(listed(), ["own"])
    inventory = async () => ({ isGitRepo: false, worktrees: [{ slug: "root", directory: "/home" }, { slug: "wt", directory: "/home-wt" }] })
    await reloadWorktrees(instanceId)
    assert.deepEqual(listed(), ["late", "own"])

    // Either family order: a local child keeps its parent from elsewhere, and a
    // child from elsewhere joins its local parent.
    created("child", "/home", "parent")
    created("parent", "/elsewhere")
    created("early-child", "/elsewhere", "late-parent")
    created("late-parent", "/home")
    assert.deepEqual(listed(), ["child", "early-child", "late", "late-parent", "own", "parent"])

    // A session opened explicitly is shown where it was opened.
    setActiveSession(instanceId, "nested")
    assert.equal(listed().includes("nested"), true)
    setSessionStatus(instanceId, "nested", "working")
    assert.equal(getInstanceSessionIndicatorStatusCached(instanceId), "working")
  } finally {
    serverApi.fetchWorktrees = original
    setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
    clearInstanceDeletedSessionAuthority(instanceId)
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
  }
})
