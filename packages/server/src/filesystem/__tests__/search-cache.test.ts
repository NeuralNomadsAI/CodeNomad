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

    refreshWorkspaceCandidates(workspacePath, () => [createEntry("file-a")], startTime)

    const beforeExpiry = getWorkspaceCandidates(
      workspacePath,
      startTime + WORKSPACE_CANDIDATE_CACHE_TTL_MS - 1,
    )
    assert.ok(beforeExpiry)
    assert.equal(beforeExpiry.length, 1)
    assert.equal(beforeExpiry[0].name, "file-a")

    const afterExpiry = getWorkspaceCandidates(
      workspacePath,
      startTime + WORKSPACE_CANDIDATE_CACHE_TTL_MS + 1,
    )
    assert.equal(afterExpiry, undefined)
  })

  it("replaces cached entries when manually refreshed", () => {
    const workspacePath = "/tmp/workspace"

    refreshWorkspaceCandidates(workspacePath, () => [createEntry("file-a")], 5_000)
    const initial = getWorkspaceCandidates(workspacePath)
    assert.ok(initial)
    assert.equal(initial[0].name, "file-a")

    refreshWorkspaceCandidates(workspacePath, () => [createEntry("file-b")], 6_000)
    const refreshed = getWorkspaceCandidates(workspacePath)
    assert.ok(refreshed)
    assert.equal(refreshed[0].name, "file-b")
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
