import { stat } from "node:fs/promises"
import { isConflictError, isVcsInitNotSupportedError, type LocationRef, type OpenCodeClient } from "@opencode/client"
import { locationRequestOptions } from "../opencode/compatibility/location"
import { resolveRepoRoot } from "./git-worktrees"

export class GitInitError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message)
  }
}

export interface NativeGitInitContext {
  client: OpenCodeClient
  location: LocationRef
  workspacePath: string
  toHost: (directory: string) => Promise<string | null | undefined>
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([stat(left), stat(right)]).catch(() => [undefined, undefined])
  return Boolean(a && b && a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs)
}

/** Initialize Git through native `vcs.init` for exactly the explicitly opened folder.
 * Native initializes the location's project directory, which for a markerless
 * folder is the folder itself; any other target (e.g. a parent) is refused.
 * A single unretried request: callers must not replay an uncertain failure.
 */
export async function initializeNativeGit(context: NativeGitInitContext): Promise<void> {
  const { client, location, workspacePath, toHost } = context
  if ((await resolveRepoRoot(workspacePath)).isGitRepo) {
    throw new GitInitError("Folder already belongs to a Git repository", 409, "git_init_repository_exists")
  }
  const options = locationRequestOptions(location)
  const current = await client.location.get({ location: { directory: location.directory } }, options).catch(error => {
    throw new GitInitError(errorMessage(error, "Unable to resolve the OpenCode location"), 502, "git_init_failed")
  })
  const target = await toHost(current.project.directory)
  if (!target || !await sameDirectory(target, workspacePath)) {
    throw new GitInitError("OpenCode resolved a different project directory", 409, "git_init_directory_mismatch")
  }
  try {
    await client.vcs.init({ location: { directory: location.directory }, provider: "git" }, options)
  } catch (error) {
    if (isVcsInitNotSupportedError(error)) throw new GitInitError(error.message, 501, "git_init_unsupported")
    if (isConflictError(error)) throw new GitInitError("Folder already belongs to a repository", 409, "git_init_repository_exists")
    throw new GitInitError(errorMessage(error, "Git initialization failed"), 502, "git_init_failed")
  }
}

function errorMessage(error: unknown, fallback: string): string {
  const message = error && typeof error === "object" && "message" in error ? error.message : undefined
  return typeof message === "string" && message ? message : fallback
}
