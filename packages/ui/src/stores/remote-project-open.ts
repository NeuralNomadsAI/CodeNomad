import type { RemoteServerProfile } from "../../../server/src/api-types"
import { canOpenRemoteProjectTabs } from "../lib/native/remote-view"
import { serverDisplayName } from "../lib/codenomad-link"
import { mixRecents, type LaunchableRecent } from "../lib/remote-project-recents"
import { getProjectDisplayName } from "../lib/recent-folder-display"
import { activeBlankTabId, replaceBlankTab, getRemoteProjectAppTabId, selectRemoteProjectTab } from "./app-tabs"
import { recentFolders, remoteProjectRecents, remoteServers, sidecarRecents } from "./preferences"
import { sidecars } from "./sidecars"
import { openRemoteProjectTab, remoteProjectTabs, type RemoteProjectTabRecord } from "./remote-project-tabs"
import { setShowFolderSelection } from "./ui"

/** A server opens in a tab unless its certificate is unverified: that one keeps its separate window. */
export const opensRemoteProjectTab = (profile: Pick<RemoteServerProfile, "skipTlsVerify">) =>
  !profile.skipTlsVerify && canOpenRemoteProjectTabs()

export function openRemoteProject(profileId: string, options: { folder?: string; entryUrl?: string } = {}, blankId: string | null = activeBlankTabId() ?? null): void {
  const tab = openRemoteProjectTab(profileId, options)
  selectRemoteProjectTab(tab.token)
  replaceBlankTab(blankId, getRemoteProjectAppTabId(tab.token))
  setShowFolderSelection(false)
}

/** The recent tabs: this computer's folders, the remote projects this window can reopen and configured SideCars. */
export function launchableRecents(): LaunchableRecent[] {
  const servers = canOpenRemoteProjectTabs() ? remoteServers() : []
  return mixRecents(recentFolders(), canOpenRemoteProjectTabs() ? remoteProjectRecents() : [], servers.filter(opensRemoteProjectTab)
    .map((server) => ({ id: server.id, name: serverDisplayName(server, servers) })), sidecarRecents(), [...sidecars().values()])
}

/** Prefer the reported or remembered project name, then its folder, then the server. */
export function remoteProjectTabLabel(tab: Pick<RemoteProjectTabRecord, "profileId" | "title" | "folder">): string {
  if (tab.title) return tab.title
  if (tab.folder) {
    const recent = remoteProjectRecents().find((entry) => entry.profileId === tab.profileId && entry.folder === tab.folder)
    return getProjectDisplayName(tab.folder, recent?.projectName)
  }
  const servers = remoteServers()
  const profile = servers.find((server) => server.id === tab.profileId)
  return profile ? serverDisplayName(profile, servers) : tab.profileId
}

export function openRemoteProjectTabFor(recent: LaunchableRecent): string | undefined {
  const remote = recent.remote
  if (!remote) return undefined
  return remoteProjectTabs().find((tab) => tab.profileId === remote.profileId && tab.folder === recent.path)?.token
}
