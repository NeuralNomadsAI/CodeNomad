import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { runWorktreeGit } from "./git-process"

const pending = new Map<string, Promise<string>>()
const LOCATION_ENVIRONMENT = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE"]
const DISCOVERY_ENVIRONMENT = ["GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_OBJECT_DIRECTORY"]

export function gitLocationOverridden(): boolean {
  return LOCATION_ENVIRONMENT.some(key => process.env[key] !== undefined)
}

// Administrative layout of a checkout root, read from the filesystem only.
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

// Git may recognise the level itself as a Git directory, directly or through
// `commondir`. Any such entry, even committed content or a dangling symlink
// (Git reads HEAD links without following them), is left to Git.
const mayBeGitDirectory = (directory: string) => Promise.all(["HEAD", "commondir"].map(entry => lstat(path.join(directory, entry))
  .then(() => true, error => (error as NodeJS.ErrnoException).code !== "ENOENT"))).then(found => found.some(Boolean))

// Git discovery: the nearest ancestor holding `.git`, without crossing devices.
async function findCheckoutRoot(directory: string): Promise<string> {
  let current = await realpath(directory)
  const device = (await stat(current)).dev
  for (;;) {
    if (path.basename(current).toLowerCase() === ".git") throw new Error("Directory is inside a Git directory")
    try {
      await stat(path.join(current, ".git"))
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    // Git also discovers bare/separate Git directories at each level; a nested
    // one is an independent repository, never part of the enclosing checkout.
    if (await mayBeGitDirectory(current)) throw new Error("Directory may be inside a bare or separate Git directory")
    const parent = path.dirname(current)
    if (parent === current) throw new Error("Directory is not inside a Git checkout")
    if ((await stat(parent)).dev !== device) throw new Error("Git discovery stops at filesystem boundaries")
    current = parent
  }
}

async function readCheckoutCommonDirectory(directory: string): Promise<string> {
  if (gitLocationOverridden() || DISCOVERY_ENVIRONMENT.some(key => process.env[key] !== undefined)) {
    throw new Error("Git discovery is configured by the environment")
  }
  const { gitDirectory, common } = await readCheckoutIdentity(await findCheckoutRoot(directory))
  // Mirror Git's repository check before trusting the layout; Git skips an
  // invalid `.git` and keeps walking, which the Git fallback reproduces.
  await Promise.all([stat(path.join(common, "objects")), stat(path.join(common, "refs"))])
  if (!await hasValidHead(gitDirectory)) throw new Error("Git would reject this HEAD")
  return common
}

// Git's HEAD validation: a link into refs/, a symbolic ref or an object ID.
async function hasValidHead(gitDirectory: string): Promise<boolean> {
  const head = path.join(gitDirectory, "HEAD")
  const info = await lstat(head)
  // Backslash targets are platform-dependent for Git (accepted only on Windows).
  if (info.isSymbolicLink()) {
    const target = await readlink(head)
    return !target.includes("\\") && target.startsWith("refs/")
  }
  if (!info.isFile()) return false
  const content = (await readFile(head, "utf8")).replace(/\r?\n$/, "")
  return /^ref:\s*refs\//.test(content) || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(content)
}

/** Every call reads current state; only in-flight reads are shared, and completed
 * identities never become authority caches. The common directory comes from the
 * enclosing checkout's administrative files without a process: on Windows each
 * Git spawn costs up to a second, and ownership fans across hundreds of worktrees
 * saturated the shared two-process Git worker. Environment overrides, paths
 * inside `.git` and unreadable or invalid layouts defer to Git itself. */
export function readGitCommonDirectory(directory: string): Promise<string> {
  const existing = pending.get(directory)
  if (existing) return existing
  const task = readCheckoutCommonDirectory(directory)
    .catch(() => runWorktreeGit(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 10_000).then(directory => realpath(directory)))
    .finally(() => {
      if (pending.get(directory) === task) pending.delete(directory)
    })
  pending.set(directory, task)
  return task
}
