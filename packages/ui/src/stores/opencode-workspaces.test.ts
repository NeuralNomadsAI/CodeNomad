import assert from "node:assert/strict"
import { describe, it, mock } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { mapOpenCodeWorkspacesToWorktreeSlugs } from "./opencode-workspace-matching.ts"
import {
  clearOpenCodeWorkspaceCache,
  getOpenCodeWorkspaceIdForWorktree,
  reloadOpenCodeWorkspaces,
  syncOpenCodeWorkspaces,
} from "./opencode-workspaces.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function setupWorkspaceInstance(instanceId: string, workspace: Record<string, unknown>) {
  const client = { experimental: { workspace } } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  return () => {
    clearOpenCodeWorkspaceCache(instanceId)
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
  }
}

describe("mapOpenCodeWorkspacesToWorktreeSlugs", () => {
  it("matches POSIX worktree directories case-sensitively", () => {
    const result = mapOpenCodeWorkspacesToWorktreeSlugs(
      [
        { slug: "feature", directory: "/Users/dev/Repo/.codenomad/worktrees/Feature" },
        { slug: "feature-lower", directory: "/Users/dev/Repo/.codenomad/worktrees/feature" },
      ],
      [
        { id: "wrk_exact", directory: "/Users/dev/Repo/.codenomad/worktrees/Feature" },
      ],
    )

    assert.equal(result.get("feature"), "wrk_exact")
    assert.equal(result.has("feature-lower"), false)
  })

  it("matches Windows drive paths case-insensitively and normalizes slashes", () => {
    const result = mapOpenCodeWorkspacesToWorktreeSlugs(
      [
        { slug: "test2", directory: String.raw`C:\Users\Dev\Repo\.codenomad\worktrees\test2` },
      ],
      [
        { id: "wrk_test2", directory: "c:/users/dev/repo/.codenomad/worktrees/test2/" },
      ],
    )

    assert.equal(result.get("test2"), "wrk_test2")
  })

  it("matches Windows UNC paths case-insensitively and normalizes slashes", () => {
    const result = mapOpenCodeWorkspacesToWorktreeSlugs(
      [
        { slug: "unc", directory: String.raw`\\server\Share\Repo\.codenomad\worktrees\unc` },
      ],
      [
        { id: "wrk_unc", directory: "//SERVER/share/repo/.codenomad/worktrees/unc" },
      ],
    )

    assert.equal(result.get("unc"), "wrk_unc")
  })

  it("does not map the root worktree", () => {
    const result = mapOpenCodeWorkspacesToWorktreeSlugs(
      [
        { slug: "root", directory: "/repo" },
      ],
      [
        { id: "wrk_root", directory: "/repo" },
      ],
    )

    assert.equal(result.size, 0)
  })
})

describe("OpenCode workspace sync", () => {
  it("deduplicates callers onto one shared SDK sync", async () => {
    const instanceId = "shared-workspace-sync"
    const gate = deferred<void>()
    let syncCalls = 0
    let listCalls = 0
    const cleanup = setupWorkspaceInstance(instanceId, {
      syncList: async () => { syncCalls += 1; await gate.promise; return { data: [] } },
      list: async () => { listCalls += 1; return { data: [] } },
    })

    try {
      const requests = [
        syncOpenCodeWorkspaces(instanceId),
        syncOpenCodeWorkspaces(instanceId),
        syncOpenCodeWorkspaces(instanceId),
      ]
      while (syncCalls === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(syncCalls, 1)
      gate.resolve()
      await Promise.all(requests)
      assert.equal(listCalls, 1)
    } finally {
      cleanup()
    }
  })

  it("queues reconnect replacement without releasing or aborting shared callers", async () => {
    const instanceId = "replacement-workspace-sync"
    const first = deferred<void>()
    const second = deferred<void>()
    const signals: AbortSignal[] = []
    let syncCalls = 0
    const cleanup = setupWorkspaceInstance(instanceId, {
      syncList: async (_parameters: unknown, options?: { signal?: AbortSignal }) => {
        syncCalls += 1
        if (options?.signal) signals.push(options.signal)
        await (syncCalls === 1 ? first.promise : second.promise)
        return { data: [] }
      },
      list: async () => ({ data: [] }),
    })

    try {
      let sharedSettled = false
      const shared = syncOpenCodeWorkspaces(instanceId).then(() => { sharedSettled = true })
      while (syncCalls === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      const reconnect = reloadOpenCodeWorkspaces(instanceId)
      assert.equal(signals[0]?.aborted, false)

      first.resolve()
      while (syncCalls < 2) await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(sharedSettled, false)
      assert.equal(signals[0]?.aborted, false)

      second.resolve()
      await Promise.all([shared, reconnect])
      assert.equal(sharedSettled, true)
    } finally {
      cleanup()
    }
  })

  it("aborts timed-out SDK I/O and negative-caches the shared result", async () => {
    const instanceId = "timed-out-workspace-sync"
    let syncCalls = 0
    let sdkSignal: AbortSignal | undefined
    const cleanup = setupWorkspaceInstance(instanceId, {
      syncList: (_parameters: unknown, options?: { signal?: AbortSignal }) => {
        syncCalls += 1
        sdkSignal = options?.signal
        return new Promise((_resolve, reject) => options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true },
        ))
      },
      list: async () => ({ data: [] }),
    })
    mock.timers.enable({ apis: ["setTimeout"] })

    try {
      const request = syncOpenCodeWorkspaces(instanceId)
      while (!sdkSignal) await new Promise<void>((resolve) => setImmediate(resolve))
      mock.timers.tick(5_000)
      await request
      assert.equal(sdkSignal.aborted, true)

      assert.equal(await getOpenCodeWorkspaceIdForWorktree(instanceId, "missing-one"), null)
      assert.equal(await getOpenCodeWorkspaceIdForWorktree(instanceId, "missing-two"), null)
      assert.equal(syncCalls, 1)
    } finally {
      mock.timers.reset()
      cleanup()
    }
  })
})
