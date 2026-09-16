import type { LocationGetInput, LocationRef } from "@opencode/client"

export type RequestLocation = NonNullable<LocationGetInput["location"]>

type RequestLocationWorktree = {
  directory?: string
  workspaceID?: string
}

export function createRequestLocation(directory?: string): RequestLocation {
  return directory ? { directory } : {}
}

export function toRequestLocation(location: LocationRef): RequestLocation {
  return { directory: location.directory }
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
