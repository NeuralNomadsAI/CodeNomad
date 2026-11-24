import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { serverApi } from "../lib/api-client"
import { sdkManager } from "../lib/sdk-manager"
import { addInstance, removeInstance } from "./instances"
import { setInstanceMetadata } from "./instance-metadata"
import { fetchSessions } from "./session-api"
import { handleNativeSessionEvent } from "./session-events"
import { getSessionListIds, getSessionListError, getSessionNextCursor, getSessionThreads, getSessionRoot, sessions, setSessions } from "./session-state"
import { getDirectoryOnlyWorktree, getGitRepoStatus, reloadWorktrees } from "./worktrees"

test("directory-only inventory loads and paginates UI sessions without claiming non-repository status", async t => {
  const id = "git-degraded-ui", folder = "/repo/nested"
  const original = serverApi.fetchWorktrees
  let gitAvailable = false
  serverApi.fetchWorktrees = async () => gitAvailable
    ? { isGitRepo: true, worktrees: [
      { slug: "root", directory: folder, kind: "root" },
      { slug: "checkout", directory: "/checkout", kind: "worktree" },
    ] }
    : { gitAvailable: false, worktrees: [{ slug: "root", directory: folder, serviceDirectory: folder, kind: "root", directoryOnly: true }] }
  const requests: any[] = []
  let holdPage: Promise<void> | undefined
  let pageStarted: (() => void) | undefined
  const session = (id: string) => ({ id, title: id, projectID: "project", location: { directory: folder },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } })
  let recoveredFamily: ReturnType<typeof session>[] = []
  let ancestorReads = 0
  const client: any = { session: { active: async () => ({}), get: async () => {
    ancestorReads++
    throw Object.assign(new Error("Session does not belong to workspace"), { status: 403 })
  }, list: async (input: any) => {
    requests.push(input)
    pageStarted?.()
    await holdPage
    if (!gitAvailable) assert.equal(input.project, undefined, "never request canonical project scope for an opened subfolder without Git")
    if (input.cursor) return { data: [session("older"), ...(gitAvailable ? [] : [
      { ...session("local-child"), parentID: "foreign-parent" },
    ])], cursor: {} }
    if (input.project && recoveredFamily.length) return { data: recoveredFamily, cursor: {} }
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
    setInstanceMetadata(id, undefined)
    let releasePage!: () => void
    holdPage = new Promise(resolve => { releasePage = resolve })
    const started = new Promise<void>(resolve => { pageStarted = resolve })
    const inventory = fetchSessions(id, { reset: true, strictStatus: true })
    try {
      await started
      const cursor = getSessionNextCursor(id)
      t.mock.timers.enable({ apis: ["setTimeout"] })
      handleNativeSessionEvent(id, {
        type: "session.moved", id: "move", created: 2,
        durable: { aggregateID: "moved-child", seq: 1, version: 1 },
        data: { sessionID: "moved-child", projectID: "project", location: { directory: folder } },
      })
      t.mock.timers.tick(100)
      assert.ok(getSessionListIds(id).includes("moved-child"), "move publishes before the held root-only inventory returns")
      assert.ok(getSessionThreads(id).some(thread => thread.session.id === "moved-child"))
      assert.equal(sessions().get(id)?.get("moved-child")?.parentId, "held-parent")
      assert.equal(getSessionNextCursor(id), cursor)
    } finally {
      t.mock.timers.reset()
      releasePage()
      await inventory
    }
    assert.ok(getSessionListIds(id).includes("moved-child"), "a roots-only refresh keeps the projected child")

    gitAvailable = true
    setInstanceMetadata(id, { project: { id: "project", canonical: "/repo" } as any })
    await reloadWorktrees(id)
    requests.length = 0
    await fetchSessions(id, { reset: true, strictStatus: true })
    assert.equal(getDirectoryOnlyWorktree(id), undefined)
    assert.equal(getGitRepoStatus(id), true)
    assert.ok(requests.some(input => input.project === "project"))

    const root = { ...sample, id: "off-page-root", parentId: null }
    // Search can publish a family into the session map without adding its root to the page.
    setSessions(previous => new Map(previous).set(id, new Map(previous.get(id))
      .set(root.id, root)
      .set("off-page-child", { ...sample, id: "off-page-child", parentId: root.id })))
    assert.ok(!getSessionListIds(id).includes(root.id))
    const cursor = getSessionNextCursor(id)
    assert.equal(cursor, "directory-page-2")
    const beforeMove = requests.length
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const moveToCheckout = (sessionID: string, seq: number) => handleNativeSessionEvent(id, {
      type: "session.moved", id: `${sessionID}-move-${seq}`, created: 2 + seq,
      durable: { aggregateID: sessionID, seq, version: 1 },
      data: { sessionID, projectID: "project", location: { directory: "/checkout" } },
    })
    moveToCheckout("off-page-child", 1)
    t.mock.timers.tick(100)
    assert.ok(getSessionListIds(id).includes(root.id), "a worktree move lists the held family")
    assert.ok(getSessionThreads(id).some(thread => thread.session.id === root.id
      && thread.children.some(child => child.session.id === "off-page-child")))
    moveToCheckout("off-page-child", 1)
    moveToCheckout("off-page-child", 2)
    t.mock.timers.tick(100)
    await setImmediate()
    assert.equal(getSessionListIds(id).filter(sessionId => sessionId === root.id).length, 1)
    assert.equal(getSessionNextCursor(id), cursor)
    assert.equal(requests.length, beforeMove)

    const missingRoot = "missing-root"
    const heldChildren = ["held-child-a", "held-child-b"]
    setSessions(previous => {
      const held = new Map(previous.get(id))
      for (const child of heldChildren) held.set(child, { ...sample, id: child, parentId: missingRoot })
      return new Map(previous).set(id, held)
    })
    recoveredFamily = [
      session(missingRoot),
      ...heldChildren.map(child => ({ ...session(child), parentID: missingRoot, location: { directory: "/checkout" } })),
    ]
    for (const child of heldChildren) {
      assert.equal(getSessionRoot(id, child), null)
      moveToCheckout(child, 1)
    }
    t.mock.timers.tick(99)
    assert.equal(requests.length, beforeMove)
    t.mock.timers.tick(1)
    await setImmediate()
    assert.equal(requests.slice(beforeMove).filter(input => input.project === "project").length, 1,
      "the burst with a missing root triggers one project inventory refresh")
    assert.ok(getSessionListIds(id).includes(missingRoot))
    for (const child of heldChildren) assert.equal(getSessionRoot(id, child)?.id, missingRoot)
  } finally {
    serverApi.fetchWorktrees = original
    setSessions(previous => { const next = new Map(previous); next.delete(id); return next })
    removeInstance(id, { authoritative: false })
    sdkManager.destroyClientsForInstance(id)
  }
})
