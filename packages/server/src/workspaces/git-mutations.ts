import { spawn } from "child_process"
import path from "path"

type GitResult = { ok: true; stdout: string } | { ok: false; error: Error; stdout?: string; stderr?: string }

class GitMutationError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = "GitMutationError"
    this.statusCode = statusCode
  }
}

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

export function normalizeGitWorktreeRelativePath(input: string): string {
  const normalized = input.trim().replace(/\\+/g, "/").replace(/^\.\//, "")
  if (!normalized) {
    throw new GitMutationError("Path is required", 400)
  }
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    throw new GitMutationError(`Absolute paths are not allowed: ${input}`, 400)
  }
  if (normalized === "." || normalized === "..") {
    throw new GitMutationError(`Invalid path: ${input}`, 400)
  }
  if (normalized.startsWith("../") || normalized.includes("/../") || normalized.endsWith("/..")) {
    throw new GitMutationError(`Path traversal is not allowed: ${input}`, 400)
  }
  return normalized
}

function normalizeGitMutationPaths(paths: string[]): string[] {
  const deduped = new Set<string>()
  for (const rawPath of paths) {
    deduped.add(normalizeGitWorktreeRelativePath(rawPath))
  }
  const normalized = Array.from(deduped)
  if (normalized.length === 0) {
    throw new GitMutationError("At least one path is required", 400)
  }
  return normalized
}

async function ensureGitCommandSucceeded(resultPromise: Promise<GitResult>, fallbackMessage: string): Promise<string> {
  const result = await resultPromise
  if (!result.ok) {
    const message = result.stderr?.trim() || result.error.message || fallbackMessage
    throw new GitMutationError(message, 409)
  }
  return result.stdout
}

export function isGitMutationError(error: unknown): error is GitMutationError {
  return error instanceof GitMutationError
}

export async function stageWorktreePaths(params: { workspaceFolder: string; paths: string[] }): Promise<void> {
  const paths = normalizeGitMutationPaths(params.paths)
  await ensureGitCommandSucceeded(runGit(["add", "--", ...paths], params.workspaceFolder), "Failed to stage files")
}

export async function unstageWorktreePaths(params: { workspaceFolder: string; paths: string[] }): Promise<void> {
  const paths = normalizeGitMutationPaths(params.paths)
  const headResult = await runGit(["rev-parse", "--verify", "HEAD"], params.workspaceFolder)
  if (headResult.ok) {
    await ensureGitCommandSucceeded(
      runGit(["restore", "--staged", "--", ...paths], params.workspaceFolder),
      "Failed to unstage files",
    )
    return
  }

  await ensureGitCommandSucceeded(
    runGit(["rm", "--cached", "--quiet", "--", ...paths], params.workspaceFolder),
    "Failed to unstage files",
  )
}

export async function commitWorktreeChanges(params: { workspaceFolder: string; message: string }): Promise<{ commitSha?: string }> {
  const message = params.message.trim()
  if (!message) {
    throw new GitMutationError("Commit message is required", 400)
  }

  await ensureGitCommandSucceeded(runGit(["commit", "-m", message], params.workspaceFolder), "Failed to create commit")

  const shaResult = await runGit(["rev-parse", "HEAD"], params.workspaceFolder)
  if (!shaResult.ok) {
    return {}
  }

  const commitSha = shaResult.stdout.trim()
  return commitSha ? { commitSha } : {}
}
