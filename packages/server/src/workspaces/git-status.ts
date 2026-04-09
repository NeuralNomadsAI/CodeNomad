import { spawn } from "child_process"

import type { GitChangeKind, WorktreeGitStatusEntry } from "../api-types"
import type { LogLike } from "./git-worktrees"

type GitResult = { ok: true; stdout: string } | { ok: false; error: Error; stdout?: string; stderr?: string }
type GitSuccessResult = Extract<GitResult, { ok: true }>

function runGit(args: string[], cwd: string): Promise<GitResult> {
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
      if (code === 0) {
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
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const parts = rawLine.split("\t")
    const statusCode = parseGitChangeKind(parts[0] ?? "")
    if (!statusCode) continue

    const path = statusCode === "renamed" || statusCode === "copied" ? parts[2] ?? parts[1] ?? "" : parts[1] ?? ""
    const normalizedPath = path.trim()
    if (!normalizedPath) continue
    ensureEntry(map, normalizedPath)[target] = statusCode
  }
}

function applyUntrackedOutput(map: Map<string, WorktreeGitStatusEntry>, output: string) {
  for (const rawLine of output.split(/\r?\n/)) {
    const path = rawLine.trim()
    if (!path) continue
    ensureEntry(map, path).unstagedStatus = "untracked"
  }
}

function applyNumstatOutput(
  map: Map<string, WorktreeGitStatusEntry>,
  output: string,
  target: "staged" | "unstaged",
) {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const parts = rawLine.split("\t")
    const path = (parts[2] ?? parts[1] ?? "").trim()
    if (!path) continue

    const additions = parts[0] === "-" ? 0 : Number.parseInt(parts[0] ?? "0", 10)
    const deletions = parts[1] === "-" ? 0 : Number.parseInt(parts[1] ?? "0", 10)
    const entry = ensureEntry(map, path)

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
    runGit(["diff", "--name-status", "--cached", "--find-renames", "--find-copies"], workspaceFolder),
    runGit(["diff", "--name-status", "--find-renames", "--find-copies"], workspaceFolder),
    runGit(["ls-files", "--others", "--exclude-standard"], workspaceFolder),
    runGit(["diff", "--numstat", "--cached", "--find-renames", "--find-copies"], workspaceFolder),
    runGit(["diff", "--numstat", "--find-renames", "--find-copies"], workspaceFolder),
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

  return Array.from(entries.values()).sort((a, b) => a.path.localeCompare(b.path))
}
