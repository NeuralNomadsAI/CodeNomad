import assert from "node:assert/strict"
import { test } from "node:test"
import { serverApi } from "../lib/api-client"
import { sdkManager } from "../lib/sdk-manager"
import { addInstance, removeInstance } from "./instances"
import { setInstanceMetadata } from "./instance-metadata"
import { fetchSessions } from "./session-api"
import { handleNativeSessionEvent } from "./session-events"
import { getSessionListIds, getSessionListError, getSessionThreads, getSessionRoot, sessions, setSessions } from "./session-state"
import { getDirectoryOnlyWorktree, getGitRepoStatus, reloadWorktrees } from "./worktrees"
import { createEffect, createRoot } from "solid-js"

test("directory-only inventory loads and paginates UI sessions without claiming non-repository status", async t => {
  const id = "git-degraded-ui", folder = "/repo/nested"
  const original = serverApi.fetchWorktrees
  let gitAvailable = false
  serverApi.fetchWorktrees = async () => gitAvailable
    ? { isGitRepo: true, worktrees: [{ slug: "root", directory: folder, kind: "root" }] }
    : { gitAvailable: false, worktrees: [{ slug: "root", directory: folder, serviceDirectory: folder, kind: "root", directoryOnly: true }] }
  const requests: any[] = []
  let moved = false
  const session = (id: string) => ({ id, title: id, projectID: "project", location: { directory: folder },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } })
  let ancestorReads = 0
  const client: any = { session: { active: async () => ({}), get: async () => {
    ancestorReads++
    throw Object.assign(new Error("Session does not belong to workspace"), { status: 403 })
  }, list: async (input: any) => {
    requests.push(input)
    if (!gitAvailable) assert.equal(input.project, undefined, "never request canonical project scope for an opened subfolder without Git")
    if (input.cursor) return { data: [session("older"), ...(gitAvailable ? [] : [
      { ...session("local-child"), parentID: "foreign-parent" },
      ...(moved ? [{ ...session("moved-child"), parentID: "held-parent" }] : []),
    ])], cursor: {} }
    return { data: [session("newer")], cursor: { next: "directory-page-2" } }
  } } }
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder, port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setInstanceMetadata(id, { project: { id: "project", canonical: "/repo" } as any })
  try {
    await fetchSessions(id, { reset: true, strictStatus: true })
    assert.equal(getSessionListError(id), undefined)
    assert.deepEqual(new Set(getSessionListIds(id)), new Set(["newer", "older", "local-child"]))
    assert.equal(sessions().get(id)?.size, 3)
    assert.equal(ancestorReads, 0, "do not request parents outside the directory inventory")
    assert.equal(sessions().get(id)?.get("local-child")?.parentId, "foreign-parent")
    assert.equal(getSessionRoot(id, "local-child")?.id, "local-child")
    assert.ok(getSessionThreads(id).some(thread => thread.session.id === "local-child"))
    await fetchSessions(id, { reset: true, strictStatus: true })
    assert.ok(getSessionListIds(id).includes("local-child"), "reconciliation preserves the local display root")
    assert.equal(getGitRepoStatus(id), null)
    assert.equal(getDirectoryOnlyWorktree(id)?.directory, folder)
    assert.ok(requests.some(input => input.directory === folder))
    assert.ok(requests.some(input => input.cursor === "directory-page-2"))

    const sample = sessions().get(id)!.get("local-child")!
    setSessions(previous => new Map(previous).set(id, new Map(previous.get(id))
      .set("held-parent", { ...sample, id: "held-parent", parentId: null, location: { directory: "/repo" } })
      .set("moved-child", { ...sample, id: "moved-child", parentId: "held-parent", location: { directory: "/repo" } })))
    assert.ok(!getSessionListIds(id).includes("moved-child"))
    const listed = new Promise<void>(resolve => createRoot(dispose => {
      t.after(dispose)
      createEffect(() => {
        if (!getSessionListIds(id).includes("moved-child")) return
        dispose()
        resolve()
      })
    }))
    t.mock.timers.enable({ apis: ["setTimeout"] })
    moved = true
    handleNativeSessionEvent(id, {
      type: "session.moved", id: "move", created: 2,
      durable: { aggregateID: "moved-child", seq: 1, version: 1 },
      data: { sessionID: "moved-child", projectID: "project", location: { directory: folder } },
    })
    t.mock.timers.tick(100)
    t.mock.timers.reset()
    await listed
    assert.ok(getSessionThreads(id).some(thread => thread.session.id === "moved-child"))
    assert.equal(sessions().get(id)?.get("moved-child")?.parentId, "held-parent")

    gitAvailable = true
    await reloadWorktrees(id)
    requests.length = 0
    await fetchSessions(id, { reset: true, strictStatus: true })
    assert.equal(getDirectoryOnlyWorktree(id), undefined)
    assert.equal(getGitRepoStatus(id), true)
    assert.ok(requests.some(input => input.project === "project"))
  } finally {
    serverApi.fetchWorktrees = original
    setSessions(previous => { const next = new Map(previous); next.delete(id); return next })
    removeInstance(id, { authoritative: false })
    sdkManager.destroyClientsForInstance(id)
  }
})
