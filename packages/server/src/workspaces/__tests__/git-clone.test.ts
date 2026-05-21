import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { cloneGitRepository } from "../git-clone"

function createBareRepository(repoPath: string): void {
  execFileSync("git", ["init", "--bare", repoPath], { stdio: "ignore" })
}

async function expectCloneError(
  callback: () => Promise<unknown>,
  expectedStatusCode: number,
  messagePattern: RegExp,
): Promise<void> {
  await assert.rejects(callback, (error: unknown) => {
    assert.equal(typeof error, "object")
    assert.equal((error as { statusCode?: number }).statusCode, expectedStatusCode)
    assert.match(String((error as { message?: string }).message ?? ""), messagePattern)
    return true
  })
}

describe("cloneGitRepository", () => {
  it("clones into a missing destination", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "codenomad-git-clone-"))
    const sourceRepo = path.join(temp, "source.git")
    const destinationPath = path.join(temp, "cloned-repo")

    try {
      createBareRepository(sourceRepo)

      const result = await cloneGitRepository({
        repositoryUrl: sourceRepo,
        destinationPath,
      })

      assert.equal(result.path, destinationPath)
      assert.equal(existsSync(path.join(destinationPath, ".git")), true)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it("rejects non-empty destinations when cleanup is not enabled", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "codenomad-git-clone-"))
    const sourceRepo = path.join(temp, "source.git")
    const destinationPath = path.join(temp, "existing-destination")
    const sentinelPath = path.join(destinationPath, "keep.txt")

    try {
      createBareRepository(sourceRepo)
      mkdirSync(destinationPath, { recursive: true })
      writeFileSync(sentinelPath, "keep")

      await expectCloneError(
        () => cloneGitRepository({ repositoryUrl: sourceRepo, destinationPath }),
        409,
        /Destination folder is not empty/,
      )

      assert.equal(readFileSync(sentinelPath, "utf8"), "keep")
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it("preserves the existing destination when cleanup is enabled but clone fails", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "codenomad-git-clone-"))
    const missingRepo = path.join(temp, "missing.git")
    const destinationPath = path.join(temp, "existing-destination")
    const sentinelPath = path.join(destinationPath, "keep.txt")

    try {
      mkdirSync(destinationPath, { recursive: true })
      writeFileSync(sentinelPath, "keep")

      await expectCloneError(
        () => cloneGitRepository({ repositoryUrl: missingRepo, destinationPath, cleanup: true }),
        409,
        /does not appear to be a git repository|does not exist|not found/i,
      )

      assert.equal(readFileSync(sentinelPath, "utf8"), "keep")
      assert.equal(existsSync(destinationPath), true)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it("replaces the existing destination only after a successful cleanup clone", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "codenomad-git-clone-"))
    const sourceRepo = path.join(temp, "source.git")
    const destinationPath = path.join(temp, "existing-destination")
    const sentinelPath = path.join(destinationPath, "keep.txt")

    try {
      createBareRepository(sourceRepo)
      mkdirSync(destinationPath, { recursive: true })
      writeFileSync(sentinelPath, "keep")

      const result = await cloneGitRepository({
        repositoryUrl: sourceRepo,
        destinationPath,
        cleanup: true,
      })

      assert.equal(result.path, destinationPath)
      assert.equal(existsSync(path.join(destinationPath, ".git")), true)
      assert.equal(existsSync(sentinelPath), false)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it("rejects filesystem root destinations", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "codenomad-git-clone-"))
    const sourceRepo = path.join(temp, "source.git")

    try {
      createBareRepository(sourceRepo)

      await expectCloneError(
        () =>
          cloneGitRepository({
            repositoryUrl: sourceRepo,
            destinationPath: path.parse(process.cwd()).root,
            cleanup: true,
          }),
        400,
        /filesystem root/,
      )
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it("rejects home directory destinations", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "codenomad-git-clone-"))
    const sourceRepo = path.join(temp, "source.git")

    try {
      createBareRepository(sourceRepo)

      await expectCloneError(
        () =>
          cloneGitRepository({
            repositoryUrl: sourceRepo,
            destinationPath: homedir(),
            cleanup: true,
          }),
        400,
        /home folder/,
      )
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it(
    "supports destinations directly under a Windows drive root",
    { skip: process.platform !== "win32" },
    async () => {
      const temp = mkdtempSync(path.join(tmpdir(), "codenomad-git-clone-"))
      const sourceRepo = path.join(temp, "source.git")
      const root = path.parse(process.cwd()).root
      const destinationPath = path.join(root, `codenomad-git-clone-root-${Date.now()}-${Math.random().toString(36).slice(2)}`)

      try {
        createBareRepository(sourceRepo)
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
