import { isDesktopHost, isLocalWindow, isTauriHost } from "./runtime-env"
import type { ViewMenuState } from "./native/view-menu"
import { LOCAL_BACKEND_ID, parseInstanceKey } from "./backend-identity"

export type WorkspaceOpenTarget = "default" | "reveal" | "terminal" | "editor"
export type WorkspaceEditor = "vscode" | "cursor" | "zed" | "vscodium"

export interface WorkspaceOpenRequest {
  target: WorkspaceOpenTarget
  instanceId: string
  worktreeSlug: string
  path?: string
  editor?: WorkspaceEditor
}

export function canOpenWorkspacePaths(instanceId?: string): boolean {
  return isDesktopHost() && isLocalWindow()
    && (!instanceId || parseInstanceKey(instanceId).backendId === LOCAL_BACKEND_ID)
}

export async function openWorkspacePath(request: WorkspaceOpenRequest): Promise<void> {
  if (!canOpenWorkspacePaths(request.instanceId)) throw new Error("Native workspace actions are unavailable")

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

/** Whether this host opens local paths with the system; older hosts lack the action. */
export function canOpenLocalPaths(instanceId?: string): boolean {
  if (!canOpenWorkspacePaths(instanceId)) return false
  return isTauriHost() ? window.__CODENOMAD_LOCAL_PATHS__ === true : typeof window.electronAPI?.openLocalPath === "function"
}

/** What the host leaves to the caller instead of opening: nothing, text files
 * or every file. A missing path is left to the caller unless `none`. */
export type LocalPathKeep = "none" | "text" | "files"

/** `opened` by the system, `kept` for the caller to show, or `missing`. */
export type LocalPathResult = "opened" | "kept" | "missing"

/** Opens an absolute local path with the system: a folder in the file
 * manager, a file with its default application. Resolves `kept`, opening
 * nothing, when the host leaves the path to the caller (`keep`). */
export async function openLocalPath(path: string, keep: LocalPathKeep): Promise<LocalPathResult> {
  if (!canOpenLocalPaths()) throw new Error("Native workspace actions are unavailable")
  if (isTauriHost()) return await window.__TAURI__!.core!.invoke("open_local_path", { path, keep }) as LocalPathResult
  return (await window.electronAPI!.openLocalPath!({ path, keep })).result
}

export async function setWorkspaceMenuEnabled(enabled: boolean, viewState?: ViewMenuState): Promise<void> {
  if (!isDesktopHost() || !isLocalWindow()) return
  if (isTauriHost()) {
    await window.__TAURI__?.core?.invoke("set_workspace_menu_enabled", { enabled, viewState })
    return
  }
  await window.electronAPI?.setWorkspaceMenuEnabled?.(enabled, viewState)
}
