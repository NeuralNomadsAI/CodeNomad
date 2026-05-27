import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { listWorktrees } from "../git-worktrees"

describe("listWorktrees", () => {
  it("uses the selected workspace folder for the root worktree directory", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "codenomad-git-worktrees-"))
    const binDir = path.join(temp, "bin")
    const repoRoot = path.join(temp, "repo")
    const workspaceFolder = path.join(repoRoot, "proj-1")
    const originalPath = process.env.PATH

    try {
      mkdirSync(binDir, { recursive: true })
      mkdirSync(workspaceFolder, { recursive: true })

      const gitPath = path.join(binDir, process.platform === "win32" ? "git.cmd" : "git")
      const porcelain = [
        `worktree ${repoRoot}`,
        "HEAD 1111111",
        "branch refs/heads/main",
        "",
      ].join("\n")

      if (process.platform === "win32") {
        writeFileSync(gitPath, `@echo off\r\nif "%1"=="worktree" if "%2"=="list" if "%3"=="--porcelain" (\r\necho ${porcelain.replace(/\n/g, "\r\necho ")}\r\nexit /b 0\r\n)\r\nexit /b 1\r\n`)
      } else {
        writeFileSync(gitPath, `#!/bin/sh\nif [ "$1" = "worktree" ] && [ "$2" = "list" ] && [ "$3" = "--porcelain" ]; then\nprintf '%s\n' '${porcelain.replace(/'/g, "'\\''")}'\nexit 0\nfi\nexit 1\n`, { mode: 0o755 })
      }

      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`

      const worktrees = await listWorktrees({ repoRoot, workspaceFolder })

      assert.equal(worktrees[0]?.slug, "root")
      assert.equal(worktrees[0]?.directory, workspaceFolder)
      assert.equal(worktrees[0]?.kind, "root")
      assert.equal(worktrees[0]?.branch, "main")
      assert.notEqual(worktrees[0]?.directory, repoRoot)
    } finally {
      process.env.PATH = originalPath
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
