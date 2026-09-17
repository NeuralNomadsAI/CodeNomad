import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"
import type { FileSystemEntry } from "../../api-types"
import { searchWorkspaceFiles } from "../search"
import {
  clearWorkspaceSearchCache,
  getWorkspaceCandidates,
  refreshWorkspaceCandidates,
  WORKSPACE_CANDIDATE_CACHE_TTL_MS,
  WorkspaceSearchBusyError,
} from "../search-cache"

describe("workspace search cache", () => {
  beforeEach(() => {
    clearWorkspaceSearchCache()
  })

  it("a rejected extra query does not invalidate the successful in-flight scans", async () => {
    let release!: (entries: FileSystemEntry[]) => void
    const gate = new Promise<FileSystemEntry[]>(resolve => { release = resolve })
    const first = refreshWorkspaceCandidates("/busy-root", "file\0first", () => gate)
    const second = refreshWorkspaceCandidates("/another-root", "file\0second", () => gate)
    try {
      await assert.rejects(searchWorkspaceFiles("/busy-root", "third"), WorkspaceSearchBusyError)
    } finally { release([createEntry("needle")]); await Promise.all([first, second]) }
    assert.equal(getWorkspaceCandidates("/busy-root", "file\0first")?.[0].name, "needle")
  })

  it("coalesces scans, bounds parallel I/O and does not refill an invalidated cache", async () => {
    let release!: (entries: FileSystemEntry[]) => void
    const gate = new Promise<FileSystemEntry[]>((resolve) => { release = resolve })
    let calls = 0
    const builder = () => { calls += 1; return gate }
    const first = refreshWorkspaceCandidates("/workspace-one", "a", builder)
    const duplicate = refreshWorkspaceCandidates("/workspace-one", "a", builder)
    const second = refreshWorkspaceCandidates("/workspace-two", "b", builder)
    try {
      await assert.rejects(refreshWorkspaceCandidates("/workspace-three", "c", builder), WorkspaceSearchBusyError)
      assert.equal(calls, 2)
      clearWorkspaceSearchCache("/workspace-one")
    } finally {
      release([createEntry("needle")])
    }
    const results = await Promise.all([first, duplicate, second])
    results[0][0].name = "mutated"
    assert.equal(results[1][0].name, "needle")
    assert.equal(getWorkspaceCandidates("/workspace-one", "a"), undefined)
    assert.equal(getWorkspaceCandidates("/workspace-two", "b")?.[0].name, "needle")
    await assert.rejects(refreshWorkspaceCandidates("/workspace-three", "c", () => Promise.reject(new Error("disk"))), /disk/)
    assert.equal((await refreshWorkspaceCandidates("/workspace-three", "c", () => [createEntry("recovered")]))[0].name, "recovered")
  })

  it("expires cached candidates after the TTL", async () => {
    const workspacePath = "/tmp/workspace"
    const startTime = 1_000

    await refreshWorkspaceCandidates(workspacePath, "query-a", () => [createEntry("file-a")], startTime)

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

  it("replaces cached entries when manually refreshed", async () => {
    const workspacePath = "/tmp/workspace"

    await refreshWorkspaceCandidates(workspacePath, "query-a", () => [createEntry("file-a")], 5_000)
    const initial = getWorkspaceCandidates(workspacePath, "query-a", 5_001)
    assert.ok(initial)
    assert.equal(initial[0].name, "file-a")

    await refreshWorkspaceCandidates(workspacePath, "query-a", () => [createEntry("file-b")], 6_000)
    const refreshed = getWorkspaceCandidates(workspacePath, "query-a", 6_001)
    assert.ok(refreshed)
    assert.equal(refreshed[0].name, "file-b")
  })

  it("does not reuse candidates across query scopes", async () => {
    const workspacePath = "/tmp/workspace"

    await refreshWorkspaceCandidates(workspacePath, "query-a", () => [createEntry("file-a")], 5_000)
    assert.equal(getWorkspaceCandidates(workspacePath, "query-a", 5_001)?.[0].name, "file-a")
    assert.equal(getWorkspaceCandidates(workspacePath, "query-b", 5_001), undefined)

    await refreshWorkspaceCandidates(workspacePath, "query-b", () => [createEntry("file-b")], 5_000)
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
