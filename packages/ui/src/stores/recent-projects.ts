import { createMemo, createSignal } from "solid-js"
import type { RemoteServerBrowseResponse, RemoteServerProfile } from "../../../server/src/api-types"
import { LOCAL_BACKEND_ID } from "../lib/backend-identity"
import { qualifiedServerDisplayName } from "../lib/codenomad-link"
import { getLogger } from "../lib/logger"
import { sameServerSelection, type ServerSelectionIntent } from "../lib/native/server-selection-intent"
import {
  normalizeRemoteProjectRecent, RECENT_PROJECT_LIMIT, recentProjectName, remoteProjectRecentKey,
  type RemoteProjectRecentData, type RemoteProjectRecentEdit,
} from "../lib/remote-project-recent-data"
import { serversUsable } from "../lib/server-meta"
import { normalizeWorkspacePath } from "./app-session-reconciliation"
import {
  editRemoteProjectRecents, preferences, preferencesForBackend, recentFolders, remoteProjectHistory,
  removeRecentFolder, renameRecentFolderProject, type RecentFolder,
} from "./preferences"

type LocalRecentProject = RecentFolder & { kind: "local"; key: string; backendId: "local" }
export type RemoteRecentProject = RemoteProjectRecentData & { kind: "remote"; key: string; backendId: string; serverLabel: string }
export type RecentProject = LocalRecentProject | RemoteRecentProject

const log = getLogger("actions")
const remoteServers = () => preferencesForBackend(LOCAL_BACKEND_ID).remoteServers()
export const remoteRecentProjectsUsable = () => preferences().multiBackend === true && serversUsable()
export function savedProjectProfile(policy: ServerSelectionIntent) {
  if (preferences().multiBackend !== true) return
  const profile = remoteServers().find(server => server.id === policy.id)
  if (profile && sameServerSelection(profile, policy)) return profile
}

const [pendingLaunches, setPendingLaunches] = createSignal<{ recent: RemoteProjectRecentData; aliasKey: string }[]>([])

/** Display data only: show a selected occurrence while its history write settles. */
const eligibleRemoteRecents = createMemo(() => {
  const rows = new Map(remoteProjectHistory().recents.map(item => [remoteProjectRecentKey(item), item]))
  for (const { recent, aliasKey } of pendingLaunches()) {
    const key = remoteProjectRecentKey(recent)
    const previous = rows.get(key)
    const projectName = previous?.projectName ?? recent.projectName ?? rows.get(aliasKey)?.projectName
    rows.delete(aliasKey)
    rows.set(key, { ...recent, projectName, lastAccessed: Math.max(previous?.lastAccessed ?? 0, recent.lastAccessed) })
  }
  return [...rows.values()].filter(item => savedProjectProfile(item.policy)).sort((a, b) => b.lastAccessed - a.lastAccessed)
})

export function latestRemoteProjectPath(policy: ServerSelectionIntent): string | undefined {
  return eligibleRemoteRecents().find(item => sameServerSelection(item.policy, policy))?.path
}

/** Browse combines destination shortcuts with this host's opens for the exact saved profile. */
export function browsedRemoteRecents(profile: RemoteServerProfile, shortcuts: RemoteServerBrowseResponse["recents"]): RemoteRecentProject[] {
  const serverLabel = qualifiedServerDisplayName(profile, remoteServers())
  const rows = new Map<string, RemoteRecentProject>()
  const opened = eligibleRemoteRecents().filter(item => sameServerSelection(item.policy, profile))
  for (const recent of [...opened, ...shortcuts]) {
    const key = JSON.stringify([profile.id, normalizeWorkspacePath(recent.path)])
    const before = rows.get(key)
    rows.set(key, { ...recent, ...before, projectName: before?.projectName ?? recent.projectName,
      lastAccessed: Math.max(before?.lastAccessed ?? recent.lastAccessed, recent.lastAccessed),
      kind: "remote", backendId: profile.id, serverLabel, policy: profile, key })
  }
  return [...rows.values()].sort((a, b) => b.lastAccessed - a.lastAccessed)
}

export const recentProjects = createMemo<readonly RecentProject[]>((previous = []) => {
  const entries: RecentProject[] = recentFolders().map(folder => ({
    ...folder, kind: "local", backendId: "local", key: JSON.stringify([LOCAL_BACKEND_ID, folder.path]),
  }))
  if (remoteRecentProjectsUsable()) {
    const profiles = remoteServers()
    for (const recent of eligibleRemoteRecents()) {
      const profile = savedProjectProfile(recent.policy)
      if (!profile) continue
      entries.push({
        ...recent, kind: "remote", backendId: profile.id, serverLabel: qualifiedServerDisplayName(profile, profiles),
        key: JSON.stringify([profile.id, normalizeWorkspacePath(recent.path)]),
      })
    }
  }
  const previousByKey = new Map(previous.map(recent => [recent.key, recent]))
  const mixed = entries.some(recent => recent.kind === "remote")
  return (mixed ? entries.sort((a, b) => b.lastAccessed - a.lastAccessed).slice(0, RECENT_PROJECT_LIMIT) : entries).map(recent => {
    const before = previousByKey.get(recent.key)
    if (before && before.path === recent.path && before.projectName === recent.projectName && before.lastAccessed === recent.lastAccessed
      && (recent.kind === "local" && before.kind === "local" || recent.kind === "remote" && before.kind === "remote"
        && before.serverLabel === recent.serverLabel && sameServerSelection(before.policy, recent.policy))) return before
    return recent
  })
}, [], { equals: (before, after) => before.length === after.length && before.every((entry, index) => entry === after[index]) })

export function recordRemoteProjectLaunch(policy: ServerSelectionIntent, path: string, alias = path, projectName?: string): void {
  const recent = normalizeRemoteProjectRecent({ policy, path, lastAccessed: Date.now(), projectName })
  if (!recent || !savedProjectProfile(policy)) return
  const key = remoteProjectRecentKey(recent)
  const aliasKey = remoteProjectRecentKey({ policy, path: alias })
  const pending = { recent, aliasKey }
  setPendingLaunches(previous => [...previous, pending])
  void editRemoteProjectRecents(({ recents }) => {
    if (!savedProjectProfile(policy)) return
    const aliasRecord = aliasKey === key ? undefined : recents.find(item => remoteProjectRecentKey(item) === aliasKey)
    const { projectName: openedName = aliasRecord?.projectName, ...record } = recent
    const patch: Record<string, RemoteProjectRecentEdit | null> = { [key]: { ...record, ...(openedName ? { openedName } : {}) } }
    if (aliasKey !== key) patch[aliasKey] = null
    return patch
  }).catch(error => log.error("Failed to remember remote project", error))
    .finally(() => setPendingLaunches(previous => previous.filter(candidate => candidate !== pending)))
}

export async function removeRecentProject(recent: RecentProject): Promise<void> {
  if (recent.kind === "local") return removeRecentFolder(recent.path)
  await editRemoteProjectRecents(() => {
    if (!remoteRecentProjectsUsable() || !savedProjectProfile(recent.policy)) return
    return { [remoteProjectRecentKey(recent)]: null }
  })
}

export async function renameRecentProject(recent: RecentProject, projectName: string): Promise<void> {
  if (recent.kind === "local") return renameRecentFolderProject(recent.path, projectName)
  const name = recentProjectName(projectName)
  if (!name) return
  await editRemoteProjectRecents(({ recents }) => {
    if (!remoteRecentProjectsUsable() || !savedProjectProfile(recent.policy)) return
    const key = remoteProjectRecentKey(recent)
    if (recents.some(item => remoteProjectRecentKey(item) === key)) return { [key]: { projectName: name } }
  })
}
