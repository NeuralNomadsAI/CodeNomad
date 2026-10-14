import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { adaptSdkGitStatusEntries, buildGitChangeListItems, hideWhitespaceOnlyChanges } from "./git-changes-model.ts"

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
