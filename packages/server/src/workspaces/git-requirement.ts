import { runWorktreeGit } from "./git-process"

export class GitRequiredError extends Error {
  readonly code = "git_required"
  readonly statusCode = 503

  constructor(readonly cause?: unknown) {
    super("git_required: This Git/worktree operation requires Git in the CodeNomad backend's PATH. Conversations remain available in the explicitly opened folder. Ask your agent to help install Git, then restart CodeNomad after changing PATH.")
    this.name = "GitRequiredError"
  }
}

/** Check the same host environment used by repository identity and mutation reads.
 * Do not cache success: operations must not inherit stale dependency status.
 * Use the backend cwd, not the requested folder (which may not exist yet).
 */
export async function requireHostGit(): Promise<string> {
  try {
    const version = await runWorktreeGit(process.cwd(), ["--version"], 5_000)
    if (!/^git version \S+/.test(version)) throw new Error("Invalid Git version response")
    return version
  } catch (error) {
    throw new GitRequiredError(error)
  }
}

export async function readGitStatus(): Promise<{ available: boolean; platform: string; version?: string }> {
  try { return { available: true, platform: process.platform, version: await requireHostGit() } }
  catch { return { available: false, platform: process.platform } }
}
