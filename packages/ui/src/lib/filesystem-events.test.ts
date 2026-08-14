import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createDebouncedRefresh,
  filesystemInvalidationVersion,
  invalidateFilesystemCaches,
  isFilesystemChangedEvent,
} from "./filesystem-events.ts"

describe("filesystem event refresh", () => {
  it("matches the native payload location and coalesces noisy changes", async () => {
    const event = {
      type: "instance.event",
      instanceId: "workspace",
      event: {
        id: "event-1",
        created: 1,
        type: "filesystem.changed",
        location: { directory: "/work" },
        data: { file: "src/App.tsx", event: "change" },
      },
    } as any
    assert.equal(isFilesystemChangedEvent(event, "workspace", "/work"), true)
    assert.equal(isFilesystemChangedEvent(event, "workspace", "/other"), false)
    assert.equal(isFilesystemChangedEvent({
      ...event,
      event: { ...event.event, type: "vcs.branch.updated" },
    }, "workspace", "/work"), true)

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
