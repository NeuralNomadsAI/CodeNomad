import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { cloneGitRepository } from "../git-clone"

describe("cloneGitRepository", () => {
  it(
    "supports destinations directly under a Windows drive root",
    { skip: process.platform !== "win32" },
    async () => {
      const temp = mkdtempSync(path.join(tmpdir(), "codenomad-git-clone-"))
      const sourceRepo = path.join(temp, "source.git")
      const root = path.parse(process.cwd()).root
      const destinationPath = path.join(root, `codenomad-git-clone-root-${Date.now()}-${Math.random().toString(36).slice(2)}`)

      try {
        execFileSync("git", ["init", "--bare", sourceRepo], { stdio: "ignore" })
        rmSync(destinationPath, { recursive: true, force: true })

        const result = await cloneGitRepository({
          repositoryUrl: sourceRepo,
          destinationPath,
        })

        assert.equal(result.path, destinationPath)
        assert.equal(existsSync(destinationPath), true)
      } finally {
        rmSync(destinationPath, { recursive: true, force: true })
        rmSync(temp, { recursive: true, force: true })
      }
    },
  )
})
