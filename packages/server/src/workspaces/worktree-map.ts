import { promises as fsp } from "fs"
import path from "path"
import { resolveRepoRoot, gitExcludePath } from "./git-worktrees"
import type { LogLike } from "./git-worktrees"

async function ensureGitExclude(repoRoot: string, logger?: LogLike): Promise<void> {
  const excludePath = await gitExcludePath(repoRoot)
  try {
    await fsp.mkdir(path.dirname(excludePath), { recursive: true })
  } catch {
    return
  }

  let existing: Buffer
  try {
    existing = await readGitExclude(excludePath)
  } catch (error) {
    logger?.debug?.({ err: error, excludePath }, "Failed to read .git/info/exclude")
    return
  }
  await appendCodenomadGitExclude(excludePath, existing, [".codenomad/worktrees/"])
}

/** The exclude file's bytes; a missing file is empty, any other read failure throws. */
export async function readGitExclude(excludePath: string): Promise<Buffer> {
  try {
    return await fsp.readFile(excludePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0)
    throw error
  }
}

/**
 * Appends the `entries` missing from `existing` (the file's current bytes) under
 * the `# codenomad` header. The existing bytes are never rewritten.
 */
export async function appendCodenomadGitExclude(excludePath: string, existing: Buffer, entries: readonly string[]): Promise<boolean> {
  const text = existing.toString("utf-8")
  const lines = new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
  const missing = entries.filter((e) => !lines.has(e))
  if (missing.length === 0) {
    return false
  }

  const separator = text && !text.endsWith("\n") ? "\n" : ""
  const header = text.includes("# codenomad") ? "" : (text.trim() ? "\n" : "") + "# codenomad\n"
  const suffix = missing.map((e) => `${e}\n`).join("")
  await fsp.appendFile(excludePath, `${separator}${header}${suffix}`, "utf-8")
  return true
}

export async function ensureCodenomadGitExclude(workspaceFolder: string, logger?: LogLike): Promise<void> {
  const { repoRoot, isGitRepo } = await resolveRepoRoot(workspaceFolder, logger)
  if (!isGitRepo) {
    return
  }
  await ensureGitExclude(repoRoot, logger)
}
