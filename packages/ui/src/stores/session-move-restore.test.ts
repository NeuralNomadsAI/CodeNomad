import assert from "node:assert/strict"
import { it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { handleNativeSessionEvent } from "./session-events.ts"
import { getSessionListIds, prependSessionListId, sessions, setSessions } from "./session-state.ts"
import { ensureWorktreesLoaded, setWorktreeSlugForParentSession } from "./worktrees.ts"

function setup(id: string, folder: string) {
  const session = {
    id: "restored", instanceId: id, parentId: null, title: "restored", agent: "build",
    model: { providerId: "provider", modelId: "model" }, status: "idle", retry: null,
    idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
    location: { directory: folder }, time: { created: 1, updated: 1 },
  } as Session
  const client = { session: {
    active: async () => ({}),
    list: async () => ({ data: [{ ...session, parentID: undefined }] }),
  } } as any
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder, port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions((previous) => new Map(previous).set(id, new Map([[session.id, session]])))
  prependSessionListId(id, session.id)
  return { session, client, cleanup() {
    messageStoreBus.unregisterInstance(id)
    setSessions((previous) => { const next = new Map(previous); next.delete(id); return next })
    removeInstance(id, { authoritative: false })
    sdkManager.destroyClientsForInstance(id)
  } }
}

it("keeps a restored session in each duplicate-folder instance after a same-directory move echo", async () => {
  const first = setup("move-duplicate-first", "C:\\Repo")
  const second = setup("move-duplicate-restored", "C:\\Repo")
  const store = messageStoreBus.getOrCreate(second.session.instanceId)
  store.setMessageWindow("restored", { kind: "history", olderCursor: "older-200", resumeCursor: "page-400", newerCursors: ["page-200"] })
  const window = store.getMessageWindow("restored")
  try {
    handleNativeSessionEvent(second.session.instanceId, {
      id: "same-location", type: "session.moved", created: 1,
      data: { sessionID: "restored", location: { directory: "c:/repo" } },
    } as any)
    assert.ok(sessions().get(second.session.instanceId)?.has("restored"), "The event is not an exclusive transfer to the first matching instance")
    assert.equal(store.getMessageWindow("restored"), window, "Do not clear the historical message window")
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.ok(sessions().get(second.session.instanceId)?.has("restored"), "Catalog settlement must not remove the restored selection")
    assert.deepEqual(getSessionListIds(second.session.instanceId), ["restored"])
  } finally { first.cleanup(); second.cleanup() }
})

it("does not send session.move when worktree option hydration reselects the current directory", async () => {
  const fixture = setup("worktree-selection-noop", "C:\\Repo\\")
  const original = serverApi.fetchWorktrees
  const moves: string[] = []
  fixture.client.session.move = async (input: { directory: string }) => { moves.push(input.directory) }
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [
    { slug: "root", directory: "c:/repo" },
    { slug: "feature", directory: "c:/repo/.worktrees/feature" },
  ] }) as any
  try {
    await ensureWorktreesLoaded(fixture.session.instanceId)
    await setWorktreeSlugForParentSession(fixture.session.instanceId, "restored", "root")
    assert.deepEqual(moves, [], "Controlled option initialization is not a move request")
    await setWorktreeSlugForParentSession(fixture.session.instanceId, "restored", "feature")
    assert.deepEqual(moves, ["c:/repo/.worktrees/feature"], "A real directory change still moves the session")
    await setWorktreeSlugForParentSession(fixture.session.instanceId, "restored", "feature")
    assert.equal(moves.length, 1)
  } finally { serverApi.fetchWorktrees = original; fixture.cleanup() }
})

it("keeps an in-project move in the source instance when another tab opens that worktree directly", async () => {
  const worktree = setup("move-worktree-first", "/repo/.worktrees/feature")
  const root = setup("move-project-restored", "/repo")
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [
    { slug: "root", directory: "/repo" },
    { slug: "feature", directory: "/repo/.worktrees/feature" },
  ] }) as any
  root.client.session.list = async () => ({ data: [{ ...root.session, location: { directory: "/repo/.worktrees/feature" } }] })
  try {
    await ensureWorktreesLoaded(root.session.instanceId)
    handleNativeSessionEvent(root.session.instanceId, {
      id: "worktree-location", type: "session.moved", created: 1,
      data: { sessionID: "restored", location: { directory: "/repo/.worktrees/feature" } },
    } as any)
    assert.equal(sessions().get(root.session.instanceId)?.get("restored")?.location.directory, "/repo/.worktrees/feature")
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(getSessionListIds(root.session.instanceId), ["restored"])
  } finally { serverApi.fetchWorktrees = original; worktree.cleanup(); root.cleanup() }
})

it("still removes the old instance projection when the session really leaves its location scope", async () => {
  const target = setup("move-real-target", "/other")
  const source = setup("move-real-source", "/repo")
  source.client.session.list = async () => ({ data: [] })
  try {
    handleNativeSessionEvent(source.session.instanceId, {
      id: "different-location", type: "session.moved", created: 1,
      data: { sessionID: "restored", location: { directory: "/other" } },
    } as any)
    assert.equal(sessions().get(source.session.instanceId)?.has("restored") ?? false, false)
    assert.equal(sessions().get(target.session.instanceId)?.get("restored")?.location.directory, "/other")
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(getSessionListIds(source.session.instanceId), [])
    assert.deepEqual(getSessionListIds(target.session.instanceId), ["restored"])
  } finally { source.cleanup(); target.cleanup() }
})
