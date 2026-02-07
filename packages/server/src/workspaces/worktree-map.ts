import fs from "fs"
import { promises as fsp } from "fs"
import path from "path"
import type { WorktreeMap } from "../api-types"
import { resolveRepoRoot } from "./git-worktrees"
import type { LogLike } from "./git-worktrees"

const DEFAULT_MAP: WorktreeMap = {
  version: 1,
  defaultWorktreeSlug: "root",
  parentSessionWorktreeSlug: {},
}

function getMapPath(repoRoot: string): string {
  return path.join(repoRoot, ".codenomad", "worktreeMap.json")
}

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

  const entries = [
    ".codenomad/worktrees/",
    ".codenomad/worktreeMap.json",
  ]

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

export async function readWorktreeMap(workspaceFolder: string, logger?: LogLike): Promise<WorktreeMap> {
  const { repoRoot, isGitRepo } = await resolveRepoRoot(workspaceFolder, logger)
  const filePath = getMapPath(repoRoot)
  try {
    const raw = await fsp.readFile(filePath, "utf-8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_MAP
    }
    const version = (parsed as any).version
    if (version !== 1) {
      return DEFAULT_MAP
    }
    const defaultWorktreeSlug = typeof (parsed as any).defaultWorktreeSlug === "string" ? (parsed as any).defaultWorktreeSlug : "root"
    const parentSessionWorktreeSlug = (parsed as any).parentSessionWorktreeSlug
    const mapping = parentSessionWorktreeSlug && typeof parentSessionWorktreeSlug === "object" ? parentSessionWorktreeSlug : {}
    return {
      version: 1,
      defaultWorktreeSlug,
      parentSessionWorktreeSlug: { ...mapping },
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      if (isGitRepo) {
        // Best-effort ignore setup on first use.
        await ensureGitExclude(repoRoot, logger).catch(() => undefined)
      }
      return DEFAULT_MAP
    }
    logger?.warn?.({ err: error, filePath }, "Failed to read worktree map")
    return DEFAULT_MAP
  }
}

export async function writeWorktreeMap(workspaceFolder: string, next: WorktreeMap, logger?: LogLike): Promise<void> {
  const { repoRoot, isGitRepo } = await resolveRepoRoot(workspaceFolder, logger)
  const filePath = getMapPath(repoRoot)
  await fsp.mkdir(path.dirname(filePath), { recursive: true })

  // Ensure ignore rules are present (local-only).
  if (isGitRepo) {
    await ensureGitExclude(repoRoot, logger).catch(() => undefined)
  }

  const payload: WorktreeMap = {
    version: 1,
    defaultWorktreeSlug: next.defaultWorktreeSlug || "root",
    parentSessionWorktreeSlug: next.parentSessionWorktreeSlug ?? {},
  }

  // Write atomically.
  const tmpPath = `${filePath}.${process.pid}.tmp`
  await fsp.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf-8")
  await fsp.rename(tmpPath, filePath)
}

export function worktreeMapExists(repoRoot: string): boolean {
  try {
    return fs.existsSync(getMapPath(repoRoot))
  } catch {
    return false
  }
}
