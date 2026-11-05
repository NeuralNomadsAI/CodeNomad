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

/** A SideCar this host opened: its id only, never its address or a proxy token. */
export interface SideCarRecent {
  sidecarId: string
  lastAccessed: number
}

export function normalizeSideCarRecents(value: unknown): SideCarRecent[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: SideCarRecent[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    const sidecarId = text(record.sidecarId, 256)
    if (!sidecarId || seen.has(sidecarId)) continue
    seen.add(sidecarId)
    result.push({ sidecarId, lastAccessed: typeof record.lastAccessed === "number" && Number.isFinite(record.lastAccessed) ? record.lastAccessed : 0 })
    if (result.length >= MAX_REMOTE_PROJECT_RECENTS) break
  }
  return result.sort((left, right) => right.lastAccessed - left.lastAccessed)
}

export function withSideCarRecent(list: readonly SideCarRecent[], sidecarId: string, now = Date.now()): SideCarRecent[] {
  return [{ sidecarId, lastAccessed: now }, ...list.filter((item) => item.sidecarId !== sidecarId)].slice(0, MAX_REMOTE_PROJECT_RECENTS)
}

export function withoutSideCarRecent(list: readonly SideCarRecent[], sidecarId: string): SideCarRecent[] {
  return list.filter((item) => item.sidecarId !== sidecarId)
}

export interface LaunchableRecent {
  /** The folder; a SideCar's id for a SideCar. */
  path: string
  lastAccessed: number
  projectName?: string
  /** A project on a saved remote server; absent for this computer's folders. */
  remote?: { profileId: string; serverName: string }
  /** A configured SideCar, named by `projectName`. */
  sidecar?: { sidecarId: string }
}

/**
 * One list of recent tabs, newest first: local folders, remote projects of
 * servers still saved, and SideCars still configured.
 */
export function mixRecents(
  local: ReadonlyArray<{ path: string; lastAccessed: number; projectName?: string }>,
  remote: readonly RemoteProjectRecent[],
  servers: ReadonlyArray<{ id: string; name: string }>,
  sidecarRecents: readonly SideCarRecent[] = [],
  sidecars: ReadonlyArray<{ id: string; name: string }> = [],
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
  const sidecarNames = new Map(sidecars.map((sidecar) => [sidecar.id, sidecar.name]))
  const sidecarItems: LaunchableRecent[] = sidecarRecents.flatMap((entry) => {
    const name = sidecarNames.get(entry.sidecarId)
    return name ? [{ path: entry.sidecarId, lastAccessed: entry.lastAccessed, projectName: name, sidecar: { sidecarId: entry.sidecarId } }] : []
  })
  if (!remoteItems.length && !sidecarItems.length) return [...local]
  return [...local, ...remoteItems, ...sidecarItems].sort((left, right) => right.lastAccessed - left.lastAccessed)
}

/** Distinct keys for a local folder, the same path on a server and a SideCar. */
export const recentKey = (recent: Pick<LaunchableRecent, "path" | "remote" | "sidecar">) =>
  recent.sidecar ? `sidecar\0${recent.sidecar.sidecarId}`
    : recent.remote ? `${recent.remote.profileId}\0${recent.path}` : recent.path

/** Without `folder`, forgets every project of that server. */
export function withoutRemoteProjectRecent(
  list: readonly RemoteProjectRecent[],
  profileId: string,
  folder?: string,
): RemoteProjectRecent[] {
  return list.filter((item) => item.profileId !== profileId || (folder !== undefined && item.folder !== folder))
}
