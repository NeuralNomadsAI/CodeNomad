import type { RemoteServerProfile } from "../../../server/src/api-types"
import { canOpenRemoteProjectTabs } from "../lib/native/remote-view"
import { mixRecents, type LaunchableRecent } from "../lib/remote-project-recents"
import { selectRemoteProjectTab } from "./app-tabs"
import { recentFolders, remoteProjectRecents, remoteServers } from "./preferences"
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

/** This computer's recent folders with the remote projects this window can reopen. */
export function launchableRecents(): LaunchableRecent[] {
  if (!canOpenRemoteProjectTabs()) return recentFolders()
  return mixRecents(recentFolders(), remoteProjectRecents(), remoteServers().filter(opensRemoteProjectTab))
}

/** The project name the embedded page reported, else its server's name. */
export function remoteProjectTabLabel(tab: Pick<RemoteProjectTabRecord, "profileId" | "title">): string {
  return tab.title ?? remoteServers().find((server) => server.id === tab.profileId)?.name ?? tab.profileId
}

export function openRemoteProjectTabFor(recent: LaunchableRecent): string | undefined {
  const remote = recent.remote
  if (!remote) return undefined
  return remoteProjectTabs().find((tab) => tab.profileId === remote.profileId && tab.folder === recent.path)?.token
}
