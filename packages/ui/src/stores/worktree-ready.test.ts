import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { captureWorktreeMoveReconciliation, clearPendingWorktreeMoves, getPendingWorktreeLocations, getPendingWorktreeSlug, ensureWorktreesLoaded, getGitRepoStatus, getWorktrees, handleWorktreeReady, reloadWorktrees, setWorktreeSlugForParentSession } from "./worktrees.ts"
import type { Session } from "../types/session.ts"
import { sessions, setSessions } from "./session-state.ts"
import { serverEvents } from "../lib/server-events.ts"

describe("handleWorktreeReady", () => {
  it("rejects both failed fresh callers but runs queued display demand without leaking freshness", async () => {
    const id = "fresh-failure-cached-trailing", original = serverApi.fetchWorktrees
    let release!: () => void
    let releaseDisplay!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const displayGate = new Promise<void>(resolve => { releaseDisplay = resolve })
    const calls: boolean[] = []
    serverApi.fetchWorktrees = async (_id, fresh = false) => {
      calls.push(fresh)
      if (fresh) { await gate; throw new Error("fresh validation failed") }
      if (calls.length > 1) await displayGate
      return { isGitRepo: true, worktrees: [
        { slug: "root", directory: "/repo", kind: "root" },
        ...(calls.length > 1 ? [{ slug: "created", directory: "/repo-created", kind: "worktree" as const }] : []),
      ] }
    }
    try {
      await reloadWorktrees(id)
      const fresh = reloadWorktrees(id, true)
      await new Promise<void>(resolve => setImmediate(resolve))
      const again = reloadWorktrees(id, true)
      const cached = reloadWorktrees(id)
      const rejected = assert.rejects(fresh, /fresh validation failed/)
      const againRejected = assert.rejects(again, /fresh validation failed/)
      assert.deepEqual(calls, [false, true], "one serialized read, concurrent fresh callers coalesce")
      assert.deepEqual(getWorktrees(id).map(worktree => worktree.slug), ["root"])
      release()
      await Promise.all([rejected, againRejected])
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual(calls, [false, true, false], "display demand must survive a failed fresh read")
      assert.deepEqual(getWorktrees(id).map(worktree => worktree.slug), ["root"], "native failure retains visible data")
      releaseDisplay()
      await cached
      assert.deepEqual(getWorktrees(id).map(worktree => worktree.slug), ["root", "created"])
      await reloadWorktrees(id)
      assert.deepEqual(calls, [false, true, false, false], "the second fresh caller leaves no flag or empty demand")
    } finally { release(); releaseDisplay(); serverApi.fetchWorktrees = original }
  })
  it("preserves a fresh recovery demand behind an in-flight cached display read", async () => {
    const original = serverApi.fetchWorktrees
    let release!: () => void
    let releaseFresh!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const freshGate = new Promise<void>(resolve => { releaseFresh = resolve })
    const calls: boolean[] = []
    serverApi.fetchWorktrees = async (_id, fresh = false) => {
      calls.push(fresh)
      if (calls.length === 1) await gate
      if (fresh) await freshGate
      return { worktrees: [{ slug: fresh ? "fresh" : "root", directory: "/repo", kind: "root" }] }
    }
    try {
      const cached = reloadWorktrees("fresh-pending-recovery")
      await new Promise<void>(resolve => setImmediate(resolve))
      const fresh = reloadWorktrees("fresh-pending-recovery", true)
      const again = reloadWorktrees("fresh-pending-recovery", true)
      let freshSettled = false
      void fresh.then(() => { freshSettled = true })
      release()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual(calls, [false, true])
      assert.equal(freshSettled, false, "cached completion cannot fulfill required fresh recovery")
      assert.equal(getWorktrees("fresh-pending-recovery")[0]?.slug, "root")
      releaseFresh()
      await Promise.all([cached, fresh, again])
      assert.deepEqual(calls, [false, true], "coalesce fresh demand without downgrading it to display cache")
      assert.equal(getWorktrees("fresh-pending-recovery")[0]?.slug, "fresh", "an older cached read cannot publish after fresh inventory")
    } finally { release(); releaseFresh(); serverApi.fetchWorktrees = original }
  })
  it("shares an in-flight successful fresh read and leaves the next display read ordinary", async () => {
    const id = "fresh-success", original = serverApi.fetchWorktrees
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const calls: boolean[] = []
    serverApi.fetchWorktrees = async (_id, fresh = false) => {
      calls.push(fresh)
      if (fresh) await gate
      return { isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] }
    }
    try {
      const first = reloadWorktrees(id, true)
      await new Promise<void>(resolve => setImmediate(resolve))
      const second = reloadWorktrees(id, true)
      release()
      await Promise.all([first, second])
      assert.deepEqual(calls, [true])
      await reloadWorktrees(id)
      assert.deepEqual(calls, [true, false])
    } finally { release(); serverApi.fetchWorktrees = original }
  })
  it("keeps initial-load failure fallback and lets a later reload recover", async () => {
    const id = "initial-fallback", original = serverApi.fetchWorktrees
    let calls = 0
    serverApi.fetchWorktrees = async () => {
      if (++calls === 1) throw new Error("initial unavailable")
      return { isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] }
    }
    try {
      await ensureWorktreesLoaded(id)
      assert.deepEqual(getWorktrees(id), [])
      assert.equal(getGitRepoStatus(id), null)
      await ensureWorktreesLoaded(id)
      assert.equal(calls, 1, "fallback is loaded but does not claim Git authority")
      await reloadWorktrees(id)
      assert.equal(getWorktrees(id)[0]?.slug, "root")
      assert.equal(getGitRepoStatus(id), true)
    } finally { serverApi.fetchWorktrees = original }
  })
  it("does not turn a failed display read into a failed queued fresh recovery", async () => {
    const id = "display-failure-fresh-recovery", original = serverApi.fetchWorktrees
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const calls: boolean[] = []
    serverApi.fetchWorktrees = async (_id, fresh = false) => {
      calls.push(fresh)
      if (!fresh) { await gate; throw new Error("display unavailable") }
      return { worktrees: [{ slug: "fresh", directory: "/repo", kind: "root" }] }
    }
    try {
      const display = assert.rejects(reloadWorktrees(id), /display unavailable/)
      await new Promise<void>(resolve => setImmediate(resolve))
      const fresh = reloadWorktrees(id, true)
      release()
      await Promise.all([display, fresh])
      assert.deepEqual(calls, [false, true])
      assert.equal(getWorktrees(id)[0]?.slug, "fresh")
    } finally { release(); serverApi.fetchWorktrees = original }
  })
  it("an initial display fallback cannot erase a fresh snapshot published while it waited", async () => {
    const id = "initial-behind-fresh", original = serverApi.fetchWorktrees
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    serverApi.fetchWorktrees = async (_id, fresh = false) => {
      if (!fresh) throw new Error("initial display unavailable")
      await gate
      return { isGitRepo: true, worktrees: [{ slug: "fresh", directory: "/repo", kind: "root" }] }
    }
    try {
      const fresh = reloadWorktrees(id, true)
      await new Promise<void>(resolve => setImmediate(resolve))
      const initial = ensureWorktreesLoaded(id)
      release()
      await Promise.all([fresh, initial])
      assert.equal(getWorktrees(id)[0]?.slug, "fresh")
      assert.equal(getGitRepoStatus(id), true)
    } finally { release(); serverApi.fetchWorktrees = original }
  })
  it("worktreesChanged display demand survives a fresh failure without reopening the selector", async () => {
    const id = "changed-during-fresh-failure", original = serverApi.fetchWorktrees
    let release!: () => void, published!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const display = new Promise<void>(resolve => { published = resolve })
    const calls: boolean[] = []
    serverApi.fetchWorktrees = async (_id, fresh = false) => {
      calls.push(fresh)
      if (fresh) { await gate; throw new Error("native unavailable") }
      if (calls.length > 1) published()
      return { worktrees: [{ slug: calls.length === 1 ? "root" : "created", directory: "/repo", kind: "root" }] }
    }
    try {
      await reloadWorktrees(id)
      const fresh = assert.rejects(reloadWorktrees(id, true), /native unavailable/)
      await new Promise<void>(resolve => setImmediate(resolve))
      ;(serverEvents as any).dispatch({ type: "workspace.worktreesChanged", workspaceId: id })
      release()
      await fresh
      await display
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual(calls, [false, true, false])
      assert.equal(getWorktrees(id)[0]?.slug, "created")
    } finally { release(); serverApi.fetchWorktrees = original }
  })
  it("reports a failed trailing reload and retains the successful initial snapshot", async () => {
    const original = serverApi.fetchWorktrees
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    serverApi.fetchWorktrees = async () => {
      if (++calls > 1) throw new Error("trailing refresh failed")
      await gate
      return { isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] }
    }
    try {
      const initial = ensureWorktreesLoaded("failed-trailing-read")
      await Promise.resolve()
      const reload = reloadWorktrees("failed-trailing-read")
      const rejected = assert.rejects(Promise.all([initial, reload]), /trailing refresh failed/)
      release()
      await rejected
      assert.equal(calls, 2)
      assert.equal(getWorktrees("failed-trailing-read")[0]?.slug, "root")
      serverApi.fetchWorktrees = async (_id, fresh = false) => {
        assert.equal(fresh, false)
        calls++
        return { isGitRepo: true, worktrees: [{ slug: "recovered", directory: "/repo", kind: "root" }] }
      }
      await reloadWorktrees("failed-trailing-read")
      assert.equal(calls, 3, "a failed trailing read drains its demand without an automatic retry")
      assert.equal(getWorktrees("failed-trailing-read")[0]?.slug, "recovered")
    } finally {
      release()
      serverApi.fetchWorktrees = original
    }
  })

  it("refreshes worktrees", async () => {
    const calls: string[] = []

    await handleWorktreeReady(
      "instance-1",
      {
        type: "worktree.ready",
        location: { directory: "/tmp/opencode/worktree/feature" },
        data: { name: "feature", branch: "opencode/feature" },
      },
      async (instanceId) => {
        calls.push(`worktrees:${instanceId}`)
      },
    )

    assert.deepEqual(calls, ["worktrees:instance-1"])
  })

  it("serializes overlapping ready events for the same instance", async () => {
    const calls: string[] = []
    let releaseFirst!: () => void
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let refreshCount = 0

    const refreshWorktrees = async () => {
      refreshCount += 1
      calls.push(`worktrees:${refreshCount}`)
      if (refreshCount === 1) await firstPending
    }
    const event = {
      type: "worktree.ready" as const,
      location: { directory: "/tmp/opencode/worktree/feature" },
      data: { name: "feature" },
    }

    const first = handleWorktreeReady("instance-concurrent", event, refreshWorktrees)
    await Promise.resolve()
    const second = handleWorktreeReady("instance-concurrent", event, refreshWorktrees)
    await Promise.resolve()

    assert.deepEqual(calls, ["worktrees:1"])

    releaseFirst()
    await Promise.all([first, second])

    assert.deepEqual(calls, ["worktrees:1", "worktrees:2"])
  })

  it("continues processing after an earlier refresh rejects", async () => {
    const event = {
      type: "worktree.ready" as const,
      data: { name: "feature" },
    }

    await assert.rejects(
      handleWorktreeReady(
        "instance-recovery",
        event,
        async () => {
          throw new Error("refresh failed")
        },
      ),
      /refresh failed/,
    )

    const calls: string[] = []
    await handleWorktreeReady(
      "instance-recovery",
      event,
      async () => {
        calls.push("worktrees")
      },
    )

    assert.deepEqual(calls, ["worktrees"])
  })

  it("orders initial hydration before a trailing reload", async () => {
    const instanceId = "instance-initial-reload"
    const originalFetchWorktrees = serverApi.fetchWorktrees
    let resolveInitial!: (value: Awaited<ReturnType<typeof serverApi.fetchWorktrees>>) => void
    let resolveReload!: (value: Awaited<ReturnType<typeof serverApi.fetchWorktrees>>) => void
    const initialResponse = new Promise<Awaited<ReturnType<typeof serverApi.fetchWorktrees>>>((resolve) => {
      resolveInitial = resolve
    })
    const reloadResponse = new Promise<Awaited<ReturnType<typeof serverApi.fetchWorktrees>>>((resolve) => {
      resolveReload = resolve
    })
    let requestCount = 0
    let started!: () => void
    const initialStarted = new Promise<void>(resolve => { started = resolve })

    serverApi.fetchWorktrees = async () => {
      requestCount += 1
      started()
      return requestCount === 1 ? initialResponse : reloadResponse
    }

    try {
      const initial = ensureWorktreesLoaded(instanceId)
      await initialStarted
      const reload = reloadWorktrees(instanceId)
      await Promise.resolve()

      assert.equal(requestCount, 1)

      resolveInitial({
        isGitRepo: true,
        worktrees: [{ slug: "root", directory: "/repo", kind: "root" }],
      })
      await new Promise<void>(resolve => setImmediate(resolve))

      assert.equal(requestCount, 2)

      resolveReload({
        isGitRepo: true,
        worktrees: [
          { slug: "root", directory: "/repo", kind: "root" },
          { slug: "feature", directory: "/repo-feature", kind: "worktree" },
        ],
      })
      await Promise.all([initial, reload])

      assert.deepEqual(getWorktrees(instanceId).map((worktree) => worktree.slug), ["root", "feature"])
    } finally {
      serverApi.fetchWorktrees = originalFetchWorktrees
    }
  })
})

describe("session family worktree moves", () => {
  it("an older reconciliation cannot release a queued newer target or its unknown source locations", async () => {
    const id = "queued-move-reconciliation", original = serverApi.fetchWorktrees
    let release!: () => void, started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const reading = new Promise<void>(resolve => { started = resolve })
    let oldRead: (() => void) | undefined
    serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: ["root", "a", "b"].map(slug => ({
      slug, directory: slug === "root" ? "/repo" : `/repo-${slug}`, kind: slug === "root" ? "root" as const : "worktree" as const,
    })) })
    setSessions(previous => new Map(previous).set(id, new Map([["s", { id: "s", parentId: null, location: { directory: "/repo" } } as Session]])))
    try {
      await reloadWorktrees(id)
      const first = setWorktreeSlugForParentSession(id, "s", "a", {
        moveFamily: async () => {}, refreshSessions: async () => {
          oldRead = captureWorktreeMoveReconciliation(id)
          started(); await gate
          oldRead()
        },
      })
      await reading
      const second = setWorktreeSlugForParentSession(id, "s", "b", {
        moveFamily: async () => {
          assert.equal(getPendingWorktreeSlug(id, "s"), "b")
          oldRead!()
          assert.deepEqual(new Set(getPendingWorktreeLocations(id).map(location => location.directory)), new Set(["/repo", "/repo-a", "/repo-b"]))
        }, refreshSessions: async () => { throw new Error("read unavailable") },
      })
      await new Promise<void>(resolve => setImmediate(resolve))
      release()
      await first; await second
      assert.equal(getPendingWorktreeSlug(id, "s"), undefined, "selector busy state ends with its latest task, not with directory authority")
      assert.equal(getPendingWorktreeLocations(id).length, 3)
      captureWorktreeMoveReconciliation(id)()
      assert.equal(getPendingWorktreeSlug(id, "s"), undefined)
    } finally { release(); clearPendingWorktreeMoves(id); serverApi.fetchWorktrees = original }
  })

  it("moves a descendant's family root and refreshes authoritatively", async () => {
    const instanceId = "family-move"
    const originalFetchWorktrees = serverApi.fetchWorktrees
    serverApi.fetchWorktrees = async () => ({
      isGitRepo: true,
      worktrees: [
        { slug: "root", directory: "/repo", kind: "root" },
        { slug: "feature", directory: "/repo-feature", kind: "worktree" },
      ],
    })
    const root = { id: "root", parentId: null, location: { directory: "/repo" } } as Session
    const child = { id: "child", parentId: "root", location: { directory: "/repo" } } as Session
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[root.id, root], [child.id, child]])))
    await reloadWorktrees(instanceId)

    try {
      const calls: string[] = []
      await setWorktreeSlugForParentSession(instanceId, child.id, "feature", {
        moveFamily: async (_id, rootSessionId, slug) => {
          calls.push(`move:${rootSessionId}:${slug}`)
          assert.equal(root.location.directory, "/repo")
          assert.equal(child.location.directory, "/repo")
        },
        refreshSessions: async () => {
          calls.push("refresh")
          setSessions((prev) => new Map(prev).set(instanceId, new Map([
            [root.id, { ...root, location: { directory: "/repo-feature" } }],
            [child.id, { ...child, location: { directory: "/repo-feature" } }],
          ])))
          captureWorktreeMoveReconciliation(instanceId)()
        },
      })
      assert.deepEqual(calls, ["move:root:feature", "refresh"])
      assert.equal(root.location.directory, "/repo")
      assert.equal(child.location.directory, "/repo")
      assert.equal(sessions().get(instanceId)?.get(root.id)?.location.directory, "/repo-feature")
      assert.equal(sessions().get(instanceId)?.get(child.id)?.location.directory, "/repo-feature")
      assert.equal(getPendingWorktreeSlug(instanceId, child.id), undefined)

      await setWorktreeSlugForParentSession(instanceId, child.id, "root", {
        moveFamily: async () => { calls.push("move:root") },
        refreshSessions: async () => { throw new Error("refresh failed") },
      })
      assert.equal(calls.at(-1), "move:root")
    } finally {
      clearPendingWorktreeMoves(instanceId)
      serverApi.fetchWorktrees = originalFetchWorktrees
      setSessions((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
    }
  })
})
