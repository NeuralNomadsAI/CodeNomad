import { spawn } from "child_process"
import { readFile } from "fs/promises"
import path from "path"

import type { GitChangeKind, WorktreeGitDiffResponse, WorktreeGitDiffScope, WorktreeGitStatusEntry } from "../api-types"
import type { LogLike } from "./git-worktrees"
import { normalizeGitWorktreeRelativePath } from "./git-mutations"

type GitResult = { ok: true; stdout: string } | { ok: false; error: Error; stdout?: string; stderr?: string }
type GitSuccessResult = Extract<GitResult, { ok: true }>

async function readFileAsDiffText(filePath: string): Promise<string> {
  return readFile(filePath, "utf-8")
}

async function readGitBlobAsDiffText(resultPromise: Promise<GitResult>, missingOk = false): Promise<string> {
  const result = await resultPromise
  if (!result.ok) {
    return decodeGitShowResult(result, missingOk)
  }
  return result.stdout
}

function runGit(args: string[], cwd: string, acceptedExitCodes: number[] = [0]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.once("error", (error) => {
      resolve({ ok: false, error, stdout, stderr })
    })
    child.once("close", (code) => {
      if (acceptedExitCodes.includes(code ?? 0)) {
        resolve({ ok: true, stdout })
      } else {
        const error = new Error(stderr.trim() || `git ${args.join(" ")} failed with code ${code}`)
        resolve({ ok: false, error, stdout, stderr })
      }
    })
  })
}

function ensureEntry(map: Map<string, WorktreeGitStatusEntry>, path: string): WorktreeGitStatusEntry {
  const existing = map.get(path)
  if (existing) return existing
  const next: WorktreeGitStatusEntry = {
    path,
    originalPath: null,
    stagedStatus: null,
    stagedAdditions: 0,
    stagedDeletions: 0,
    unstagedStatus: null,
    unstagedAdditions: 0,
    unstagedDeletions: 0,
  }
  map.set(path, next)
  return next
}

function normalizeGitStatusPath(value: string): string {
  return value.trim().replace(/\\+/g, "/")
}

function parseGitChangeKind(code: string): GitChangeKind | null {
  const normalized = code.trim().toUpperCase()
  if (!normalized) return null
  if (normalized === "A") return "added"
  if (normalized === "M") return "modified"
  if (normalized === "D") return "deleted"
  if (normalized.startsWith("R")) return "renamed"
  if (normalized.startsWith("C")) return "copied"
  if (normalized === "U") return "unmerged"
  return null
}

function applyNameStatusOutput(
  map: Map<string, WorktreeGitStatusEntry>,
  output: string,
  target: "stagedStatus" | "unstagedStatus",
) {
  const tokens = output.split("\0")
  let index = 0

  while (index < tokens.length) {
    const record = tokens[index++] ?? ""
    if (!record) continue

    const parts = record.split("\t")
    const statusCode = parseGitChangeKind(parts[0] ?? "")
    if (!statusCode) continue

    const inlinePath = parts.slice(1).join("\t")
    const firstPath = inlinePath || tokens[index++] || ""
    const secondPath = statusCode === "renamed" || statusCode === "copied" ? tokens[index++] || "" : ""
    const path = statusCode === "renamed" || statusCode === "copied" ? secondPath || firstPath : firstPath
    const normalizedPath = normalizeGitStatusPath(path)
    if (!normalizedPath) continue
    const entry = ensureEntry(map, normalizedPath)
    entry[target] = statusCode
    if (statusCode === "renamed" || statusCode === "copied") {
      const originalPath = normalizeGitStatusPath(firstPath)
      entry.originalPath = originalPath || entry.originalPath || null
    }
  }
}

function applyUntrackedOutput(map: Map<string, WorktreeGitStatusEntry>, output: string) {
  for (const rawLine of output.split(/\r?\n/)) {
    const path = normalizeGitStatusPath(rawLine)
    if (!path) continue
    ensureEntry(map, path).unstagedStatus = "untracked"
  }
}

function parseSingleNumstat(output: string): { additions: number; deletions: number; isBinary: boolean; found: boolean } {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const parts = rawLine.split("\t")
    const isBinary = parts[0] === "-" || parts[1] === "-"
    return {
      additions: isBinary ? 0 : Number.parseInt(parts[0] ?? "0", 10) || 0,
      deletions: isBinary ? 0 : Number.parseInt(parts[1] ?? "0", 10) || 0,
      isBinary,
      found: true,
    }
  }

  return { additions: 0, deletions: 0, isBinary: false, found: false }
}

async function getUntrackedFileNumstat(workspaceFolder: string, relativePath: string): Promise<{ additions: number; deletions: number }> {
  const absolutePath = path.join(workspaceFolder, relativePath)
  const result = await runGit(["diff", "--numstat", "--no-index", "--", "/dev/null", absolutePath], workspaceFolder, [0, 1])
  if (!result.ok) {
    throw result.error
  }

  const parsed = parseSingleNumstat(result.stdout)
  return { additions: parsed.additions, deletions: parsed.deletions }
}

async function applyUntrackedFileStats(map: Map<string, WorktreeGitStatusEntry>, workspaceFolder: string) {
  const pending = Array.from(map.values())
    .filter((entry) => entry.unstagedStatus === "untracked")
    .map(async (entry) => {
      try {
        const stats = await getUntrackedFileNumstat(workspaceFolder, entry.path)
        entry.unstagedAdditions = stats.additions
        entry.unstagedDeletions = stats.deletions
      } catch {
        entry.unstagedAdditions = 0
        entry.unstagedDeletions = 0
      }
    })
  await Promise.all(pending)
}

function applyNumstatOutput(
  map: Map<string, WorktreeGitStatusEntry>,
  output: string,
  target: "staged" | "unstaged",
) {
  const tokens = output.split("\0")
  let index = 0

  while (index < tokens.length) {
    const record = tokens[index++] ?? ""
    if (!record) continue

    const parts = record.split("\t")
    if (parts.length < 3) continue

    const additions = parts[0] === "-" ? 0 : Number.parseInt(parts[0] ?? "0", 10)
    const deletions = parts[1] === "-" ? 0 : Number.parseInt(parts[1] ?? "0", 10)
    const inlinePath = parts.slice(2).join("\t")
    const isRenameLike = inlinePath === ""
    const originalPath = isRenameLike ? normalizeGitStatusPath(tokens[index++] ?? "") : null
    const normalizedPath = normalizeGitStatusPath(isRenameLike ? tokens[index++] ?? "" : inlinePath)
    if (!normalizedPath) continue

    const entry = ensureEntry(map, normalizedPath)
    if (originalPath) {
      entry.originalPath = originalPath
    }

    if (target === "staged") {
      entry.stagedAdditions = Number.isFinite(additions) ? additions : 0
      entry.stagedDeletions = Number.isFinite(deletions) ? deletions : 0
    } else {
      entry.unstagedAdditions = Number.isFinite(additions) ? additions : 0
      entry.unstagedDeletions = Number.isFinite(deletions) ? deletions : 0
    }
  }
}

export async function getWorktreeGitStatus(params: {
  workspaceFolder: string
  logger?: LogLike
}): Promise<WorktreeGitStatusEntry[]> {
  const { workspaceFolder, logger } = params
  const [stagedResult, unstagedResult, untrackedResult, stagedNumstatResult, unstagedNumstatResult] = await Promise.all([
    runGit(["diff", "--name-status", "-z", "--cached", "--find-renames", "--find-copies"], workspaceFolder),
    runGit(["diff", "--name-status", "-z", "--find-renames", "--find-copies"], workspaceFolder),
    runGit(["ls-files", "--others", "--exclude-standard"], workspaceFolder),
    runGit(["diff", "--numstat", "-z", "--cached", "--find-renames", "--find-copies"], workspaceFolder),
    runGit(["diff", "--numstat", "-z", "--find-renames", "--find-copies"], workspaceFolder),
  ])

  for (const result of [stagedResult, unstagedResult, untrackedResult, stagedNumstatResult, unstagedNumstatResult]) {
    if (!result.ok) {
      logger?.warn?.({ workspaceFolder, err: result.error }, "Failed to read git status for worktree")
      throw result.error
    }
  }

  const stagedOutput = (stagedResult as GitSuccessResult).stdout
  const unstagedOutput = (unstagedResult as GitSuccessResult).stdout
  const untrackedOutput = (untrackedResult as GitSuccessResult).stdout
  const stagedNumstatOutput = (stagedNumstatResult as GitSuccessResult).stdout
  const unstagedNumstatOutput = (unstagedNumstatResult as GitSuccessResult).stdout

  const entries = new Map<string, WorktreeGitStatusEntry>()
  applyNameStatusOutput(entries, stagedOutput, "stagedStatus")
  applyNameStatusOutput(entries, unstagedOutput, "unstagedStatus")
  applyUntrackedOutput(entries, untrackedOutput)
  applyNumstatOutput(entries, stagedNumstatOutput, "staged")
  applyNumstatOutput(entries, unstagedNumstatOutput, "unstaged")
  await applyUntrackedFileStats(entries, workspaceFolder)

  return Array.from(entries.values()).sort((a, b) => a.path.localeCompare(b.path))
}

function decodeGitShowResult(result: GitResult, missingOk = false): string {
  if (result.ok) return result.stdout
  const message = result.stderr?.trim() || result.error.message || ""
  if (
    missingOk &&
    (message.includes("exists on disk, but not in") ||
      message.includes("Path '") ||
      message.includes("does not exist") ||
      message.includes("unknown revision or path not in the working tree"))
  ) {
    return ""
  }
  throw result.error
}

async function readGitIndexBlob(workspaceFolder: string, normalizedPath: string): Promise<GitResult> {
  return runGit(["cat-file", "-p", `:${normalizedPath}`], workspaceFolder)
}

async function getTrackedDiffMetadata(params: {
  workspaceFolder: string
  scope: WorktreeGitDiffScope
  normalizedPath: string
  normalizedOriginalPath: string | null
}): Promise<{ isBinary: boolean; found: boolean }> {
  const args = ["diff", "--numstat"]
  if (params.scope === "staged") {
    args.push("--cached")
  }
  args.push("--find-renames", "--find-copies", "--")
  args.push(params.normalizedPath)
  if (params.normalizedOriginalPath && params.normalizedOriginalPath !== params.normalizedPath) {
    args.push(params.normalizedOriginalPath)
  }

  const result = await runGit(args, params.workspaceFolder)
  if (!result.ok) {
    throw result.error
  }

  const parsed = parseSingleNumstat(result.stdout)
  return { isBinary: parsed.isBinary, found: parsed.found }
}

async function getUntrackedDiffMetadata(params: {
  workspaceFolder: string
  normalizedPath: string
}): Promise<{ isBinary: boolean }> {
  const absolutePath = path.join(params.workspaceFolder, params.normalizedPath)
  const result = await runGit(["diff", "--numstat", "--no-index", "--", "/dev/null", absolutePath], params.workspaceFolder, [0, 1])
  if (!result.ok) {
    throw result.error
  }

  return { isBinary: parseSingleNumstat(result.stdout).isBinary }
}

async function resolveUnstagedBeforePath(params: {
  workspaceFolder: string
  normalizedPath: string
  normalizedOriginalPath: string | null
}): Promise<GitResult> {
  const currentPathResult = await readGitIndexBlob(params.workspaceFolder, params.normalizedPath)
  if (currentPathResult.ok || !params.normalizedOriginalPath || params.normalizedOriginalPath === params.normalizedPath) {
    return currentPathResult
  }
  return readGitIndexBlob(params.workspaceFolder, params.normalizedOriginalPath)
}

export async function getWorktreeGitDiff(params: {
  workspaceFolder: string
  path: string
  originalPath?: string | null
  scope: WorktreeGitDiffScope
}): Promise<WorktreeGitDiffResponse> {
  const normalizedPath = normalizeGitWorktreeRelativePath(params.path)
  const normalizedOriginalPath = params.originalPath ? normalizeGitWorktreeRelativePath(params.originalPath) : null

  const trackedMetadata = await getTrackedDiffMetadata({
    workspaceFolder: params.workspaceFolder,
    scope: params.scope,
    normalizedPath,
    normalizedOriginalPath,
  })

  const diffMetadata =
    params.scope === "unstaged" && !trackedMetadata.found
      ? await getUntrackedDiffMetadata({
          workspaceFolder: params.workspaceFolder,
          normalizedPath,
        })
      : trackedMetadata

  if (diffMetadata.isBinary) {
    return {
      path: normalizedPath,
      originalPath: normalizedOriginalPath,
      scope: params.scope,
      before: "",
      after: "",
      isBinary: true,
    }
  }

  if (params.scope === "staged") {
    const [beforeResult, afterResult] = await Promise.all([
      readGitBlobAsDiffText(runGit(["show", `HEAD:${normalizedOriginalPath ?? normalizedPath}`], params.workspaceFolder), true),
      readGitBlobAsDiffText(readGitIndexBlob(params.workspaceFolder, normalizedPath), true),
    ])

    return {
      path: normalizedPath,
      originalPath: normalizedOriginalPath,
      scope: params.scope,
      before: beforeResult,
      after: afterResult,
      isBinary: false,
    }
  }

  const indexResult = await resolveUnstagedBeforePath({
    workspaceFolder: params.workspaceFolder,
    normalizedPath,
    normalizedOriginalPath,
  })

  const beforeResult = await readGitBlobAsDiffText(Promise.resolve(indexResult), true)
  let after = beforeResult

  const fsPath = path.join(params.workspaceFolder, normalizedPath)
  try {
    after = await readFileAsDiffText(fsPath)
  } catch {
    after = ""
  }

  return {
    path: normalizedPath,
    originalPath: normalizedOriginalPath,
    scope: params.scope,
    before: beforeResult,
    after,
    isBinary: false,
  }
}
