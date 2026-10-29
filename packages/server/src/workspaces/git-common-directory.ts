import { realpath } from "node:fs/promises"
import { runWorktreeGit } from "./git-process"
import { readCheckoutCommonDirectory } from "../opencode/session-pruning/checkout-identity"
export { readCheckoutIdentity, gitLocationOverridden } from "../opencode/session-pruning/checkout-identity"

const pending = new Map<string, Promise<string>>()

// Share only in-flight reads. Git handles configured or ambiguous layouts for
// workspace discovery; the plugin imports the filesystem-only reader directly.
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
