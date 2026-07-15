import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { applySessionPage, getDefaultSessionPaginationState } from "./session-pagination-model.ts"
import {
  PROJECT_SESSION_LIST_LIMIT,
  buildProjectSessionListOptions,
  filterProjectScopedSessions,
  getAuthoritativelyMissingSessionIds,
  isProjectSessionListComplete,
} from "./session-list-options.ts"

describe("project session list loading", () => {
  it("builds a one-shot project-scoped request without pagination params", () => {
    const options = buildProjectSessionListOptions({ directory: "/tmp/project", search: "worktree" })

    assert.deepEqual(options, {
      directory: "/tmp/project",
      search: "worktree",
      limit: PROJECT_SESSION_LIST_LIMIT,
      scope: "project",
    })
    assert.equal("start" in options, false)
    assert.equal("cursor" in options, false)
  })

  it("filters project-scoped results to the root and known worktree directories", () => {
    const sessions = [
      { id: "root", directory: "/repo" },
      { id: "worktree", directory: "/repo/.codenomad/worktrees/feature" },
      { id: "sibling", directory: "/other" },
      { id: "unknown" },
    ]

    assert.deepEqual(
      filterProjectScopedSessions(sessions, ["/repo", "/repo/.codenomad/worktrees/feature"]).map((session) => session.id),
      ["root", "worktree", "unknown"],
    )
  })

  it("normalizes Windows paths when filtering project-scoped results", () => {
    const sessions = [
      { id: "root", directory: String.raw`C:\Repo` },
      { id: "worktree", directory: "c:/repo/.codenomad/worktrees/feature/" },
      { id: "other", directory: String.raw`C:\Other` },
    ]

    assert.deepEqual(
      filterProjectScopedSessions(sessions, ["c:/repo/", String.raw`C:\Repo\.codenomad\worktrees\feature`]).map(
        (session) => session.id,
      ),
      ["root", "worktree"],
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

  it("reconciles sessions deleted while disconnected only from a complete refresh", () => {
    const existing = ["retained", "outside-current-worktree", "deleted-remotely"]
    const listed = ["retained", "outside-current-worktree"]

    assert.deepEqual(getAuthoritativelyMissingSessionIds(existing, listed, true), ["deleted-remotely"])
    assert.equal(isProjectSessionListComplete(PROJECT_SESSION_LIST_LIMIT - 1), true)
    assert.equal(isProjectSessionListComplete(PROJECT_SESSION_LIST_LIMIT), false)
    assert.deepEqual(
      getAuthoritativelyMissingSessionIds(existing, listed, false),
      [],
      "a result capped at the request limit may be truncated",
    )
  })
})
