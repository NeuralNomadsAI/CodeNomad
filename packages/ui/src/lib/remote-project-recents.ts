/**
 * Projects opened in remote CodeNomad tabs, kept by this host beside its own
 * recent folders: a saved server, a folder on it and its name, no secret.
 */
export interface RemoteProjectRecent {
  profileId: string
  folder: string
  projectName?: string
  lastAccessed: number
}

export const MAX_REMOTE_PROJECT_RECENTS = 20
const MAX_TEXT = 4096

const text = (value: unknown, max = MAX_TEXT): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined

export function normalizeRemoteProjectRecents(value: unknown): RemoteProjectRecent[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: RemoteProjectRecent[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    const profileId = text(record.profileId, 256)
    const folder = text(record.folder)
    if (!profileId || !folder) continue
    const key = `${profileId}\0${folder}`
    if (seen.has(key)) continue
    seen.add(key)
    const projectName = text(record.projectName, 256)
    result.push({
      profileId,
      folder,
      ...(projectName ? { projectName } : {}),
      lastAccessed: typeof record.lastAccessed === "number" && Number.isFinite(record.lastAccessed) ? record.lastAccessed : 0,
    })
    if (result.length >= MAX_REMOTE_PROJECT_RECENTS) break
  }
  return result.sort((left, right) => right.lastAccessed - left.lastAccessed)
}

export function withRemoteProjectRecent(
  list: readonly RemoteProjectRecent[],
  entry: Omit<RemoteProjectRecent, "lastAccessed">,
  now = Date.now(),
): RemoteProjectRecent[] {
  const rest = list.filter((item) => item.profileId !== entry.profileId || item.folder !== entry.folder)
  const previous = list.find((item) => item.profileId === entry.profileId && item.folder === entry.folder)
  const projectName = entry.projectName ?? previous?.projectName
  return [{ profileId: entry.profileId, folder: entry.folder, ...(projectName ? { projectName } : {}), lastAccessed: now }, ...rest]
    .slice(0, MAX_REMOTE_PROJECT_RECENTS)
}

export interface LaunchableRecent {
  path: string
  lastAccessed: number
  projectName?: string
  /** A project on a saved remote server; absent for this computer's folders. */
  remote?: { profileId: string; serverName: string }
}

/** One recent list, newest first: local folders, then remote projects of servers still saved. */
export function mixRecents(
  local: ReadonlyArray<{ path: string; lastAccessed: number; projectName?: string }>,
  remote: readonly RemoteProjectRecent[],
  servers: ReadonlyArray<{ id: string; name: string }>,
): LaunchableRecent[] {
  const names = new Map(servers.map((server) => [server.id, server.name]))
  const remoteItems: LaunchableRecent[] = remote.flatMap((entry) => {
    const serverName = names.get(entry.profileId)
    if (!serverName) return []
    return [{
      path: entry.folder,
      lastAccessed: entry.lastAccessed,
      ...(entry.projectName ? { projectName: entry.projectName } : {}),
      remote: { profileId: entry.profileId, serverName },
    }]
  })
  if (!remoteItems.length) return [...local]
  return [...local, ...remoteItems].sort((left, right) => right.lastAccessed - left.lastAccessed)
}

/** Distinct keys for a local folder and the same path on a server. */
export const recentKey = (recent: Pick<LaunchableRecent, "path" | "remote">) =>
  recent.remote ? `${recent.remote.profileId}\0${recent.path}` : recent.path

/** Without `folder`, forgets every project of that server. */
export function withoutRemoteProjectRecent(
  list: readonly RemoteProjectRecent[],
  profileId: string,
  folder?: string,
): RemoteProjectRecent[] {
  return list.filter((item) => item.profileId !== profileId || (folder !== undefined && item.folder !== folder))
}
