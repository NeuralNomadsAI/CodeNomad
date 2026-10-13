import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { syncBuiltinESMExports } from "node:module"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { describe, it } from "node:test"

import { getWorktreeGitDiff, getWorktreeGitStatus, invalidateWorktreeGitStatus } from "./git-status"

describe("worktree git status singleflight", () => {
  it("reads real Git status and large UTF-8 blobs through the worker without losing final newlines", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codenomad-git-content-"))
    const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" })
    try {
      git("init")
      git("config", "user.name", "Fixture")
      git("config", "user.email", "fixture@example.test")
      git("config", "core.autocrlf", "false")
      const before = "é漢字 — content\n".repeat(100_000)
      await fs.writeFile(path.join(directory, "large.txt"), before)
      git("add", ".")
      git("commit", "-m", "fixture")
      await fs.writeFile(path.join(directory, "large.txt"), before + "changed\n")
      await fs.writeFile(path.join(directory, "untracked.txt"), "one\ntwo\n")
      const status = await getWorktreeGitStatus({ workspaceFolder: directory })
      assert.equal(status.find(entry => entry.path === "untracked.txt")?.unstagedAdditions, 2,
        "git diff --no-index exit 1 is a successful numstat result")
      const diff = await getWorktreeGitDiff({ workspaceFolder: directory, path: "large.txt", scope: "unstaged" })
      assert.equal(diff.before, before)
      assert.equal(diff.after, before + "changed\n")
      await assert.rejects(getWorktreeGitStatus({ workspaceFolder: path.join(directory, "missing") }))
      assert.equal((await getWorktreeGitStatus({ workspaceFolder: directory })).length, 2)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it("flags unstaged whitespace-only and CRLF-only edits only when asked", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codenomad-git-whitespace-"))
    const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" })
    const write = (name: string, contents: string | Buffer) => fs.writeFile(path.join(directory, name), contents)
    try {
      git("init")
      git("config", "user.name", "Fixture")
      git("config", "user.email", "fixture@example.test")
      git("config", "core.autocrlf", "false")
      await write("indent.ts", "if (x) {\n  call()\n}\n")
      await write("crlf.txt", "one\ntwo\n")
      await write("real.ts", "one\n")
      await write("binary.dat", Buffer.from([0, 1, 2, 3]))
      await write("staged.ts", "a {\n  b\n}\n")
      await write("both.ts", "a\nb\n")
      git("add", ".")
      git("commit", "-m", "fixture")
      await write("indent.ts", "if (x) {\n\tcall()   \n}\n")
      await write("crlf.txt", "one\r\ntwo\r\n")
      await write("real.ts", "two\n")
      await write("binary.dat", Buffer.from([0, 1, 2, 4]))
      await write("staged.ts", "a {\n    b\n}\n")
      git("add", "staged.ts")
      await write("both.ts", "a\nchanged\n")
      git("add", "both.ts")
      await write("both.ts", "a\n  changed\n")
      await write("untracked.txt", "   \n")

      const byPath = (entries: Awaited<ReturnType<typeof getWorktreeGitStatus>>) => new Map(entries.map(entry => [entry.path, entry]))
      const plain = byPath(await getWorktreeGitStatus({ workspaceFolder: directory }))
      assert.ok([...plain.values()].every(entry => entry.unstagedWhitespaceOnly === undefined), "detection only runs when requested")

      const status = byPath(await getWorktreeGitStatus({ workspaceFolder: directory, hideWhitespace: true }))
      assert.equal(status.get("indent.ts")?.unstagedWhitespaceOnly, true)
      assert.equal(status.get("crlf.txt")?.unstagedWhitespaceOnly, true, "line endings are whitespace for -w")
      assert.equal(status.get("real.ts")?.unstagedWhitespaceOnly, false)
      assert.equal(status.get("binary.dat")?.unstagedWhitespaceOnly, undefined, "binary changes stay visible")
      assert.equal(status.get("untracked.txt")?.unstagedStatus, "untracked")
      assert.equal(status.get("untracked.txt")?.unstagedWhitespaceOnly, undefined, "untracked files are never whitespace-only")
      assert.equal(status.get("staged.ts")?.stagedStatus, "modified")
      assert.equal(status.get("staged.ts")?.unstagedWhitespaceOnly, undefined, "staged whitespace-only changes are not flagged")
      assert.equal(status.get("both.ts")?.stagedStatus, "modified")
      assert.equal(status.get("both.ts")?.unstagedWhitespaceOnly, true, "the worktree side is compared with the index, not HEAD")
      // The flagged inventory still reports Git's real counts.
      assert.equal(status.get("crlf.txt")?.unstagedAdditions, 2)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it("keys concurrent reads by the whitespace option and keeps changes visible when detection fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codenomad-git-status-"))
    const calls: string[][] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const run = async (args: string[]) => {
      calls.push(args)
      await blocked
      if (args.includes("--ignore-all-space")) return { ok: false as const, error: new Error("unsupported") }
      if (args.includes("--name-status") && !args.includes("--cached")) return { ok: true as const, stdout: "M\0a.ts\0" }
      if (args.includes("--numstat") && !args.includes("--cached")) return { ok: true as const, stdout: "1\t1\ta.ts\0" }
      return { ok: true as const, stdout: "" }
    }
    try {
      const plain = getWorktreeGitStatus({ workspaceFolder: directory }, run)
      const hidden = getWorktreeGitStatus({ workspaceFolder: directory, hideWhitespace: true }, run)
      while (calls.length < 11) await new Promise<void>((resolve) => setImmediate(resolve))
      release()
      const [plainEntries, hiddenEntries] = await Promise.all([plain, hidden])
      assert.equal(calls.length, 11, "separate flights: five plain reads, then the same five plus one whitespace read")
      assert.equal(calls.filter(args => args.includes("--ignore-all-space")).length, 1)
      assert.equal(plainEntries[0]?.unstagedWhitespaceOnly, undefined)
      assert.equal(hiddenEntries[0]?.unstagedWhitespaceOnly, undefined, "a failed detection hides nothing")
      assert.equal(hiddenEntries[0]?.unstagedStatus, "modified")
    } finally {
      release()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("coalesces concurrent requests and runs again after settlement", async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "codenomad-git-status-"))
    let calls = 0
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    // Both callers must finish canonicalization before releasing the Git work.
    // Otherwise a fast first read can settle while the second realpath is still
    // in the filesystem queue, legitimately starting a separate flight.
    const realpath = fs.realpath
    let canonicalized = 0
    let ready!: () => void
    const bothCanonicalized = new Promise<void>((resolve) => { ready = resolve })
    const canonicalization = t.mock.method(fs, "realpath", async (value: string) => {
      const result = await realpath(value)
      canonicalized += 1
      if (canonicalized === 2) ready()
      await bothCanonicalized
      return result
    })
    // Native ESM named imports do not see default-export monkey patches until
    // synchronized. The CI runner uses ESM even when a local tsx run uses CJS.
    syncBuiltinESMExports()
    const run = async () => {
      calls += 1
      await blocked
      return { ok: true as const, stdout: "" }
    }

    try {
      const first = getWorktreeGitStatus({ workspaceFolder: directory }, run)
      const second = getWorktreeGitStatus({ workspaceFolder: path.join(directory, ".") }, run)
      const deadline = Date.now() + 1_000
      while (calls === 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      assert.equal(calls, 5)
      release()
      assert.deepEqual(await Promise.all([first, second]), [[], []])
      assert.equal(calls, 5)

      await getWorktreeGitStatus({ workspaceFolder: directory }, run)
      assert.equal(calls, 10)
    } finally {
      release()
      canonicalization.mock.restore()
      syncBuiltinESMExports()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("starts a new generation after a successful mutation while an older read is blocked", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codenomad-git-status-"))
    let calls = 0
    let releaseOld!: () => void
    const oldBlocked = new Promise<void>((resolve) => { releaseOld = resolve })
    const run = async () => {
      calls += 1
      if (calls <= 5) await oldBlocked
      return { ok: true as const, stdout: "" }
    }

    try {
      const oldRead = getWorktreeGitStatus({ workspaceFolder: directory }, run)
      while (calls < 5) await new Promise<void>((resolve) => setImmediate(resolve))
      await invalidateWorktreeGitStatus(path.join(directory, "."))
      const newRead = getWorktreeGitStatus({ workspaceFolder: directory }, run)
      assert.deepEqual(await newRead, [])
      assert.equal(calls, 10)
      releaseOld()
      assert.deepEqual(await oldRead, [])

      await getWorktreeGitStatus({ workspaceFolder: directory }, run)
      assert.equal(calls, 15)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("cleans up a rejected flight so the next read can retry", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codenomad-git-status-"))
    let fail = true
    let calls = 0
    const run = async () => {
      calls += 1
      return fail
        ? { ok: false as const, error: new Error("status failed") }
        : { ok: true as const, stdout: "" }
    }

    try {
      await assert.rejects(getWorktreeGitStatus({ workspaceFolder: directory }, run), /status failed/)
      fail = false
      assert.deepEqual(await getWorktreeGitStatus({ workspaceFolder: directory }, run), [])
      assert.equal(calls, 10)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
