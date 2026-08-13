import { isDesktopHost, isLocalWindow, isTauriHost } from "./runtime-env"

export type WorkspaceOpenTarget = "default" | "reveal" | "terminal" | "editor"
export type WorkspaceEditor = "vscode" | "cursor" | "zed" | "vscodium"

export interface WorkspaceOpenRequest {
  target: WorkspaceOpenTarget
  instanceId: string
  worktreeSlug: string
  path?: string
  editor?: WorkspaceEditor
}

export function canOpenWorkspacePaths(): boolean {
  return isDesktopHost() && isLocalWindow()
}

export async function openWorkspacePath(request: WorkspaceOpenRequest): Promise<void> {
  if (!canOpenWorkspacePaths()) throw new Error("Native workspace actions are unavailable")

  if (isTauriHost()) {
    const invoke = window.__TAURI__?.core?.invoke
    if (!invoke) throw new Error("Tauri bridge is unavailable")
    await invoke("open_workspace_target", { ...request })
    return
  }

  const openTarget = window.electronAPI?.openWorkspaceTarget
  if (!openTarget) throw new Error("Electron bridge is unavailable")
  await openTarget(request)
}

export async function setWorkspaceMenuEnabled(enabled: boolean): Promise<void> {
  if (!isDesktopHost() || !isLocalWindow()) return
  if (isTauriHost()) {
    await window.__TAURI__?.core?.invoke("set_workspace_menu_enabled", { enabled })
    return
  }
  await window.electronAPI?.setWorkspaceMenuEnabled?.(enabled)
}
