import { realpath } from "node:fs/promises"
import { runWorktreeGit } from "./git-process"

const pending = new Map<string, Promise<string>>()

/** Share only in-flight negative-preflight reads. Git remains responsible for
 * discovery/configuration; completed identities never become authority caches. */
export function readGitCommonDirectory(directory: string): Promise<string> {
  const existing = pending.get(directory)
  if (existing) return existing
  const task = runWorktreeGit(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 10_000)
    .then(directory => realpath(directory)).finally(() => {
      if (pending.get(directory) === task) pending.delete(directory)
    })
  pending.set(directory, task)
  return task
}
