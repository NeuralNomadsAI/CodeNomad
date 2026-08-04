import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { createManagedWorktree, isValidWorktreeSlug, listWorktrees, resolveRepoRoot } from "../git-worktrees"

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!existsSync(file) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(existsSync(file), true, `Timed out waiting for ${file}`)
}

function installHangingGit(temp: string): { binDir: string; started: string; survived: string } {
  const binDir = path.join(temp, "bin")
  const script = path.join(temp, "hanging-git.cjs")
  const started = path.join(temp, "started")
  const survived = path.join(temp, "descendant-survived")
  mkdirSync(binDir, { recursive: true })
  writeFileSync(script, [
    'const { spawn } = require("node:child_process")',
    'const { writeFileSync } = require("node:fs")',
    `writeFileSync(${JSON.stringify(started)}, "started")`,
    "process.on(\"SIGTERM\", () => {})",
    `spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(survived)}, "survived"), 700); setInterval(() => {}, 10_000)`) }], { stdio: "ignore" })`,
    "setInterval(() => {}, 10_000)",
  ].join("\n"))

  const gitPath = path.join(binDir, process.platform === "win32" ? "git.cmd" : "git")
  if (process.platform === "win32") {
    writeFileSync(gitPath, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  } else {
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
    writeFileSync(gitPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 })
  }
  return { binDir, started, survived }
}

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
        writeFileSync(gitPath, `@echo off\r\nif "%~1"=="worktree" if "%~2"=="list" if "%~3"=="--porcelain" (\r\necho ${porcelain.replace(/\n/g, "\r\necho ")}\r\nexit /b 0\r\n)\r\nexit /b 1\r\n`)
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

describe("resolveRepoRoot cancellation", () => {
  for (const boundary of ["abort", "timeout"] as const) {
    it(`terminates the complete git process tree on ${boundary} and waits for close`, async () => {
      const temp = mkdtempSync(path.join(tmpdir(), "codenomad-git-cancel-"))
      const originalPath = process.env.PATH
      const { binDir, started, survived } = installHangingGit(temp)
      const controller = new AbortController()

      try {
        process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`
        const operation = resolveRepoRoot(temp, undefined, {
          signal: controller.signal,
          timeoutMs: boundary === "timeout" ? 40 : 5_000,
        })
        await waitForFile(started)
        if (boundary === "abort") controller.abort(new Error("abort requested"))

        await assert.rejects(operation, boundary === "abort" ? /abort requested/ : /timed out after 40ms/)
        await new Promise<void>((resolve) => setTimeout(resolve, 850))
        assert.equal(existsSync(survived), false, "git helper descendant continued after cancellation completed")
      } finally {
        process.env.PATH = originalPath
        rmSync(temp, { recursive: true, force: true })
      }
    })
  }
})

describe("createManagedWorktree", () => {
  it("rejects slugs that can alter a Windows shell command", () => {
    assert.equal(isValidWorktreeSlug("feature/review-1.2"), true)
    for (const slug of [
      "-config",
      "review branch",
      "review&calc",
      "review|calc",
      "review>file",
      "review<input",
      "review^calc",
      "review%PATH%",
      "review!PATH!",
      "review(calc)",
      'review"calc',
    ]) {
      assert.equal(isValidWorktreeSlug(slug), false, slug)
    }
  })

  it("rejects a managed worktree root that escapes through a symlink or junction", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "codenomad-managed-worktree-"))
    const repoRoot = path.join(temp, "repo")
    const outside = path.join(temp, "outside")

    try {
      mkdirSync(path.join(repoRoot, ".codenomad"), { recursive: true })
      mkdirSync(outside, { recursive: true })
      symlinkSync(outside, path.join(repoRoot, ".codenomad", "worktrees"), process.platform === "win32" ? "junction" : "dir")

      await assert.rejects(
        createManagedWorktree({ repoRoot, workspaceFolder: repoRoot, slug: "escaped" }),
        /escapes repository/,
      )
      assert.equal(existsSync(path.join(outside, "escaped")), false)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
