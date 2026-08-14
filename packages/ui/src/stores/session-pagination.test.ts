import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { applySessionPage, getDefaultSessionPaginationState } from "./session-pagination-model.ts"
import {
  PROJECT_SESSION_LIST_LIMIT,
  buildProjectSessionListOptions,
  getUniqueSessionDirectories,
} from "./session-list-options.ts"

describe("project session list loading", () => {
  it("builds a native directory request without fake scope or pagination params", () => {
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

  it("queries each unique logical root and known worktree directory", () => {
    assert.deepEqual(
      getUniqueSessionDirectories(["/repo", "/repo", "/repo/.codenomad/worktrees/feature"]),
      ["/repo", "/repo/.codenomad/worktrees/feature"],
    )
  })

  it("normalizes Windows paths when deduplicating directories", () => {
    assert.deepEqual(
      getUniqueSessionDirectories([String.raw`C:\Repo`, "c:/repo/", String.raw`C:\Repo\.codenomad\worktrees\feature`]),
      [String.raw`C:\Repo`, String.raw`C:\Repo\.codenomad\worktrees\feature`],
    )
  })

  it("marks the loaded session list complete because the API does not paginate", () => {
    const state = applySessionPage(getDefaultSessionPaginationState(), ["root-1", "root-2"], false, true)

    assert.deepEqual(state.ids, ["root-1", "root-2"])
    assert.equal(state.hasMore, false)
    assert.equal(state.nextCursor, undefined)
  })

  it("resets stale cursor state when the one-shot list refreshes", () => {
    const previous = applySessionPage(getDefaultSessionPaginationState(), ["old-root"], true, true, "old-cursor")
    const next = applySessionPage(previous, ["new-root"], false, true)

    assert.deepEqual(next.ids, ["new-root"])
    assert.equal(next.hasMore, false)
    assert.equal(next.nextCursor, undefined)
  })

})
