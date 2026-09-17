import { execFileSync } from "node:child_process"
import path from "node:path"
import type { OpenCodeClient } from "@opencode/client"
import { listNativeWorktrees } from "../native-worktrees"

// Only the native discovery transport is replaced. Filesystem identity, Git
// annotations, nested projection and the production catalogue remain real.
export function fixtureCatalogue(workspacePath: string) {
  const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim()
  const client = {
    location: { get: async ({ location }: { location: { directory: string } }) => {
      const directory = git(location.directory, "rev-parse", "--show-toplevel")
      const common = git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir")
      return { directory: location.directory, project: { id: "fixture", directory, canonical: path.dirname(common) } }
    } },
    worktree: {
      refresh: async () => {},
      list: async () => git(workspacePath, "worktree", "list", "--porcelain", "-z").split("\0")
        .filter(field => field.startsWith("worktree ")).map(field => ({ directory: field.slice(9) })),
    },
  } as unknown as OpenCodeClient
  return listNativeWorktrees({ client, workspacePath, location: { directory: workspacePath }, toHost: async directory => directory })
}
