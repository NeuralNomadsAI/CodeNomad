import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createManagedWorktree, listWorktrees } from "../git-worktrees"

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

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

describe("createManagedWorktree", () => {
  it("reuses an existing managed worktree directory", async () => {
    const repoDir = await createTempRepo()

    const first = await createManagedWorktree({ repoRoot: repoDir, workspaceFolder: repoDir, slug: "codenomad/pr-123" })
    const second = await createManagedWorktree({ repoRoot: repoDir, workspaceFolder: repoDir, slug: "codenomad/pr-123" })

    assert.equal(second.directory, first.directory)
    assert.equal(second.slug, first.slug)
    assert.equal(second.branch, "codenomad/pr-123")
  })

  it("recreates an orphaned managed worktree directory", async () => {
    const repoDir = await createTempRepo()
    const targetDir = path.join(repoDir, ".codenomad", "worktrees", "codenomad-pr-456")

    await mkdir(targetDir, { recursive: true })
    await writeFile(path.join(targetDir, "leftover.txt"), "orphaned\n", "utf-8")

    const created = await createManagedWorktree({ repoRoot: repoDir, workspaceFolder: repoDir, slug: "codenomad/pr-456" })

    assert.equal(created.directory, targetDir)
    assert.equal(created.branch, "codenomad/pr-456")

    const commonDir = await git(created.directory, ["rev-parse", "--git-common-dir"])
    const resolvedCommonDir = await realpath(path.resolve(created.directory, commonDir))
    assert.equal(resolvedCommonDir, await realpath(path.join(repoDir, ".git")))
    await assert.rejects(() => access(path.join(created.directory, "leftover.txt")))
  })

  it("rebuilds a managed worktree when its branch no longer matches the slug", async () => {
    const repoDir = await createTempRepo()

    const first = await createManagedWorktree({ repoRoot: repoDir, workspaceFolder: repoDir, slug: "codenomad/pr-214" })
    await git(first.directory, ["checkout", "-B", "codenomad/pr-214-test"])

    const rebuilt = await createManagedWorktree({ repoRoot: repoDir, workspaceFolder: repoDir, slug: "codenomad/pr-214" })

    assert.equal(rebuilt.directory, first.directory)
    assert.equal(rebuilt.branch, "codenomad/pr-214")
    assert.equal(await git(rebuilt.directory, ["branch", "--show-current"]), "codenomad/pr-214")
  })
})

async function createTempRepo(): Promise<string> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "codenomad-worktree-test-"))
  tempDirs.push(repoDir)

  await git(repoDir, ["init"])
  await git(repoDir, ["checkout", "-b", "main"])
  await writeFile(path.join(repoDir, "README.md"), "# test\n", "utf-8")
  await git(repoDir, ["add", "README.md"])
  await git(repoDir, ["-c", "user.name=CodeNomad Test", "-c", "user.email=test@example.com", "commit", "-m", "init"])
  return repoDir
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd })
  return stdout.trim()
}
