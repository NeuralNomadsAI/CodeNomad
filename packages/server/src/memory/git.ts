import path from "node:path"
import { lstat, mkdir, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { runGitProcess } from "../workspaces/git-process"
import { requireHostGit } from "../workspaces/git-requirement"
import { MemoryError } from "./model"
import { memoryGitEnvironment } from "./git-environment"

const BRANCH = "refs/heads/main"
const IDENTITY = { GIT_AUTHOR_NAME: "CodeNomad Memory", GIT_AUTHOR_EMAIL: "memory@codenomad.local",
  GIT_COMMITTER_NAME: "CodeNomad Memory", GIT_COMMITTER_EMAIL: "memory@codenomad.local" }

/** A private repository: every command names both paths and clears inherited Git overrides. */
export class MemoryGit {
  constructor(readonly directory: string) {}

  async run(args: string[], index?: string): Promise<string> {
    const env = memoryGitEnvironment()
    Object.assign(env, IDENTITY, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", GIT_NO_REPLACE_OBJECTS: "1", ...(index ? { GIT_INDEX_FILE: index } : {}) })
    try {
      return await runGitProcess(this.directory, [
        `--git-dir=${path.join(this.directory, ".git")}`, `--work-tree=${this.directory}`,
        "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
        "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.fsmonitor=false",
        "-c", "core.attributesFile=", "-c", "core.excludesFile=", "-c", "gc.auto=0", ...args,
      ], { env, timeout: 15_000, priority: "foreground" })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") await requireHostGit()
      throw error
    }
  }

  async initialize(): Promise<void> {
    await requireHostGit()
    const gitDirectory = path.join(this.directory, ".git")
    try {
      const info = await lstat(gitDirectory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new MemoryError("conflict", "Invalid memory repository")
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    try {
      await lstat(path.join(gitDirectory, "commondir"))
      throw new MemoryError("conflict", "Memory repository must be independent")
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // Git's idempotent init also completes an initialization interrupted by a crash.
    await this.run(["init", "--initial-branch=main", "--template="])
    if ((await this.run(["symbolic-ref", "HEAD"])).trim() !== BRANCH)
      throw new MemoryError("conflict", "Memory repository branch changed")
  }

  async head(): Promise<string | undefined> {
    try { return (await this.run(["rev-parse", "--verify", "--quiet", BRANCH])).trim() }
    catch (error) {
      if ((error as { code?: number }).code === 1) return undefined
      throw error
    }
  }

  /** Separate indexes keep interrupted writers away from the shared index and its lock. */
  async commit(relativePath: string, transactionId: string): Promise<void> {
    const index = path.join(this.directory, ".git", `memory-index-${randomUUID()}`)
    try {
      const before = await this.head()
      const message = `memory: update entry\n\nMemory-Transaction: ${transactionId}`
      const previous = before ? await this.run(["show", "-s", "--format=%T%n%B", before]) : undefined
      const separator = previous?.indexOf("\n") ?? -1
      const alreadyCommitted = previous?.slice(separator + 1).trim() === message
      await this.run(before ? ["read-tree", before] : ["read-tree", "--empty"], index)
      const file = path.join(this.directory, relativePath)
      try {
        await lstat(file)
        const blob = (await this.run(["hash-object", "-w", "--no-filters", "--", file])).trim()
        await this.run(["update-index", "--add", "--cacheinfo", `100644,${blob},${relativePath}`], index)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        await this.run(["update-index", "--force-remove", "--", relativePath], index)
      }
      const tree = (await this.run(["write-tree"], index)).trim()
      if (alreadyCommitted && tree !== previous!.slice(0, separator).trim())
        throw new MemoryError("conflict", "Memory transaction differs from its commit")
      if (!alreadyCommitted) {
        const commit = (await this.run(["commit-tree", tree, ...(before ? ["-p", before] : []), "-m", message])).trim()
        await this.run(["update-ref", "--no-deref", BRANCH, commit, before ?? "0".repeat(40)])
      }
      await rename(index, path.join(this.directory, ".git", "index"))
    } finally {
      await rm(index, { force: true }).catch(() => undefined)
      await rm(`${index}.lock`, { force: true }).catch(() => undefined)
    }
  }
}
