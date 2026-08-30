import type { LocationGetInput, LocationRef } from "@opencode-ai/client"

export type RequestLocation = NonNullable<LocationGetInput["location"]>

type RequestLocationWorktree = {
  directory?: string
  workspaceID?: string
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
  const seen = new Set(directory ? [`${directory}\0`] : [])

  for (const worktree of worktrees) {
    const worktreeDirectory = worktree.directory?.trim()
    const key = `${worktreeDirectory}\0${worktree.workspaceID ?? ""}`
    if (!worktreeDirectory || seen.has(key)) continue
    seen.add(key)
    locations.push(worktree.workspaceID
      ? { directory: worktreeDirectory, workspace: worktree.workspaceID }
      : createRequestLocation(worktreeDirectory))
  }

  return locations
}
