import path from "path"
import { spawn, spawnSync, type ChildProcess } from "child_process"
import { randomBytes } from "node:crypto"
import type { WorktreeDescriptor } from "../api-types"
import { promises as fsp } from "fs"
import { buildSpawnSpec } from "./spawn"
import {
  LAUNCH_CLEANUP_TOKEN_ENV,
  probeLaunchCleanupToken,
  probePosixProcesses,
  signalLaunchCleanupToken,
  signalOwnedPosixProcessGroup,
  signalPosixProcesses,
} from "./process-identity"

const DEFAULT_GIT_TIMEOUT_MS = 30_000
const GIT_GRACEFUL_STOP_MS = 250
const GIT_CLEANUP_TIMEOUT_MS = 2_000
const GIT_CLEANUP_COMMAND_TIMEOUT_MS = 500

export interface LogLike {
  debug?: (obj: any, msg?: string) => void
  warn?: (obj: any, msg?: string) => void
}

type GitResult = { ok: true; stdout: string } | { ok: false; error: Error; stdout?: string; stderr?: string }
type GitRunOptions = { signal?: AbortSignal; timeoutMs?: number }

function isGitUnavailableResult(result: GitResult): boolean {
  return !result.ok && (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

async function terminateGitProcessTree(child: ChildProcess, cleanupToken: string): Promise<void> {
  const pid = child.pid
  if (!pid) throw new Error("spawned git process did not expose a PID")

  const deadline = Date.now() + GIT_CLEANUP_TIMEOUT_MS
  const failures: string[] = []
  let closed = child.exitCode !== null || child.signalCode !== null
  const onClose = () => { closed = true }
  child.once("close", onClose)

  const remainingCommandTime = () => Math.max(1, Math.min(GIT_CLEANUP_COMMAND_TIMEOUT_MS, deadline - Date.now()))
  const waitUntil = async (condition: () => boolean, until: number): Promise<boolean> => {
    while (Date.now() < until) {
      if (condition()) return true
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    return condition()
  }

  try {
    if (process.platform === "win32") {
      let treeCleanupConfirmed = false
      const stopTree = (force: boolean) => {
        if (Date.now() >= deadline) return
        try {
          const result = spawnSync(
            "taskkill.exe",
            ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
            { encoding: "utf8", timeout: remainingCommandTime() },
          )
          if (result.status === 0) treeCleanupConfirmed = true
          else failures.push(String(result.stderr || result.stdout || result.error?.message || `exit code ${result.status}`).trim())
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }

      // Windows wrappers can exit before their descendants after a non-forced taskkill.
      stopTree(true)
      if (!await waitUntil(() => closed && treeCleanupConfirmed, deadline)) {
        throw new Error(`git Windows process-tree cleanup was not confirmed before the cleanup deadline${failures.length ? `: ${failures.join("; ")}` : ""}`)
      }
      return
    }

    const signalTree = (signal: NodeJS.Signals) => {
      if (Date.now() >= deadline) return
      const snapshot = probePosixProcesses(spawnSync, remainingCommandTime(), process.platform, { groupId: pid })
      const members = snapshot.ok
        ? [...snapshot.processes.values()].filter((identity) => identity.groupId === pid)
        : []
      const leader = members.find((identity) => identity.pid === pid) ?? members[0]
      const result = leader
        ? signalPosixProcesses(spawnSync, {
            leader,
            groupId: pid,
            members,
            signal,
            allowLeaderlessGroup: true,
            cleanupToken,
          }, remainingCommandTime(), process.platform)
        : signalOwnedPosixProcessGroup(spawnSync, pid, signal, remainingCommandTime())
      if (!result.ok) failures.push(`POSIX ${signal}: ${result.error}`)
      if (process.platform === "linux") {
        const tokenResult = signalLaunchCleanupToken(spawnSync, cleanupToken, signal, remainingCommandTime())
        if (!tokenResult.ok) failures.push(`launch-token ${signal}: ${tokenResult.error}`)
      }
    }
    const treeGone = () => {
      const snapshot = probePosixProcesses(spawnSync, remainingCommandTime(), process.platform, { groupId: pid })
      if (!snapshot.ok || [...snapshot.processes.values()].some((identity) => identity.groupId === pid)) return false
      if (process.platform !== "linux") return true
      const tokenSnapshot = probeLaunchCleanupToken(spawnSync, cleanupToken, remainingCommandTime())
      return tokenSnapshot.ok && tokenSnapshot.processes.size === 0
    }

    signalTree("SIGTERM")
    if (!await waitUntil(() => closed && treeGone(), Math.min(deadline, Date.now() + GIT_GRACEFUL_STOP_MS))) {
      signalTree("SIGKILL")
    }
    if (!await waitUntil(() => closed && treeGone(), deadline)) {
      throw new Error(`git POSIX process-tree cleanup was not confirmed before the cleanup deadline${failures.length ? `: ${failures.join("; ")}` : ""}`)
    }
  } finally {
    child.removeListener("close", onClose)
  }
}

function runGit(args: string[], cwd: string, options: GitRunOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted()
    const cleanupToken = randomBytes(32).toString("hex")
    const spec = buildSpawnSpec("git", args, {
      cwd,
      env: { ...process.env, [LAUNCH_CLEANUP_TOKEN_ENV]: cleanupToken },
    })
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsVerbatimArguments: Boolean(spec.options.windowsVerbatimArguments),
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    let terminating = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const requestedTimeout = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(1, requestedTimeout) : DEFAULT_GIT_TIMEOUT_MS

    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abort)
    }
    const finish = (result: GitResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const terminate = (error: unknown) => {
      if (settled || terminating) return
      terminating = true
      cleanup()
      void terminateGitProcessTree(child, cleanupToken).then(
        () => {
          settled = true
          reject(error)
        },
        (cleanupError) => {
          settled = true
          const reason = error instanceof Error ? error : new Error(String(error))
          const combined = new Error(`${reason.message}; ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
          ;(combined as Error & { cause?: unknown }).cause = new AggregateError([reason, cleanupError])
          reject(combined)
        },
      )
    }
    const abort = () => terminate(options.signal?.reason ?? new Error("Git operation aborted"))
    timeout = setTimeout(
      () => terminate(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.once("error", (error) => {
      if (terminating) return
      finish({ ok: false, error, stdout, stderr })
    })
    child.once("close", (code) => {
      if (terminating) return
      if (code === 0) {
        finish({ ok: true, stdout })
      } else {
        const error = new Error(stderr.trim() || `git ${args.join(" ")} failed with code ${code}`)
        finish({ ok: false, error, stdout, stderr })
      }
    })
  })
}

export async function resolveRepoRoot(
  folder: string,
  logger?: LogLike,
  options: GitRunOptions = {},
): Promise<{ repoRoot: string; isGitRepo: boolean }> {
  const result = await runGit(["rev-parse", "--show-toplevel"], folder, options)
  if (isGitUnavailableResult(result)) {
    throw new Error("Git is not installed or not available in PATH")
  }
  if (!result.ok) {
    logger?.debug?.({ folder, err: result.error }, "Folder is not a Git repository; using workspace folder as root")
    return { repoRoot: folder, isGitRepo: false }
  }
  const repoRoot = result.stdout.trim()
  if (!repoRoot) {
    return { repoRoot: folder, isGitRepo: false }
  }
  return { repoRoot, isGitRepo: true }
}

export async function isGitAvailable(folder: string): Promise<boolean> {
  const result = await runGit(["--version"], folder)
  return result.ok || !isGitUnavailableResult(result)
}

function parseWorktreePorcelain(output: string): Array<{ worktree: string; branch?: string; head?: string; detached?: boolean }> {
  const records: Array<{ worktree: string; branch?: string; head?: string; detached?: boolean }> = []
  const lines = output.split(/\r?\n/)
  let current: { worktree?: string; branch?: string; head?: string; detached?: boolean } = {}

  const flush = () => {
    if (current.worktree) {
      records.push({ worktree: current.worktree, branch: current.branch })
    }
    current = {}
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      flush()
      continue
    }
    const [key, ...rest] = trimmed.split(" ")
    const value = rest.join(" ").trim()
    if (key === "worktree") {
      current.worktree = value
    } else if (key === "branch") {
      // branch is like refs/heads/foo
      current.branch = value.replace(/^refs\/heads\//, "")
    } else if (key === "HEAD") {
      current.head = value
    } else if (key === "detached") {
      current.detached = true
    }
  }
  flush()
  return records
}

export async function listWorktrees(params: {
  repoRoot: string
  workspaceFolder: string
  logger?: LogLike
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<WorktreeDescriptor[]> {
  const { repoRoot, workspaceFolder, logger } = params

  const result = await runGit(["worktree", "list", "--porcelain"], workspaceFolder, params)
  if (!result.ok) {
    const rootDescriptor: WorktreeDescriptor = { slug: "root", directory: workspaceFolder, kind: "root" }
    logger?.debug?.({ repoRoot, err: result.error }, "Failed to list git worktrees; returning root only")
    return [rootDescriptor]
  }

  const records = parseWorktreePorcelain(result.stdout)
  const rootRecord = records.find((record) => path.resolve(record.worktree) === path.resolve(repoRoot))
  const rootDescriptor: WorktreeDescriptor = {
    slug: "root",
    directory: workspaceFolder,
    kind: "root",
    branch: rootRecord?.branch,
  }

  const worktrees: WorktreeDescriptor[] = [rootDescriptor]
  const seen = new Set<string>(["root"])

  const normalizeSlug = (record: { branch?: string; head?: string; detached?: boolean; worktree: string }): string => {
    const branch = (record.branch ?? "").trim()
    if (branch) {
      return branch
    }
    const head = (record.head ?? "").trim()
    if (head && /^[0-9a-f]{7,40}$/i.test(head)) {
      return `detached-${head.slice(0, 7)}`
    }
    // Fallback: stable-ish identifier derived from directory basename.
    const base = path.basename(record.worktree || "")
    return base ? `worktree-${base}` : "worktree"
  }


  for (const record of records) {
    const abs = record.worktree
    if (!abs || typeof abs !== "string") continue

    // Skip the root record (we always expose it as slug="root").
    if (path.resolve(abs) === path.resolve(repoRoot)) {
      continue
    }

    const slug = normalizeSlug(record)
    if (!slug || slug === "root") {
      continue
    }
    if (seen.has(slug)) {
      continue
    }
    seen.add(slug)
    worktrees.push({ slug, directory: abs, kind: "worktree", branch: record.branch })
  }

  return worktrees
}

export function isValidWorktreeSlug(slug: string): boolean {
  if (!slug || slug.length > 200) return false
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(slug)
}

export function getManagedWorktreePath(repoRoot: string, slug: string): string {
  const directoryName = slug
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "") || "worktree"
  return path.join(repoRoot, ".codenomad", "worktrees", directoryName)
}

export async function isManagedWorktree(params: {
  repoRoot: string
  worktree: WorktreeDescriptor
}): Promise<boolean> {
  if (params.worktree.kind !== "worktree") return false
  try {
    const repoRoot = await fsp.realpath(params.repoRoot)
    const managedRoot = await fsp.realpath(path.join(params.repoRoot, ".codenomad", "worktrees"))
    const directory = await fsp.realpath(params.worktree.directory)
    const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value
    if (normalize(managedRoot) !== normalize(path.join(repoRoot, ".codenomad", "worktrees"))) return false
    if (normalize(path.dirname(directory)) !== normalize(managedRoot)) return false

    const metadata = await fsp.readFile(path.join(directory, ".git"), "utf8")
    const gitDir = metadata.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    if (!gitDir) return false
    return (await fsp.stat(path.resolve(directory, gitDir))).isDirectory()
  } catch {
    return false
  }
}

export async function createManagedWorktree(params: {
  repoRoot: string
  workspaceFolder: string
  slug: string
  logger?: LogLike
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<{ slug: string; directory: string; branch?: string }> {
  const { repoRoot, workspaceFolder, logger } = params
  const branch = params.slug.trim()

  if (!branch || branch === "root" || !isValidWorktreeSlug(branch)) {
    throw new Error("Invalid worktree slug")
  }

  const canonicalRepoRoot = await fsp.realpath(repoRoot)
  const codenomadDir = path.join(repoRoot, ".codenomad")
  const worktreesDir = path.join(codenomadDir, "worktrees")
  const pathsEqual = (left: string, right: string) => process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right

  await fsp.mkdir(codenomadDir, { recursive: true })
  const canonicalCodenomadDir = await fsp.realpath(codenomadDir)
  if (!pathsEqual(canonicalCodenomadDir, path.join(canonicalRepoRoot, ".codenomad"))) {
    throw new Error("Managed worktree directory escapes repository")
  }
  await fsp.mkdir(worktreesDir, { recursive: true })
  const canonicalWorktreesDir = await fsp.realpath(worktreesDir)
  if (!pathsEqual(canonicalWorktreesDir, path.join(canonicalCodenomadDir, "worktrees"))) {
    throw new Error("Managed worktree directory escapes repository")
  }
  const targetDir = getManagedWorktreePath(canonicalRepoRoot, branch)
  const relativeTarget = path.relative(canonicalWorktreesDir, targetDir)
  if (!relativeTarget || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
    throw new Error("Managed worktree target escapes managed directory")
  }

  try {
    await fsp.lstat(targetDir)
    throw new Error("Worktree directory already exists")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT") {
      throw error
    }
  }

  logger?.debug?.({ slug: branch, branch, targetDir }, "Creating managed git worktree")

  // Prefer creating a new branch from HEAD.
  const first = await runGit(["worktree", "add", "-b", branch, targetDir, "HEAD"], workspaceFolder, params)
  if (first.ok) {
    return { slug: branch, directory: targetDir, branch }
  }

  const message = first.stderr?.toLowerCase() ?? first.error.message.toLowerCase()
  if (message.includes("already exists")) {
    // If the branch already exists, add worktree for that branch.
    const second = await runGit(["worktree", "add", targetDir, branch], workspaceFolder, params)
    if (second.ok) {
      return { slug: branch, directory: targetDir, branch }
    }
    throw second.error
  }

  throw first.error
}

export async function removeWorktree(params: {
  workspaceFolder: string
  directory: string
  force?: boolean
  logger?: LogLike
}): Promise<void> {
  const { workspaceFolder, logger } = params
  const directory = (params.directory ?? "").trim()
  if (!directory) {
    throw new Error("Invalid worktree directory")
  }
  logger?.debug?.({ directory, force: Boolean(params.force) }, "Removing git worktree")

  const args = ["worktree", "remove"]
  if (params.force) {
    args.push("--force")
  }
  args.push(directory)

  const result = await runGit(args, workspaceFolder)
  if (!result.ok) {
    throw result.error
  }

  // Best-effort cleanup of stale metadata.
  await runGit(["worktree", "prune"], workspaceFolder).catch(() => undefined)
}
