import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"
import type { FileSystemEntry } from "../../api-types"
import {
  clearWorkspaceSearchCache,
  getWorkspaceCandidates,
  refreshWorkspaceCandidates,
  WORKSPACE_CANDIDATE_CACHE_TTL_MS,
} from "../search-cache"

describe("workspace search cache", () => {
  beforeEach(() => {
    clearWorkspaceSearchCache()
  })

  it("expires cached candidates after the TTL", () => {
    const workspacePath = "/tmp/workspace"
    const startTime = 1_000

    refreshWorkspaceCandidates(workspacePath, "query-a", () => [createEntry("file-a")], startTime)

    const beforeExpiry = getWorkspaceCandidates(
      workspacePath,
      "query-a",
      startTime + WORKSPACE_CANDIDATE_CACHE_TTL_MS - 1,
    )
    assert.ok(beforeExpiry)
    assert.equal(beforeExpiry.length, 1)
    assert.equal(beforeExpiry[0].name, "file-a")

    const afterExpiry = getWorkspaceCandidates(
      workspacePath,
      "query-a",
      startTime + WORKSPACE_CANDIDATE_CACHE_TTL_MS + 1,
    )
    assert.equal(afterExpiry, undefined)
  })

  it("replaces cached entries when manually refreshed", () => {
    const workspacePath = "/tmp/workspace"

    refreshWorkspaceCandidates(workspacePath, "query-a", () => [createEntry("file-a")], 5_000)
    const initial = getWorkspaceCandidates(workspacePath, "query-a", 5_001)
    assert.ok(initial)
    assert.equal(initial[0].name, "file-a")

    refreshWorkspaceCandidates(workspacePath, "query-a", () => [createEntry("file-b")], 6_000)
    const refreshed = getWorkspaceCandidates(workspacePath, "query-a", 6_001)
    assert.ok(refreshed)
    assert.equal(refreshed[0].name, "file-b")
  })

  it("does not reuse candidates across query scopes", () => {
    const workspacePath = "/tmp/workspace"

    refreshWorkspaceCandidates(workspacePath, "query-a", () => [createEntry("file-a")], 5_000)
    assert.equal(getWorkspaceCandidates(workspacePath, "query-a", 5_001)?.[0].name, "file-a")
    assert.equal(getWorkspaceCandidates(workspacePath, "query-b", 5_001), undefined)

    refreshWorkspaceCandidates(workspacePath, "query-b", () => [createEntry("file-b")], 5_000)
    assert.equal(getWorkspaceCandidates(workspacePath, "query-a", 5_001), undefined)
    assert.equal(getWorkspaceCandidates(workspacePath, "query-b", 5_001)?.[0].name, "file-b")

    clearWorkspaceSearchCache(workspacePath)
    assert.equal(getWorkspaceCandidates(workspacePath, "query-a", 5_001), undefined)
    assert.equal(getWorkspaceCandidates(workspacePath, "query-b", 5_001), undefined)
  })
})

function createEntry(name: string): FileSystemEntry {
  return {
    name,
    path: name,
    absolutePath: `/tmp/${name}`,
    type: "file",
    size: 1,
    modifiedAt: new Date().toISOString(),
  }
}
