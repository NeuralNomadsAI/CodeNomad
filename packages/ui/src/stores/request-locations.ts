import type { LocationGetInput, LocationRef } from "@opencode-ai/client"

export type RequestLocation = NonNullable<LocationGetInput["location"]>

type RequestLocationWorktree = {
  directory?: string
}

export function createRequestLocation(directory?: string): RequestLocation {
  return directory ? { directory } : {}
}

export function toRequestLocation(location: LocationRef): RequestLocation {
  return {
    directory: location.directory,
    ...(location.workspaceID ? { workspace: location.workspaceID } : {}),
  }
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
