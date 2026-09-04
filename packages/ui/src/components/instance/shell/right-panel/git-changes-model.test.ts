import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { adaptSdkGitStatusEntries } from "./git-changes-model.ts"

describe("adaptSdkGitStatusEntries", () => {
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
