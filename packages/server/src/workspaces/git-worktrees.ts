import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, realpath, stat } from "node:fs/promises"

export interface LogLike {
  debug?: (obj: any, msg?: string) => void
  warn?: (obj: any, msg?: string) => void
}

const execute = promisify(execFile)
async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execute("git", ["-C", directory, ...args], { windowsHide: true, maxBuffer: 1024 * 1024 })
  return stdout.replace(/\r?\n$/, "")
}

export async function resolveRepoRoot(folder: string, logger?: LogLike): Promise<{ repoRoot: string; isGitRepo: boolean }> {
  try {
    return { repoRoot: await git(folder, ["rev-parse", "--show-toplevel"]), isGitRepo: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Git is not installed or not available in PATH")
    logger?.debug?.({ folder, err: error }, "Folder is not a Git repository; using workspace folder as root")
    return { repoRoot: folder, isGitRepo: false }
  }
}

export async function isGitAvailable(folder: string): Promise<boolean> {
  return git(folder, ["--version"]).then(() => true, error => error.code !== "ENOENT")
}

// A different physical common directory cannot belong to this local repository,
// even when independent clones share OpenCode's project ID. This is only a
// negative preflight; a match still requires the native worktree inventory.
export async function sharesGitCommonDirectory(left: string, right: string): Promise<boolean> {
  const common = async (directory: string) => realpath(await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
  try {
    const [a, b] = await Promise.all([common(left), common(right)])
    return a === b
  } catch { return false }
}

// Git annotations and branch policy, not another worktree registry. Native
// OpenCode owns discovery, creation and removal of the physical checkouts.
export async function readCheckout(directory: string) {
  const [paths, head, branch] = await Promise.all([
    git(directory, ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir", "--absolute-git-dir"]),
    git(directory, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined),
    git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => undefined),
  ])
  const [root, common, gitDirectory] = paths.split(/\r?\n/)
  return { root: await realpath(root), common: await realpath(common), gitDirectory: await realpath(gitDirectory), head, branch }
}

// One Git snapshot supplies HEAD/branch annotations for every local checkout.
// Native OpenCode remains the inventory authority; callers intersect its entries
// with these registrations and verify each checkout's physical common directory.
export async function readWorktreeAnnotations(directory: string) {
  const output = await git(directory, ["worktree", "list", "--porcelain", "-z"])
  return output.split("\0\0").filter(Boolean).map(record => {
    const fields = record.split("\0")
    const root = fields.find(field => field.startsWith("worktree "))?.slice(9)
    if (!root) throw new Error("Git returned a worktree without a directory")
    const head = fields.find(field => field.startsWith("HEAD "))?.slice(5)
    const branch = fields.find(field => field.startsWith("branch refs/heads/"))?.slice(18)
    return { root, head, branch }
  })
}

export async function readCheckoutIdentity(directory: string) {
  const entry = path.join(directory, ".git")
  const info = await stat(entry)
  let gitDirectory = entry
  if (!info.isDirectory()) {
    const pointer = (await readFile(entry, "utf8")).replace(/\r?\n$/, "")
    if (!pointer.startsWith("gitdir: ")) throw new Error("Invalid worktree Git directory")
    gitDirectory = path.resolve(directory, pointer.slice(8))
  }
  const common = await readFile(path.join(gitDirectory, "commondir"), "utf8").catch(error => {
    if (error.code === "ENOENT") return "."
    throw error
  })
  const resolvedGit = await realpath(gitDirectory)
  const resolvedCommon = await realpath(path.resolve(gitDirectory, common.replace(/\r?\n$/, "")))
  const backlink = resolvedGit === resolvedCommon ? undefined : (await readFile(path.join(resolvedGit, "gitdir"), "utf8")).replace(/\r?\n$/, "")
  return {
    gitDirectory: resolvedGit,
    common: resolvedCommon,
    root: backlink ? await realpath(path.dirname(path.resolve(resolvedGit, backlink))) : undefined,
  }
}

export function isValidWorktreeSlug(slug: string): boolean {
  return Boolean(slug.trim() && slug.length <= 200 && !/[\x00-\x1F\x7F]/.test(slug))
}

export async function prepareWorktreeBranch(directory: string, branch: string): Promise<{ existing: boolean; revision: string }> {
  await git(directory, ["check-ref-format", "--branch", branch])
  const revision = await git(directory, ["rev-parse", "--verify", `refs/heads/${branch}`]).catch(() => undefined)
  return { existing: Boolean(revision), revision: revision ?? await git(directory, ["rev-parse", "--verify", "HEAD"]) }
}

export async function attachWorktreeBranch(directory: string, branch: string, existing: boolean): Promise<void> {
  // Never -B/--force: preserve branch refs and Git's already-checked-out guard.
  await git(directory, ["switch", ...(existing ? [] : ["-c"]), branch])
}

export async function gitExcludePath(directory: string): Promise<string> {
  return path.resolve(directory, await git(directory, ["rev-parse", "--git-path", "info/exclude"]))
}
