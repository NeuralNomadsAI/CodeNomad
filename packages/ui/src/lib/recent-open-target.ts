import { tGlobal } from "./i18n"
import { getProjectDisplayName } from "./recent-folder-display"
import { appTabs, selectAppTab } from "../stores/app-tabs"
import { findOpenProjectTab, selectOpenProjectTab } from "../stores/remote-project-open"
import { recentProjects, type RecentProject } from "../stores/recent-projects"
import { sidecarTabs, sidecars } from "../stores/sidecars"
import { preferencesForBackend } from "../stores/preferences"
import { createMemo } from "solid-js"
import { sidecarsAllowed } from "./server-meta"
import { workspaceIdentity } from "../stores/app-session-reconciliation"
import { instances } from "../stores/instances"
import { openInstanceTabIds } from "../stores/app-tab-membership"

export type LaunchableRecent = RecentProject | {
  kind: "sidecar"; key: string; path: string; projectName: string; lastAccessed: number
}

export const launchableRecents = createMemo<readonly LaunchableRecent[]>(() => {
  const seen = new Set<string>()
  const openedSidecars = sidecarsAllowed() ? [
    ...preferencesForBackend("local").sidecarRecents(),
    ...sidecarTabs().slice().reverse().map(tab => [tab.sidecarId, parseInt(tab.token.split(":").at(-2) ?? "", 36) || 0] as const),
  ].flatMap(([id, lastAccessed]) => {
    const sidecar = sidecars().get(id)
    if (seen.has(id) || sidecar?.status !== "running") return []
    seen.add(id)
    return [{ kind: "sidecar" as const, key: `sidecar:${id}`, path: id, projectName: sidecar.name, lastAccessed }]
  }) : []
  return [...recentProjects(), ...openedSidecars].sort((a, b) => b.lastAccessed - a.lastAccessed)
})

export function recentOpenTarget(recent: LaunchableRecent) {
  if (recent.kind === "sidecar") return appTabs().find(tab => tab.kind === "sidecar" && tab.sidecarTab.sidecarId === recent.path)
  return findOpenProjectTab(recent.path, recent.backendId)
}

const projectsOpenElsewhere = createMemo(() => {
  const own = openInstanceTabIds()
  return new Set([...instances().values()]
    .filter(instance => instance.status === "ready" && !own.has(instance.id))
    .map(instance => workspaceIdentity(instance.folder, instance.backendId)))
})

export function recentOpenElsewhere(recent: LaunchableRecent): boolean {
  return recent.kind !== "sidecar" && !recentOpenTarget(recent)
    && projectsOpenElsewhere().has(workspaceIdentity(recent.path, recent.backendId))
}

export function recentAccessibleName(recent: LaunchableRecent): string {
  const name = getProjectDisplayName(recent.path, recent.projectName)
  return recent.kind === "sidecar" ? name : `${name} · ${recent.kind === "remote" ? recent.serverLabel : tGlobal("folderSelection.browseMenu.thisComputer")} · ${recent.path}`
}

export function joinRecentOpenTarget(recent: LaunchableRecent, onSelectLocal: (id: string, path: string) => void) {
  if (recent.kind === "remote") return selectOpenProjectTab(recent.policy, recent.path, recent.projectName)
  const tab = recentOpenTarget(recent)
  if (!tab) return false
  if (tab.kind === "instance") onSelectLocal(tab.instance.id, recent.path)
  else selectAppTab(tab.id)
  return true
}
