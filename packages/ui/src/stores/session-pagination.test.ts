import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { applySessionPage, getDefaultSessionPaginationState } from "./session-pagination-model.ts"
import {
  PROJECT_SESSION_LIST_LIMIT,
  buildProjectSessionListOptions,
  filterProjectScopedSessions,
  getAuthoritativelyMissingSessionIds,
} from "./session-list-options.ts"

describe("project session list loading", () => {
  it("builds a project-scoped cursor request", () => {
    const options = buildProjectSessionListOptions({ project: "project-id", search: "worktree", cursor: "next" })

    assert.deepEqual(options, {
      project: "project-id",
      search: "worktree",
      cursor: "next",
      limit: PROJECT_SESSION_LIST_LIMIT,
      order: "asc",
    })
    assert.equal("start" in options, false)
  })

  it("filters project-scoped results to the root and known worktree directories", () => {
    const sessions = [
      { id: "root", location: { directory: "/repo" } },
      { id: "worktree", location: { directory: "/repo/.codenomad/worktrees/feature" } },
      { id: "sibling", location: { directory: "/other" } },
      { id: "unknown" },
    ]

    assert.deepEqual(
      filterProjectScopedSessions(sessions, ["/repo", "/repo/.codenomad/worktrees/feature"]).map((session) => session.id),
      ["root", "worktree", "unknown"],
    )
  })

  it("normalizes Windows paths when filtering project-scoped results", () => {
    const sessions = [
      { id: "root", location: { directory: String.raw`C:\Repo` } },
      { id: "worktree", location: { directory: "c:/repo/.codenomad/worktrees/feature/" } },
      { id: "other", location: { directory: String.raw`C:\Other` } },
    ]

    assert.deepEqual(
      filterProjectScopedSessions(sessions, ["c:/repo/", String.raw`C:\Repo\.codenomad\worktrees\feature`]).map(
        (session) => session.id,
      ),
      ["root", "worktree"],
    )
  })

  it("marks the projection complete after all API pages are collected", () => {
    const state = applySessionPage(getDefaultSessionPaginationState(), ["root-1", "root-2"], false, true)

    assert.deepEqual(state.ids, ["root-1", "root-2"])
    assert.equal(state.hasMore, false)
    assert.equal(state.nextCursor, undefined)
  })

  it("resets stale UI cursor state after a complete project refresh", () => {
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
    assert.deepEqual(
      getAuthoritativelyMissingSessionIds(existing, listed, false),
      [],
      "a result capped at the request limit may be truncated",
    )
  })
})
