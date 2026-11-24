import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { adaptSdkGitStatusEntries, buildGitChangeListItems, hideWhitespaceOnlyChanges, reuseUnchanged } from "./git-changes-model.ts"

describe("reuseUnchanged", () => {
  const detail = (path: string, overrides = {}) => ({
    path, originalPath: null, stagedStatus: "modified" as const, stagedAdditions: 1, stagedDeletions: 0,
    unstagedStatus: "modified" as const, unstagedAdditions: 2, unstagedDeletions: 2, ...overrides,
  })
  // Each read adapts fresh objects, like every real status response.
  const read = (...details: ReturnType<typeof detail>[]) => adaptSdkGitStatusEntries([], details)
  const byPath = (entry: { path: string }) => entry.path
  const byId = (item: { id: string }) => item.id

  it("returns the previous array for a structurally identical status, so nothing is published", () => {
    const previous = read(detail("a.ts"), detail("b.ts", { originalPath: "old.ts" }))
    assert.equal(reuseUnchanged(previous, read(detail("a.ts"), detail("b.ts", { originalPath: "old.ts" })), byPath), previous)
    const items = buildGitChangeListItems(previous)
    assert.equal(reuseUnchanged(items, buildGitChangeListItems(read(detail("a.ts"), detail("b.ts", { originalPath: "old.ts" }))), byId), items)
    const empty: never[] = []
    assert.equal(reuseUnchanged(empty, [], byPath), empty)
    assert.deepEqual(reuseUnchanged(null, [], byPath), [])
  })

  it("keeps unchanged records and replaces only changed, added or moved ones", () => {
    const previous = buildGitChangeListItems(read(detail("a.ts"), detail("b.ts"), detail("c.ts")))
    const next = reuseUnchanged(previous, buildGitChangeListItems(read(detail("a.ts"), detail("b.ts", { unstagedAdditions: 3 }), detail("d.ts"))), byId)
    const kept = (id: string) => next.find(item => item.id === id) === previous.find(item => item.id === id)
    assert.deepEqual(next.map(item => item.id), ["staged:a.ts", "staged:b.ts", "staged:d.ts", "unstaged:a.ts", "unstaged:b.ts", "unstaged:d.ts"])
    assert.deepEqual(["staged:a.ts", "staged:b.ts", "unstaged:a.ts"].map(kept), [true, true, true], "the other side of a changed file keeps its row")
    assert.equal(kept("unstaged:b.ts"), false)
    assert.equal(next.find(item => item.id === "unstaged:b.ts")?.additions, 3)
    // A reorder publishes a new array of the same objects.
    const reordered = reuseUnchanged(previous, [...previous].reverse().map(item => ({ ...item })), byId)
    assert.notEqual(reordered, previous)
    assert.deepEqual(reordered, [...previous].reverse())
    assert.ok(reordered.every(item => previous.includes(item)))
    // Field presence counts: a flag that appears is a change.
    const entries = read(detail("a.ts"))
    assert.notEqual(reuseUnchanged(entries, read(detail("a.ts", { unstagedWhitespaceOnly: true })), byPath)[0], entries[0])
  })
})

describe("hideWhitespaceOnlyChanges", () => {
  const detail = (path: string, overrides = {}) => ({
    path, originalPath: null, stagedStatus: null, stagedAdditions: 0, stagedDeletions: 0,
    unstagedStatus: "modified" as const, unstagedAdditions: 2, unstagedDeletions: 2, ...overrides,
  })
  const entries = adaptSdkGitStatusEntries(
    [{ file: "indent.ts", additions: 2, deletions: 2, status: "modified" }],
    [detail("indent.ts", { unstagedWhitespaceOnly: true }), detail("real.ts"),
      detail("staged.ts", { stagedStatus: "modified", stagedAdditions: 1, unstagedWhitespaceOnly: true })],
  )

  it("drops flagged worktree rows but keeps the staged side of the same file", () => {
    const ids = (hide: boolean) => buildGitChangeListItems(hideWhitespaceOnlyChanges(entries, hide)).map(item => item.id)
    assert.deepEqual(ids(true), ["staged:staged.ts", "unstaged:real.ts"])
    assert.deepEqual(ids(false), ["staged:staged.ts", "unstaged:indent.ts", "unstaged:real.ts", "unstaged:staged.ts"])
    assert.equal(hideWhitespaceOnlyChanges(null, true), null)
    assert.equal(hideWhitespaceOnlyChanges(entries, false), entries, "off keeps the identical inventory")
  })
})

describe("adaptSdkGitStatusEntries", () => {
  it("does not resurrect stale native files after a worktree checkout or a clean local snapshot", () => {
    const native = [{ file: "old-checkout.ts", additions: 100, deletions: 100, status: "modified" as const }]
    const detail = {
      path: "proof.txt", originalPath: null, stagedStatus: null, stagedAdditions: 0, stagedDeletions: 0,
      unstagedStatus: "untracked" as const, unstagedAdditions: 1, unstagedDeletions: 0,
    }
    const items = buildGitChangeListItems(adaptSdkGitStatusEntries(native, [detail]))
    assert.deepEqual(items.map(item => ({ path: item.path, additions: item.additions })), [{ path: "proof.txt", additions: 1 }])
    assert.deepEqual(adaptSdkGitStatusEntries(native, []), [])
    assert.equal(adaptSdkGitStatusEntries(native, null)[0].path, "old-checkout.ts", "retain native-only callers without a local snapshot")
  })

  it("adapts native V2 status fields and preserves CodeNomad stage details", () => {
    assert.deepEqual(
      adaptSdkGitStatusEntries(
        [{ file: "src\\app.ts", additions: 4, deletions: 2, status: "modified" }],
        [{
          path: "src/app.ts",
          originalPath: null,
          stagedStatus: "modified",
          stagedAdditions: 1,
          stagedDeletions: 0,
          unstagedStatus: "modified",
          unstagedAdditions: 3,
          unstagedDeletions: 2,
        }],
      ),
      [{
        path: "src/app.ts",
        originalPath: null,
        additions: 4,
        deletions: 2,
        status: "modified",
        stagedStatus: "modified",
        stagedAdditions: 1,
        stagedDeletions: 0,
        unstagedStatus: "modified",
        unstagedAdditions: 3,
        unstagedDeletions: 2,
      }],
    )
  })
})
