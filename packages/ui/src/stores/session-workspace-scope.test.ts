import assert from "node:assert/strict"
import { it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { tGlobal } from "../lib/i18n/index.tsx"
import { clearToastHistory, getToastHistory } from "../lib/notifications.tsx"
import { sdkManager } from "../lib/sdk-manager.ts"
import { storage, type OwnerBucket } from "../lib/storage.ts"
import { addInstance, addPermissionToQueue, removeInstance } from "./instances.ts"
import { destroyOpenCodeData } from "./opencode-data.ts"
import { preferences, updatePreferences } from "./preferences.tsx"
import { handlePermissionUpdated, handleSessionCompacted, handleSessionUpdate } from "./session-events.ts"
import {
  clearInstanceDeletedSessionAuthority, getInstanceSessionIndicatorStatusCached, getSessionThreads, sessions, setActiveSession,
  setSessionStatus, setSessions,
} from "./session-state.ts"
import { ensureWorktreesLoaded, reloadWorktrees } from "./worktrees.ts"

// An opened parent folder serves the sessions of nested repositories too; a
// held session located elsewhere stays out of its list and tab indicator. The
// scope follows the worktree inventory and either family order.
it("a parent folder's list and indicator show what its proxy serves, converging with the inventory", async () => {
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
    assert.deepEqual(listed(), ["nested", "own"], "the folder's proxy serves its nested repository's session")
    created("foreign", "/elsewhere")
    assert.deepEqual(listed(), ["nested", "own"], "a session located elsewhere stays held but out of the list")
    assert.equal(sessions().get(instanceId)?.has("foreign"), true)

    setSessionStatus(instanceId, "foreign", "working")
    assert.equal(getInstanceSessionIndicatorStatusCached(instanceId), "idle", "its activity does not light the parent's tab")
    // Moving the working session into the folder brings its activity with it, and out again.
    const relocate = (id: string, directory: string) => setSessions((previous) => {
      const held = new Map(previous.get(instanceId))
      held.set(id, { ...held.get(id)!, location: { directory } })
      return new Map(previous).set(instanceId, held)
    })
    relocate("foreign", "/home/projects/repo-c")
    assert.equal(getInstanceSessionIndicatorStatusCached(instanceId), "working")
    relocate("foreign", "/elsewhere")
    assert.equal(getInstanceSessionIndicatorStatusCached(instanceId), "idle")
    setSessionStatus(instanceId, "foreign", "idle")
    setSessionStatus(instanceId, "own", "working")
    assert.equal(getInstanceSessionIndicatorStatusCached(instanceId), "working")
    setSessionStatus(instanceId, "own", "idle")

    // A worktree registered after its session's event: the list follows the inventory.
    created("late", "/home-wt")
    assert.deepEqual(listed(), ["nested", "own"])
    inventory = async () => ({ isGitRepo: false, worktrees: [{ slug: "root", directory: "/home" }, { slug: "wt", directory: "/home-wt" }] })
    await reloadWorktrees(instanceId)
    assert.deepEqual(listed(), ["late", "nested", "own"])

    // Either family order: a session located elsewhere never joins the list,
    // neither as a local child's parent nor as a local parent's child.
    created("child", "/home", "parent")
    created("parent", "/elsewhere")
    created("early-child", "/elsewhere", "late-parent")
    setSessionStatus(instanceId, "early-child", "working")
    assert.equal(getInstanceSessionIndicatorStatusCached(instanceId), "idle")
    created("late-parent", "/home")
    assert.deepEqual(listed(), ["late", "late-parent", "nested", "own"])
    assert.equal(getInstanceSessionIndicatorStatusCached(instanceId), "idle", "a working child located elsewhere does not light the tab")
    setSessionStatus(instanceId, "early-child", "idle")

    // A session opened explicitly is shown where it was opened.
    setActiveSession(instanceId, "foreign")
    assert.equal(listed().includes("foreign"), true)
    setSessionStatus(instanceId, "foreign", "working")
    assert.equal(getInstanceSessionIndicatorStatusCached(instanceId), "working")
  } finally {
    serverApi.fetchWorktrees = original
    setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
    clearInstanceDeletedSessionAuthority(instanceId)
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
  }
})

// The parent folder holds a session its proxy does not serve, as after a move.
it("notices of a held session located elsewhere follow where it is shown", async () => {
  const parent = "workspace-scope-notice-parent", nested = "workspace-scope-notice-nested"
  const folders: Record<string, string> = { [parent]: "/home", [nested]: "/srv/projects/repo-b" }
  const originalWorktrees = serverApi.fetchWorktrees
  const originalStorage = { loadConfigOwner: storage.loadConfigOwner, loadStateOwner: storage.loadStateOwner,
    revalidateUiConfigOwner: storage.revalidateUiConfigOwner, patchConfigOwner: storage.patchConfigOwner }
  const originalRouting = preferences().notificationRouting
  let config: OwnerBucket = {}
  storage.loadConfigOwner = async () => ({})
  storage.loadStateOwner = async () => ({})
  storage.revalidateUiConfigOwner = async () => structuredClone(config)
  storage.patchConfigOwner = async (_owner, patch) => {
    config = { ...config, settings: { ...config.settings, ...(patch as OwnerBucket).settings } }
    return structuredClone(config)
  }
  serverApi.fetchWorktrees = (async (instanceId: string) => ({ isGitRepo: instanceId === nested,
    worktrees: [{ slug: "root", directory: folders[instanceId] }] })) as any
  let releaseClosing: (value: unknown) => void = () => {}
  const releaseReplaced: Array<(value: unknown) => void> = [], reads: string[] = []
  // Sessions unknown to the parent read as nested-repository sessions.
  const client = { session: { active: async () => ({}), get: async ({ sessionID }: { sessionID: string }) => {
    if (sessionID === "unreadable") throw new Error("503")
    reads.push(sessionID)
    if (sessionID === "closing") await new Promise((resolve) => { releaseClosing = resolve })
    if (sessionID === "replaced") await new Promise((resolve) => { releaseReplaced.push(resolve) })
    return { id: sessionID, title: sessionID, version: "1", projectID: "repo-b", location: { directory: folders[nested] }, time: { created: 1, updated: 1 } }
  } } } as any
  const open = async (id: string) => {
    ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
    addInstance({ id, folder: folders[id], port: 0, pid: 0, proxyPath: "", status: "ready", client })
    await ensureWorktreesLoaded(id)
  }
  const close = (id: string) => {
    setSessions((previous) => { const next = new Map(previous); next.delete(id); return next })
    clearInstanceDeletedSessionAuthority(id)
    removeInstance(id, { authoritative: false })
    sdkManager.destroyClientsForInstance(id)
  }
  const row = (id: string, directory: string) => [id, { id, instanceId: parent, parentId: null, title: id, status: "idle",
    location: { directory }, time: { created: 1, updated: 1 } }] as const
  const permission = { id: "per_nested", sessionID: "nested", action: "bash", resources: ["git status"], metadata: {} } as any
  const notices = (key: string, label: string) => getToastHistory().filter((item) => item.message === tGlobal(key, { label })
    || item.message === tGlobal(key, { label: `"${label}"` })).length
  let sequence = 0
  const compacted = (sessionID: string) => handleSessionCompacted(parent, { id: `evt_${++sequence}`, type: "session.compaction.ended",
    created: sequence, location: { directory: folders[parent] }, data: { sessionID } } as any)
  try {
    const routing = preferences().notificationRouting
    assert.equal(await updatePreferences({ notificationRouting: { ...routing,
      needsInput: { screen: false, history: true, system: false }, sessions: { screen: false, history: true, system: false } } }), true)
    clearToastHistory()
    await open(parent)
    setSessions((previous) => new Map(previous).set(parent, new Map([row("own", "/home"), row("nested", folders[nested])] as any)))

    // No open project lists the nested repository: the parent's dock shows its request, and notifies.
    addPermissionToQueue(parent, permission, folders[nested])
    handlePermissionUpdated(parent, { type: "permission.asked", data: permission } as any)
    assert.equal(notices("sessionEvents.notify.needsInput", "nested"), 1)

    // Once the nested project holds it, that project shows and announces it.
    await open(nested)
    addPermissionToQueue(nested, permission, folders[nested])
    handlePermissionUpdated(parent, { type: "permission.asked", data: permission } as any)
    assert.equal(notices("sessionEvents.notify.needsInput", "nested"), 1)

    // Compaction is announced for a session the list shows, never under the owning parent.
    compacted("nested")
    assert.equal(notices("sessionEvents.sessionCompactedToast", "nested"), 0)
    // Nor for a session the parent first learns of, once its metadata shows where it belongs.
    compacted("cold")
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(sessions().get(parent)?.has("cold"), true)
    assert.equal(notices("sessionEvents.sessionCompactedToast", "cold"), 0)
    // An unreadable session proves no scope: it is left to a project that can read it.
    compacted("unreadable")
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(notices("sessionEvents.sessionCompactedToast", "unreadable"), 0)
    compacted("own")
    assert.equal(notices("sessionEvents.sessionCompactedToast", "own"), 1)

    // A read begun before the client was replaced is discarded; a new event reads again.
    compacted("replaced")
    destroyOpenCodeData(parent)
    compacted("replaced")
    assert.equal(reads.filter((id) => id === "replaced").length, 2)
    for (const release of releaseReplaced) release(undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(sessions().get(parent)?.get("replaced")?.status, "working")

    // A project closed while an unknown session is read neither republishes nor announces it.
    compacted("closing")
    close(parent)
    releaseClosing(undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(sessions().has(parent), false)
    assert.equal(notices("sessionEvents.sessionCompactedToast", "closing"), 0)
  } finally {
    serverApi.fetchWorktrees = originalWorktrees
    close(nested)
    close(parent)
    clearToastHistory()
    try {
      assert.equal(await updatePreferences({ notificationRouting: originalRouting }), true)
    } finally {
      Object.assign(storage, originalStorage)
    }
  }
})
