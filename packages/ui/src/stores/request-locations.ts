import type { LocationGetInput } from "@opencode/client"

// Internal request authority; serialize public fields separately from context.
export type RequestLocation = NonNullable<LocationGetInput["location"]> & { workspaceID?: string }

type RequestLocationWorktree = {
  directory?: string
  workspaceID?: string
}

export function createRequestLocation(directory?: string): RequestLocation {
  return directory ? { directory } : {}
}

export function toRequestLocation(location: RequestLocation): NonNullable<LocationGetInput["location"]> {
  return location.directory ? { directory: location.directory } : {}
}

export function locationWorkspaceID(location: object): string | undefined {
  if (!("workspaceID" in location) || location.workspaceID === undefined) return undefined
  if (typeof location.workspaceID !== "string" || !location.workspaceID.trim()) throw new Error("Invalid native location identity")
  return location.workspaceID
}

export function locationAuthorityKey(location: RequestLocation): string {
  return JSON.stringify([location.directory, locationWorkspaceID(location)])
}

export function requestLocationOptions(location: RequestLocation | undefined, options?: { includeDirectory?: boolean }): { headers: Record<string, string> } | undefined {
  if (!location) return undefined
  const workspaceID = locationWorkspaceID(location)
  if (workspaceID === undefined && !options?.includeDirectory) return undefined
  if (!location.directory?.trim()) throw new Error("Missing native location directory")
  return { headers: { "x-codenomad-location": encodeURIComponent(JSON.stringify({ directory: location.directory, workspaceID })) } }
}

export function buildV2RequestLocations(
  directory: string | undefined,
  worktrees: RequestLocationWorktree[],
): RequestLocation[] {
  const locations = [createRequestLocation(directory)]
  const seen = new Set(locations.map(locationAuthorityKey))

  for (const worktree of worktrees) {
    const worktreeDirectory = worktree.directory?.trim()
    if (!worktreeDirectory) continue
    const location = { directory: worktreeDirectory, ...(worktree.workspaceID === undefined ? {} : { workspaceID: worktree.workspaceID }) }
    const key = locationAuthorityKey(location)
    if (seen.has(key)) continue
    seen.add(key)
    locations.push(location)
  }

  return locations
}
