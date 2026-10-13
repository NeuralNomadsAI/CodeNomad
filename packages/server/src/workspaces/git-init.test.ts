import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import { GitInitError, initializeNativeGit } from "./git-init"

// Synthetic folders and a fake native client only; never the shared daemon.
describe("native Git initialization", () => {
  let root: string
  before(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codenomad-git-init-"))) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  const fixture = async (name: string, options: { projectDirectory?: string; init?: () => Promise<void> } = {}) => {
    const folder = path.join(root, name)
    await mkdir(folder, { recursive: true })
    const calls: unknown[] = []
    const client = {
      location: { get: async () => ({ directory: folder, project: { id: "markerless", directory: options.projectDirectory ?? folder, canonical: folder } }) },
      vcs: { init: async (input: unknown) => {
        calls.push(input)
        if (options.init) return options.init()
        execFileSync("git", ["init", folder], { stdio: "ignore" })
      } },
    } as unknown as OpenCodeClient
    const context = { client, location: { directory: folder }, workspacePath: folder, toHost: async (directory: string) => directory }
    return { folder, calls, context }
  }

  it("initializes exactly the opened markerless folder through native vcs.init", async () => {
    const { folder, calls, context } = await fixture("plain")
    await initializeNativeGit(context)
    assert.deepEqual(calls, [{ location: { directory: folder }, provider: "git" }])
    assert.ok((await stat(path.join(folder, ".git"))).isDirectory())
    await assert.rejects(initializeNativeGit(context), (error: unknown) => error instanceof GitInitError
      && error.statusCode === 409 && error.code === "git_init_repository_exists")
    assert.equal(calls.length, 1, "an existing repository is refused before any native request")
  })

  it("refuses a native project directory other than the opened folder, such as its parent", async () => {
    const { calls, context } = await fixture("parent/child", { projectDirectory: path.join(root, "parent") })
    await assert.rejects(initializeNativeGit(context), (error: unknown) => error instanceof GitInitError
      && error.statusCode === 409 && error.code === "git_init_directory_mismatch")
    assert.equal(calls.length, 0)
    await assert.rejects(initializeNativeGit({ ...context, toHost: async () => null }), /different project directory/)
    assert.equal(calls.length, 0)
  })

  it("maps native unsupported providers to 501 and never retries uncertain failures", async () => {
    const unsupported = await fixture("unsupported", { init: async () => {
      throw { _tag: "VcsInitNotSupportedError", providerID: "git", message: "VCS provider does not support initialization" }
    } })
    await assert.rejects(initializeNativeGit(unsupported.context), (error: unknown) => error instanceof GitInitError
      && error.statusCode === 501 && error.code === "git_init_unsupported")
    assert.equal(unsupported.calls.length, 1)

    const conflict = await fixture("conflict", { init: async () => { throw { _tag: "ConflictError", message: "Project already has version control" } } })
    await assert.rejects(initializeNativeGit(conflict.context), (error: unknown) => error instanceof GitInitError && error.code === "git_init_repository_exists")

    const uncertain = await fixture("uncertain", { init: async () => { throw new TypeError("fetch failed") } })
    await assert.rejects(initializeNativeGit(uncertain.context), (error: unknown) => error instanceof GitInitError
      && error.statusCode === 502 && error.code === "git_init_failed" && /fetch failed/.test(error.message))
    assert.equal(uncertain.calls.length, 1, "uncertain native failures are reported once, not replayed")
  })

  it("does not initialize a folder nested inside an existing repository", async () => {
    const repo = path.join(root, "repo")
    await mkdir(repo)
    execFileSync("git", ["init", repo], { stdio: "ignore" })
    const { calls, context } = await fixture("repo/nested")
    await assert.rejects(initializeNativeGit(context), (error: unknown) => error instanceof GitInitError && error.code === "git_init_repository_exists")
    assert.equal(calls.length, 0)
  })
})
