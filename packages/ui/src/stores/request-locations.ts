export type V2Location = {
  directory?: string
  workspace?: string
}

export type V2RequestLocationWorktree = {
  slug?: string
}

export type V2RequestLocationSnapshot = {
  locations: V2Location[]
  complete: boolean
}

export function buildV2RequestLocations(
  directory: string | undefined,
  worktrees: V2RequestLocationWorktree[],
  workspaceBySlug: Map<string, string>,
): V2RequestLocationSnapshot {
  const rootLocation: V2Location = directory ? { directory } : {}
  const locations: V2Location[] = [rootLocation]
  const seen = new Set([JSON.stringify(rootLocation)])
  let complete = worktrees.length > 0

  for (const worktree of worktrees) {
    if (!worktree.slug || worktree.slug === "root") continue
    const workspace = workspaceBySlug.get(worktree.slug)
    if (!workspace) {
      complete = false
      continue
    }
    const location: V2Location = { ...rootLocation, workspace }
    const key = JSON.stringify(location)
    if (seen.has(key)) continue
    seen.add(key)
    locations.push(location)
  }

  return { locations, complete }
}
