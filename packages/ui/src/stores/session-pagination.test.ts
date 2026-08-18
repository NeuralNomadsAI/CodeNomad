import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { applySessionPage, getDefaultSessionPaginationState } from "./session-pagination-model.ts"
import {
  PROJECT_SESSION_LIST_LIMIT,
  buildProjectSessionListOptions,
} from "./session-list-options.ts"

describe("project session list loading", () => {
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
    assert.deepEqual(buildProjectSessionListOptions({ directory: "/tmp/project", cursor: "next-page" }), {
      directory: "/tmp/project",
      cursor: "next-page",
      limit: PROJECT_SESSION_LIST_LIMIT,
    })
  })

  it("retains the native cursor without dropping prior roots", () => {
    const first = applySessionPage(getDefaultSessionPaginationState(), ["root-1"], true, true, "page-2")
    const next = applySessionPage(first, ["root-2"], false, false)
    assert.deepEqual(next, { ids: ["root-1", "root-2"], hasMore: false, nextCursor: undefined })
  })

})
