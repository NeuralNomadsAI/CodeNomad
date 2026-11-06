import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { parseRepositoryRemoteUrl } from "../forge/remote"
import { runWorktreeGit } from "../workspaces/git-process"
import { parseWslUncPath } from "../workspaces/spawn"
import { MemoryError } from "./model"
import { memoryGitEnvironment } from "./git-environment"

export interface MemoryProjectIdentity {
  /** SHA-256; safe as the projects/<id> directory name. */
  id: string
  source: "remote" | "local"
}

/** An already-authorized session directory in its execution host's namespace. */
export interface MemoryProjectTarget { directory: string; distro?: string }
type ExecuteWsl = (distro: string, executable: "git" | "realpath", args: string[]) => Promise<string>
const executeFile = promisify(execFile)
const executeWsl: ExecuteWsl = async (distro, executable, args) => {
  const clean = memoryGitEnvironment()
  const { stdout } = await executeFile("wsl.exe", ["--distribution", distro, "--exec", "env",
    ...Object.keys(clean).flatMap(key => ["-u", key]), "LC_ALL=C", "LANGUAGE=C", executable, ...args], {
    env: { ...process.env, ...clean }, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, encoding: "utf8",
  })
  return stdout.replace(/\r?\n$/, "")
}

export function normalizeMemoryRemote(url: string): string | undefined {
  const remote = parseRepositoryRemoteUrl(url)
  return remote && `${remote.host}/${remote.path}`
}

function identity(source: "remote" | "local", value: string): MemoryProjectIdentity {
  return { id: createHash("sha256").update(`${source}:${value}`).digest("hex"), source }
}

function notRepository(error: unknown): boolean {
  const { code, stderr } = (error ?? {}) as { code?: unknown; stderr?: unknown }
  return code === 128 && typeof stderr === "string"
    && /^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point)/m.test(stderr)
}

/** No remote policy is inherited from the forge: origin wins, otherwise the first sorted name.
 * Only an explicit non-repository answer falls back to the real session folder.
 * WSL uses Linux Git/realpath; UNC aliases share the same distro/path identity.
 */
export async function resolveMemoryProjectIdentity(target: MemoryProjectTarget, runWsl: ExecuteWsl = executeWsl): Promise<MemoryProjectIdentity> {
  const unc = parseWslUncPath(target.directory)
  if (unc && target.distro && unc.distro.toLowerCase() !== target.distro.toLowerCase()) {
    throw new MemoryError("invalid", "Memory project host mismatch")
  }
  const distro = target.distro ?? unc?.distro
  const directory = unc?.linuxPath ?? target.directory
  if (!directory || /[\x00-\x1f\x7f]/.test(directory) || !(distro ? path.posix.isAbsolute(directory) : path.isAbsolute(directory))) {
    throw new MemoryError("invalid", "Invalid memory project directory")
  }
  const paths = distro ? path.posix : path
  const git = async (args: string[]) => {
    try {
      return await (distro ? runWsl(distro, "git", ["-C", directory, ...args])
        : runWorktreeGit(directory, args, 10_000, { ...memoryGitEnvironment(), LC_ALL: "C", LANGUAGE: "C" }))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code as string | number | undefined
      if (code === "ENOENT" || (distro && code === 127)) throw new MemoryError("git_unavailable", "Memory project Git is unavailable")
      throw error
    }
  }
  const physical = (value: string) => distro ? runWsl(distro, "realpath", ["-e", value]) : realpath(value)
  const local = async (value: string) => {
    const resolved = await physical(value)
    if (!paths.isAbsolute(resolved) || /[\x00-\x1f\x7f]/.test(resolved)) throw new MemoryError("unreadable", "Invalid memory project path")
    return identity("local", distro ? `wsl:${distro.toLowerCase()}:${resolved}` : process.platform === "win32" ? resolved.toLowerCase() : resolved)
  }
  try {
    let common: string
    try {
      common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])
    } catch (error) {
      if (notRepository(error)) return await local(directory)
      throw error
    }
    if (!paths.isAbsolute(common) || /[\x00-\x1f\x7f]/.test(common)) throw new MemoryError("unreadable", "Invalid memory repository path")
    const names = (await git(["remote"])).split(/\r?\n/).filter(Boolean).sort()
    const name = names.includes("origin") ? "origin" : names[0]
    if (name) {
      const normalized = normalizeMemoryRemote(await git(["remote", "get-url", "--", name]))
      if (normalized) return identity("remote", normalized)
    }
    // Resolve the shared repository rather than whichever linked checkout is active.
    const root = paths.basename(common) === ".git" ? paths.dirname(common) : common
    return await local(root)
  } catch (error) {
    if (error instanceof MemoryError) throw error
    throw new MemoryError("unreadable", "Cannot resolve memory project")
  }
}
