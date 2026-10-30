import { execFile } from "node:child_process"
import { mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { runWorktreeGit } from "./git-process"
import { appendCodenomadGitExclude, readGitExclude } from "./worktree-map"
import type { GitExclusion } from "../server/routes/images-conversation-contract"
export type { GitExclusion }

export const DESIGN_EXCLUDE_ENTRY = ".codenomad/design/"

/** A Location as its execution host sees it: a host directory, or a Linux directory in the owned WSL distro. */
export interface ExcludeTarget {
  directory: string
  distro?: string
  /** Translates an execution-host path for this process's filesystem access (identity off WSL). */
  toHost(servicePath: string): Promise<string | undefined>
}

/** Runs `git -C <directory> <args>` on the execution host; rejects with Git's exit `code` and `stderr`. */
export type ExcludeGit = (target: ExcludeTarget, args: string[]) => Promise<string>

// Git's own messages decide "not a repository"; the C locale keeps them untranslated.
const C_LOCALE = { LC_ALL: "C", LANGUAGE: "C" }
const GIT_TIMEOUT_MS = 10_000

const runExcludeGit: ExcludeGit = (target, args) => target.distro
  ? new Promise((resolve, reject) => {
    execFile("wsl.exe", ["--distribution", target.distro!, "--exec", "env", "LC_ALL=C", "LANGUAGE=C", "git", "-C", target.directory, ...args], {
      encoding: "utf8", windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => error
      ? reject(Object.assign(new Error("WSL Git failed"), { code: error.code, stderr }))
      : resolve(stdout.replace(/\r?\n$/, "")))
  })
  : runWorktreeGit(target.directory, args, GIT_TIMEOUT_MS, C_LOCALE)

// Discovery that found no repository at all; a `.git` pointer Git cannot follow
// ("not a git repository: <path>", "invalid gitfile format") is a failure.
function notRepository(error: unknown): boolean {
  const { code, stderr } = error as { code?: unknown; stderr?: unknown }
  return code === 128 && typeof stderr === "string"
    && /^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point)/m.test(stderr)
}

async function isDirectory(directory: string | undefined): Promise<boolean> {
  return Boolean(directory) && (await stat(directory!).catch(() => undefined))?.isDirectory() === true
}

// Concurrent opens of the same repository append once.
const writes = new Map<string, Promise<unknown>>()
function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const result = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(run)
  const settled = result.catch(() => undefined)
  writes.set(key, settled)
  void settled.then(() => { if (writes.get(key) === settled) writes.delete(key) })
  return result
}

/**
 * Excludes `.codenomad/design/` locally through the file Git itself names
 * (`rev-parse --git-path info/exclude`), resolved by the execution host's Git
 * and appended without touching existing lines or `.gitignore`. Only Git's
 * explicit "not a repository" answer means no repository; every other failure
 * writes nothing and is `unavailable`.
 */
export async function excludeDesignFolder(target: ExcludeTarget, git: ExcludeGit = runExcludeGit): Promise<GitExclusion> {
  let output: string
  try {
    output = await git(target, ["rev-parse", "--git-path", "info/exclude"])
  } catch (error) {
    return notRepository(error) ? "not-repository" : "unavailable"
  }
  try {
    if (!output || /[\x00-\x1f\x7f]/.test(output)) return "unavailable"
    const resolved = target.distro ? path.posix.resolve(target.directory, output) : path.resolve(target.directory, output)
    const [excludePath, location] = await Promise.all([target.toHost(resolved), target.toHost(target.directory)])
    if (!excludePath || !await isDirectory(location)) return "unavailable"
    return await serialized(path.resolve(excludePath).toLowerCase(), async () => {
      // The Git directory must still exist: never recreate a deleted checkout's metadata.
      await mkdir(path.dirname(excludePath)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
      await appendCodenomadGitExclude(excludePath, await readGitExclude(excludePath), [DESIGN_EXCLUDE_ENTRY])
      return "excluded" as const
    })
  } catch {
    return "unavailable"
  }
}
