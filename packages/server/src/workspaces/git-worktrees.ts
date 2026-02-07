import path from "path"
import { spawn } from "child_process"
import type { WorktreeDescriptor } from "../api-types"
import { promises as fsp } from "fs"

export interface LogLike {
  debug?: (obj: any, msg?: string) => void
  warn?: (obj: any, msg?: string) => void
}

type GitResult = { ok: true; stdout: string } | { ok: false; error: Error; stdout?: string; stderr?: string }

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

export async function resolveRepoRoot(folder: string, logger?: LogLike): Promise<{ repoRoot: string; isGitRepo: boolean }> {
  const result = await runGit(["rev-parse", "--show-toplevel"], folder)
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
}): Promise<WorktreeDescriptor[]> {
  const { repoRoot, workspaceFolder, logger } = params
  const rootDescriptor: WorktreeDescriptor = { slug: "root", directory: repoRoot, kind: "root" }

  const result = await runGit(["worktree", "list", "--porcelain"], workspaceFolder)
  if (!result.ok) {
    logger?.debug?.({ repoRoot, err: result.error }, "Failed to list git worktrees; returning root only")
    return [rootDescriptor]
  }

  const records = parseWorktreePorcelain(result.stdout)

  const worktrees: WorktreeDescriptor[] = [rootDescriptor]
  const slugCounts = new Map<string, number>([["root", 1]])

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

  const uniquify = (slug: string): string => {
    const count = slugCounts.get(slug) ?? 0
    slugCounts.set(slug, count + 1)
    if (count === 0) {
      return slug
    }
    return `${slug}@${count + 1}`
  }

  for (const record of records) {
    const abs = record.worktree
    if (!abs || typeof abs !== "string") continue

    // Skip the root record (we always expose it as slug="root").
    if (path.resolve(abs) === path.resolve(repoRoot)) {
      continue
    }

    const slug = uniquify(normalizeSlug(record))
    // Never emit a worktree slug that collides with our reserved root slug.
    if (slug === "root") {
      worktrees.push({ slug: uniquify("root-worktree"), directory: abs, kind: "worktree", branch: record.branch })
      continue
    }

    worktrees.push({ slug, directory: abs, kind: "worktree", branch: record.branch })
  }

  return worktrees
}

export function isValidWorktreeSlug(slug: string): boolean {
  if (!slug) return false
  const trimmed = slug.trim()
  if (!trimmed) return false
  if (trimmed.length > 200) return false
  // Disallow control characters; allow branch-like slugs including '/'.
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return false
  return true
}

export async function createManagedWorktree(params: {
  repoRoot: string
  workspaceFolder: string
  slug: string
  logger?: LogLike
}): Promise<{ slug: string; directory: string; branch?: string }> {
  const { repoRoot, workspaceFolder, logger } = params
  const branch = params.slug.trim()

  if (!branch || branch === "root" || !isValidWorktreeSlug(branch)) {
    throw new Error("Invalid worktree slug")
  }

  const sanitizeDirName = (input: string): string => {
    const normalized = input
      .trim()
      .replace(/[\\/]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
    return normalized || "worktree"
  }

  const worktreesDir = path.join(repoRoot, ".codenomad", "worktrees")
  const targetDir = path.join(worktreesDir, sanitizeDirName(branch))
  await fsp.mkdir(worktreesDir, { recursive: true })

  try {
    const stat = await fsp.stat(targetDir)
    if (stat.isDirectory()) {
      throw new Error("Worktree directory already exists")
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT") {
      throw error
    }
  }

  logger?.debug?.({ slug: branch, branch, targetDir }, "Creating managed git worktree")

  // Prefer creating a new branch from HEAD.
  const first = await runGit(["worktree", "add", "-b", branch, targetDir, "HEAD"], workspaceFolder)
  if (first.ok) {
    return { slug: branch, directory: targetDir, branch }
  }

  const message = first.stderr?.toLowerCase() ?? first.error.message.toLowerCase()
  if (message.includes("already exists")) {
    // If the branch already exists, add worktree for that branch.
    const second = await runGit(["worktree", "add", targetDir, branch], workspaceFolder)
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
