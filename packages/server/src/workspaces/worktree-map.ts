import { execFile } from "child_process"
import { promises as fsp } from "fs"
import path from "path"
import { promisify } from "util"
import type { WorktreeMap } from "../api-types"
import { resolveRepoRoot } from "./git-worktrees"
import type { LogLike } from "./git-worktrees"

const DEFAULT_MAP: WorktreeMap = {
  version: 1,
  defaultWorktreeSlug: "root",
  parentSessionWorktreeSlug: {},
}

const execFileAsync = promisify(execFile)

function getLegacyMapPath(repoRoot: string): string {
  return path.join(repoRoot, ".codenomad", "worktreeMap.json")
}

async function getGitPath(workspaceFolder: string, relativePath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: workspaceFolder })
  const commonDir = stdout.trim()
  if (!commonDir) throw new Error("Git did not resolve its common directory")
  return path.join(path.isAbsolute(commonDir) ? commonDir : path.resolve(workspaceFolder, commonDir), relativePath)
}

async function ensureGitExclude(workspaceFolder: string, logger?: LogLike): Promise<void> {
  const excludePath = await getGitPath(workspaceFolder, "info/exclude")
  try {
    await fsp.mkdir(path.dirname(excludePath), { recursive: true })
  } catch {
    return
  }

  const entries = [
    ".codenomad/background_processes/",
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
  const { isGitRepo } = await resolveRepoRoot(workspaceFolder, logger)
  if (!isGitRepo) {
    return
  }
  await ensureGitExclude(workspaceFolder, logger)
}

function parseWorktreeMap(raw: string): WorktreeMap {
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid worktree map")
  const version = (parsed as any).version
  if (version !== 1) throw new Error("Unsupported worktree map version")
  const defaultWorktreeSlug = (parsed as any).defaultWorktreeSlug
  const parentSessionWorktreeSlug = (parsed as any).parentSessionWorktreeSlug
  if (typeof defaultWorktreeSlug !== "string"
    || !parentSessionWorktreeSlug
    || typeof parentSessionWorktreeSlug !== "object"
    || Array.isArray(parentSessionWorktreeSlug)
    || Object.values(parentSessionWorktreeSlug).some((slug) => typeof slug !== "string")) {
    throw new Error("Invalid worktree map")
  }
  return { version: 1, defaultWorktreeSlug, parentSessionWorktreeSlug: { ...parentSessionWorktreeSlug } }
}

export async function readWorktreeMap(workspaceFolder: string, logger?: LogLike): Promise<WorktreeMap> {
  const { repoRoot, isGitRepo } = await resolveRepoRoot(workspaceFolder, logger)
  const legacyPath = getLegacyMapPath(repoRoot)
  const filePath = isGitRepo ? await getGitPath(workspaceFolder, "codenomad/worktreeMap.json") : legacyPath
  try {
    return parseWorktreeMap(await fsp.readFile(filePath, "utf-8"))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      if (filePath !== legacyPath) {
        try {
          const legacy = parseWorktreeMap(await fsp.readFile(legacyPath, "utf-8"))
          // Migration happens on the next admitted write; reads never mutate shared state.
          return legacy
        } catch (legacyError) {
          if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") throw legacyError
        }
      }
      if (isGitRepo) {
        // Best-effort ignore setup on first use.
        await ensureGitExclude(workspaceFolder, logger).catch(() => undefined)
      }
      return DEFAULT_MAP
    }
    logger?.warn?.({ err: error, filePath }, "Failed to read worktree map")
    throw error
  }
}

export async function writeWorktreeMap(workspaceFolder: string, next: WorktreeMap, logger?: LogLike): Promise<void> {
  const { repoRoot, isGitRepo } = await resolveRepoRoot(workspaceFolder, logger)
  const legacyPath = getLegacyMapPath(repoRoot)
  const filePath = isGitRepo ? await getGitPath(workspaceFolder, "codenomad/worktreeMap.json") : legacyPath
  await fsp.mkdir(path.dirname(filePath), { recursive: true })

  // Ensure ignore rules are present (local-only).
  if (isGitRepo) {
    await ensureGitExclude(workspaceFolder, logger).catch(() => undefined)
  }

  if (Object.keys(next.parentSessionWorktreeSlug ?? {}).length === 0) {
    await deleteWorktreeMap(workspaceFolder, logger)
    return
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
  if (filePath !== legacyPath) await fsp.rm(legacyPath, { force: true })
}

export async function deleteWorktreeMap(workspaceFolder: string, logger?: LogLike): Promise<void> {
  const { repoRoot, isGitRepo } = await resolveRepoRoot(workspaceFolder, logger)
  const legacyPath = getLegacyMapPath(repoRoot)
  const filePath = isGitRepo ? await getGitPath(workspaceFolder, "codenomad/worktreeMap.json") : legacyPath
  try {
    await fsp.rm(filePath, { force: true })
    if (filePath !== legacyPath) await fsp.rm(legacyPath, { force: true })
  } catch (error) {
    logger?.warn?.({ err: error, filePath }, "Failed to delete worktree map")
    throw error
  }
}
