import { isElectronHost, isLocalWindow } from "../runtime-env"
import { backendIdOf } from "../backend-identity"
import type { RestorableSessionState, RestorableWorkspaceTabState } from "../../stores/client-state-codec"
import { normalizeWorkspacePath } from "../../stores/app-session-reconciliation"

type SelectedTab = Pick<RestorableWorkspaceTabState, "kind" | "workspaceId" | "backendId" | "serverId" | "folder" | "occurrence">
  | { kind: "sidecar"; sidecarId: string } | { kind: "blank" }

// An unmanaged renderer reload cannot wait for the asynchronous native snapshot.
// Carry only the selected identity; the native snapshot still owns all tab data.
function key() {
  return `codenomad.reload-tab.${window.__CODENOMAD_WINDOW_ID__ ?? ""}`
}

function identity(tab: SelectedTab | undefined): string | undefined {
  if (tab?.kind === "sidecar") return JSON.stringify(["sidecar", tab.sidecarId])
  if (tab?.kind === "workspace") {
    if (tab.workspaceId) return JSON.stringify(["workspace", backendIdOf(tab), tab.serverId, tab.workspaceId])
    return JSON.stringify(["waiting", backendIdOf(tab), tab.serverId, normalizeWorkspacePath(tab.folder), tab.occurrence ?? 0])
  }
}

export function saveReloadTabSelection(tab: SelectedTab | undefined): void {
  try {
    const selected = identity(tab)
    if (selected) window.sessionStorage.setItem(key(), selected)
    else window.sessionStorage.removeItem(key())
  } catch { /* The native snapshot remains available. */ }
}

export function applyReloadTabSelection(snapshot: RestorableSessionState | null): RestorableSessionState | null {
  if (!isElectronHost() || !isLocalWindow()) return snapshot
  try {
    const selected = window.sessionStorage.getItem(key())
    window.sessionStorage.removeItem(key())
    if (!snapshot || !selected) return snapshot
    const index = snapshot.tabs.findIndex(tab => identity(tab) === selected)
    return index < 0 ? snapshot : { ...snapshot, activeTabIndex: index }
  } catch { return snapshot }
}
