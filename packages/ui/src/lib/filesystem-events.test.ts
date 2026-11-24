import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createDebouncedRefresh,
  filesystemInvalidationVersion,
  invalidateFilesystemCaches,
  queueFilesystemInvalidation,
} from "./filesystem-events.ts"
import { serverEvents } from "./server-events"

describe("filesystem event refresh", () => {
  it("coalesces noisy changes", async () => {
    let refreshes = 0
    const refresh = createDebouncedRefresh(() => { refreshes += 1 }, 5)
    refresh.trigger()
    refresh.trigger()
    refresh.trigger()
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.equal(refreshes, 1)
  })

  it("invalidates closed-tab caches without requiring a mounted event listener", () => {
    const before = filesystemInvalidationVersion("closed-workspace")
    invalidateFilesystemCaches("closed-workspace")
    assert.equal(filesystemInvalidationVersion("closed-workspace"), before + 1)
  })
  it("routes host file observations to only their workspace without needing an OpenCode client", async () => {
    const before = filesystemInvalidationVersion("host-workspace"), other = filesystemInvalidationVersion("other-workspace")
    ;(serverEvents as unknown as { dispatchBatch(events: unknown[]): void }).dispatchBatch([
      { type: "workspace.filesChanged", workspaceId: "host-workspace", changes: [{ directory: "/repo", path: "." }] },
    ])
    await new Promise(resolve => setTimeout(resolve, 130))
    assert.equal(filesystemInvalidationVersion("host-workspace"), before + 1)
    assert.equal(filesystemInvalidationVersion("other-workspace"), other)
  })
  it("limits passive cache publications during continuous activity, preserves directory scope and keeps explicit mutations immediate", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    let now = 0
    t.mock.method(performance, "now", () => now)
    const advance = (ms: number) => { now += ms; t.mock.timers.tick(ms) }
    const id = "rate-limited-workspace"
    const change = { directory: "D:\\Repo", path: "src" }
    queueFilesystemInvalidation(id, [change])
    assert.equal(filesystemInvalidationVersion(id), 0)
    advance(100)
    assert.equal(filesystemInvalidationVersion(id), 1)
    assert.equal(filesystemInvalidationVersion(id, "d:/repo/", "src"), 1)
    assert.equal(filesystemInvalidationVersion(id, "d:/repo", "."), 0)
    for (let tick = 0; tick < 40; tick++) {
      queueFilesystemInvalidation(id, [change, { directory: "D:\\Other", path: "." }])
      advance(100)
    }
    assert.equal(filesystemInvalidationVersion(id), 1, "40 batches do not repeatedly invalidate any consumer")
    advance(1_000)
    assert.equal(filesystemInvalidationVersion(id), 2)
    assert.equal(filesystemInvalidationVersion(id, "d:/other", "."), 2)
    assert.equal(filesystemInvalidationVersion(id, "d:/repo", "unchanged"), 0)
    queueFilesystemInvalidation(id, [change])
    invalidateFilesystemCaches(id)
    assert.equal(filesystemInvalidationVersion(id), 3, "a successful explicit write does not wait for the passive cadence")
    assert.equal(filesystemInvalidationVersion(id, "d:/repo", "unchanged"), 3)
    advance(10_000)
    assert.equal(filesystemInvalidationVersion(id), 3, "no timer publishes without pending observations")
  })
})
