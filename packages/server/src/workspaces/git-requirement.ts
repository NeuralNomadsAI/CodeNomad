import { runWorktreeGit } from "./git-process"

export class GitRequiredError extends Error {
  readonly code = "git_required"
  readonly statusCode = 503

  constructor(readonly cause?: unknown) {
    super("git_required: This Git/worktree operation requires Git in the CodeNomad backend's PATH. Conversations remain available in the explicitly opened folder. Ask your agent to help install Git, then restart CodeNomad after changing PATH.")
    this.name = "GitRequiredError"
  }
}

export class GitProbeUnavailableError extends Error {
  readonly code = "git_probe_unavailable"
  readonly statusCode = 503
  readonly retryable = true

  constructor(readonly cause?: unknown) {
    super("Git availability could not be checked. Retry the operation.")
    this.name = "GitProbeUnavailableError"
  }
}

/** Check the same host environment used by repository identity and mutation reads.
 * Do not cache success: operations must not inherit stale dependency status.
 * Use the backend cwd, not the requested folder (which may not exist yet).
 */
export async function requireHostGit(run = runWorktreeGit): Promise<string> {
  try {
    const version = await run(process.cwd(), ["--version"], 5_000)
    if (!/^git version \S+/.test(version)) throw new Error("Invalid Git version response")
    return version
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new GitRequiredError(error)
    throw new GitProbeUnavailableError(error)
  }
}

export async function readGitStatus(): Promise<{ available: boolean; platform: string; version?: string }> {
  try { return { available: true, platform: process.platform, version: await requireHostGit() } }
  catch (error) {
    if (error instanceof GitRequiredError) return { available: false, platform: process.platform }
    throw error
  }
}
