import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { adaptSdkGitStatusEntries, buildGitChangeListItems } from "./git-changes-model.ts"

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
