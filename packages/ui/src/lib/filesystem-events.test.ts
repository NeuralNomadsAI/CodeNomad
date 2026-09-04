import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createDebouncedRefresh,
  filesystemInvalidationVersion,
  invalidateFilesystemCaches,
} from "./filesystem-events.ts"

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
})
