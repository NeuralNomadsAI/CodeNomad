import type { LocationGetInput } from "@opencode-ai/client"

export type RequestLocation = NonNullable<LocationGetInput["location"]>

type RequestLocationWorktree = {
  directory?: string
}

export function createRequestLocation(directory?: string): RequestLocation {
  return directory ? { directory } : {}
}

export function buildV2RequestLocations(
  directory: string | undefined,
  worktrees: RequestLocationWorktree[],
): RequestLocation[] {
  const locations = [createRequestLocation(directory)]
  const seen = new Set(directory ? [directory] : [])

  for (const worktree of worktrees) {
    const worktreeDirectory = worktree.directory?.trim()
    if (!worktreeDirectory || seen.has(worktreeDirectory)) continue
    seen.add(worktreeDirectory)
    locations.push(createRequestLocation(worktreeDirectory))
  }

  return locations
}
