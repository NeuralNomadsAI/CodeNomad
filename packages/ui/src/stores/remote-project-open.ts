import type { RemoteServerProfile } from "../../../server/src/api-types"
import { canOpenRemoteProjectTabs } from "../lib/native/remote-view"
import { serverDisplayName } from "../lib/codenomad-link"
import { mixRecents, type LaunchableRecent } from "../lib/remote-project-recents"
import { selectRemoteProjectTab } from "./app-tabs"
import { recentFolders, remoteProjectRecents, remoteServers, sidecarRecents } from "./preferences"
import { sidecars } from "./sidecars"
import { openRemoteProjectTab, remoteProjectTabs, type RemoteProjectTabRecord } from "./remote-project-tabs"
import { setShowFolderSelection } from "./ui"

/** A server opens in a tab unless its certificate is unverified: that one keeps its separate window. */
export const opensRemoteProjectTab = (profile: Pick<RemoteServerProfile, "skipTlsVerify">) =>
  !profile.skipTlsVerify && canOpenRemoteProjectTabs()

export function openRemoteProject(profileId: string, options: { folder?: string; entryUrl?: string } = {}): void {
  const tab = openRemoteProjectTab(profileId, options)
  selectRemoteProjectTab(tab.token)
  setShowFolderSelection(false)
}

/** The recent tabs: this computer's folders, the remote projects this window can reopen and configured SideCars. */
export function launchableRecents(): LaunchableRecent[] {
  const servers = canOpenRemoteProjectTabs() ? remoteServers() : []
  return mixRecents(recentFolders(), canOpenRemoteProjectTabs() ? remoteProjectRecents() : [], servers.filter(opensRemoteProjectTab)
    .map((server) => ({ id: server.id, name: serverDisplayName(server, servers) })), sidecarRecents(), [...sidecars().values()])
}

/** The project name the embedded page reported, else its server's name (never its raw address). */
export function remoteProjectTabLabel(tab: Pick<RemoteProjectTabRecord, "profileId" | "title">): string {
  if (tab.title) return tab.title
  const servers = remoteServers()
  const profile = servers.find((server) => server.id === tab.profileId)
  return profile ? serverDisplayName(profile, servers) : tab.profileId
}

export function openRemoteProjectTabFor(recent: LaunchableRecent): string | undefined {
  const remote = recent.remote
  if (!remote) return undefined
  return remoteProjectTabs().find((tab) => tab.profileId === remote.profileId && tab.folder === recent.path)?.token
}
