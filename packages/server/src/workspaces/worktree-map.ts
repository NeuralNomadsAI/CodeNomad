import { promises as fsp } from "fs"
import path from "path"
import { resolveRepoRoot } from "./git-worktrees"
import type { LogLike } from "./git-worktrees"

function getGitExcludePath(repoRoot: string): string {
  return path.join(repoRoot, ".git", "info", "exclude")
}

async function ensureGitExclude(repoRoot: string, logger?: LogLike): Promise<void> {
  const excludePath = getGitExcludePath(repoRoot)
  try {
    await fsp.mkdir(path.dirname(excludePath), { recursive: true })
  } catch {
    return
  }

  const entries = [".codenomad/worktrees/"]

  let existing = ""
  try {
    existing = await fsp.readFile(excludePath, "utf-8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT") {
      logger?.debug?.({ err: error, excludePath }, "Failed to read .git/info/exclude")
      return
    }
    existing = ""
  }

  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
  const missing = entries.filter((e) => !lines.has(e))
  if (missing.length === 0) {
    return
  }

  const header = existing.includes("# codenomad") ? "" : (existing.trim() ? "\n" : "") + "# codenomad\n"
  const suffix = missing.map((e) => `${e}\n`).join("")
  await fsp.writeFile(excludePath, `${existing}${header}${suffix}`, "utf-8")
}

export async function ensureCodenomadGitExclude(workspaceFolder: string, logger?: LogLike): Promise<void> {
  const { repoRoot, isGitRepo } = await resolveRepoRoot(workspaceFolder, logger)
  if (!isGitRepo) {
    return
  }
  await ensureGitExclude(repoRoot, logger)
}
