import { runGitProcess } from "./git-process"

/** Local refs only, including branches with no checked-out worktree. */
export async function getLocalGitBranches(directory: string): Promise<string[]> {
  const cleared = Object.fromEntries(Object.keys(process.env).filter(key => key.toUpperCase().startsWith("GIT_")).map(key => [key, undefined]))
  const output = await runGitProcess(directory, ["for-each-ref", "--count=201", "--sort=refname", "--format=%(refname)", "refs/heads/"],
    { timeout: 10_000, maxBuffer: 256 * 1024, priority: "foreground",
      env: { ...cleared, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } })
  const refs = output.split(/\r?\n/).filter(Boolean)
  if (refs.length > 200 || refs.some(ref => !ref.startsWith("refs/heads/") || ref.length > 1024)) throw new Error("Local branch listing exceeds its bound")
  return refs
}
