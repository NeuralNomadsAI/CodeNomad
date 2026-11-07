import { appTabs, getInstanceAppTabId, getRemoteProjectAppTabId, getSidecarAppTabId, selectAppTab } from "../stores/app-tabs"
import { getExistingInstanceForFolder } from "../stores/instances"
import { openRemoteProjectTabFor } from "../stores/remote-project-open"
import { sidecarTabs } from "../stores/sidecars"
import { setShowFolderSelection } from "../stores/ui"
import { tGlobal } from "./i18n"
import { getDisplayPath, getProjectDisplayName } from "./recent-folder-display"
import type { LaunchableRecent } from "./remote-project-recents"

/** The separate Open action joins a visible occurrence; choosing the row opens another. */
export function recentOpenTarget(recent: LaunchableRecent): string | undefined {
  let id: string | undefined
  if (recent.sidecar) {
    const tab = sidecarTabs().find((tab) => tab.sidecarId === recent.sidecar!.sidecarId)
    if (tab) id = getSidecarAppTabId(tab.token)
  } else if (recent.remote) {
    const token = openRemoteProjectTabFor(recent)
    if (token) id = getRemoteProjectAppTabId(token)
  } else {
    const instance = getExistingInstanceForFolder(recent.path)
    if (instance) id = getInstanceAppTabId(instance.id)
  }
  return appTabs().some((tab) => tab.id === id) ? id : undefined
}

export function joinRecentOpenTarget(recent: LaunchableRecent, selectLocal: (id: string, path: string) => void): void {
  const id = recentOpenTarget(recent)
  if (!id) return
  if (!recent.remote && !recent.sidecar) selectLocal(id.slice("instance:".length), recent.path)
  else {
    selectAppTab(id)
    setShowFolderSelection(false)
  }
}

/** Shared names include the server and path for homonymous projects. */
export function recentAccessibleName(recent: LaunchableRecent): string {
  const name = getProjectDisplayName(recent.path, recent.projectName)
  const location = recent.sidecar ? tGlobal("folderSelection.recent.sidecar")
    : `${recent.remote?.serverName ?? tGlobal("folderSelection.browseMenu.thisComputer")} · ${getDisplayPath(recent.path)}`
  return `${name} · ${location}`
}
