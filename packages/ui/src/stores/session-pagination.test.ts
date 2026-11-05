import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { applySessionPage, getDefaultSessionPaginationState } from "./session-pagination-model.ts"
import {
  PROJECT_SESSION_LIST_LIMIT,
  buildProjectSessionListOptions,
} from "./session-list-options.ts"
import { explicitSessionDirectory, sessionMatchesInventory } from "./session-inventory-scope.ts"
import type { Instance } from "../types/instance.ts"

describe("project session list loading", () => {
  it("keeps explicit Location spelling opaque and local scope unchanged", () => {
    const instance = { binding: { serverId: "A", directory: "C:\\Work\\" }, folder: "ignored" } as Instance
    assert.equal(explicitSessionDirectory(instance), "C:\\Work\\")
    assert.equal(sessionMatchesInventory(instance, { location: { directory: "C:\\Work\\" } }), true)
    assert.equal(sessionMatchesInventory(instance, { location: { directory: "c:/work" } }), false)
    assert.equal(sessionMatchesInventory(instance, { location: { directory: "C:\\Work\\", workspaceID: "legacy" } }), false)
    assert.equal(sessionMatchesInventory({ ...instance, binding: { serverId: "local-shared", directory: "C:\\Work\\" } }, { location: { directory: "elsewhere" } }), true)
  })
  it("builds a native directory request without fake scope params", () => {
    const options = buildProjectSessionListOptions({ directory: "/tmp/project", search: "worktree" })

    assert.deepEqual(options, {
      directory: "/tmp/project",
      search: "worktree",
      limit: PROJECT_SESSION_LIST_LIMIT,
    })
    assert.equal("scope" in options, false)
    assert.equal("start" in options, false)
    assert.equal("cursor" in options, false)
  })

  it("passes native cursors through unchanged", () => {
    const cursor = `next-page-${"x".repeat(4096)}`
    assert.deepEqual(buildProjectSessionListOptions({ directory: "/tmp/project", cursor }), {
      cursor,
    })
  })

  it("retains the native cursor without dropping prior roots", () => {
    const first = applySessionPage(getDefaultSessionPaginationState(), ["root-1"], true, true, "page-2")
    const next = applySessionPage(first, ["root-2"], false, false)
    assert.deepEqual(next, { ids: ["root-1", "root-2"], hasMore: false, nextCursor: undefined })
  })

  it("replaces stale pages when reconnect refreshes the newest roots", () => {
    const stale = applySessionPage(getDefaultSessionPaginationState(), ["old-2", "old-1"], true, true, "old-page-2")
    const refreshed = applySessionPage(stale, ["new", "old-2"], true, true, "new-page-2")

    assert.deepEqual(refreshed, { ids: ["new", "old-2"], hasMore: true, nextCursor: "new-page-2" })
  })

})
