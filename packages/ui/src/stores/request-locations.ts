export type V2Location = {
  directory?: string
  workspace?: string
}

export type V2RequestLocationWorktree = {
  slug?: string
}

export function buildV2RequestLocations(
  directory: string | undefined,
  worktrees: V2RequestLocationWorktree[],
  workspaceBySlug: Map<string, string>,
): V2Location[] {
  const rootLocation: V2Location = directory ? { directory } : {}
  const locations: V2Location[] = [rootLocation]
  const seen = new Set([JSON.stringify(rootLocation)])

  for (const worktree of worktrees) {
    if (!worktree.slug || worktree.slug === "root") continue
    const workspace = workspaceBySlug.get(worktree.slug)
    if (!workspace) continue
    const location: V2Location = { ...rootLocation, workspace }
    const key = JSON.stringify(location)
    if (seen.has(key)) continue
    seen.add(key)
    locations.push(location)
  }

  return locations
}
