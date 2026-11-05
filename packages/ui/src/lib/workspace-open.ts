import { isDesktopHost, isLocalWindow, isTauriHost } from "./runtime-env"
import type { ViewMenuState } from "./native/view-menu"
import { tGlobal } from "./i18n"
import { getProjectAvailability } from "../stores/project-capability"
import { instances } from "../stores/instances"

export type WorkspaceOpenTarget = "default" | "reveal" | "terminal" | "editor"
export type WorkspaceEditor = "vscode" | "cursor" | "zed" | "vscodium"

export interface WorkspaceOpenRequest {
  target: WorkspaceOpenTarget
  instanceId: string
  worktreeSlug: string
  path?: string
  editor?: WorkspaceEditor
}

export class WorkspacePathUnavailableError extends Error {
  readonly code = "explicit_capability_unavailable"
  readonly capability = "files"
  readonly reason = { code: "localOnly" } as const
  constructor() { super(tGlobal("commands.openWorkspace.localOnly")) }
}

export function canOpenWorkspacePaths(instanceId?: string): boolean {
  if (!isDesktopHost() || !isLocalWindow()) return false
  // Omitted scope is host-global (for example command registration).
  if (instanceId === undefined) return true
  const instance = instances().get(instanceId)
  return Boolean(instance && (instance.binding?.serverId ?? instance.renderBinding?.serverId ?? instance.capabilities?.serverId ?? "local-shared") === "local-shared"
    && getProjectAvailability(instanceId, "files").allowed)
}

export async function openWorkspacePath(request: WorkspaceOpenRequest): Promise<void> {
  if (!canOpenWorkspacePaths(request.instanceId)) throw new WorkspacePathUnavailableError()

  try {
    if (isTauriHost()) {
      const invoke = window.__TAURI__?.core?.invoke
      if (!invoke) throw new Error("Tauri bridge is unavailable")
      await invoke("open_workspace_target", { ...request })
      return
    }

    const openTarget = window.electronAPI?.openWorkspaceTarget
    if (!openTarget) throw new Error("Electron bridge is unavailable")
    await openTarget(request)
  } catch (error) {
    // Electron wraps IPC errors; Tauri returns the serialized refusal directly.
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('"code":"explicit_capability_unavailable"')) {
      throw new WorkspacePathUnavailableError()
    }
    throw error
  }
}

export async function setWorkspaceMenuEnabled(enabled: boolean, viewState?: ViewMenuState): Promise<void> {
  if (!isDesktopHost() || !isLocalWindow()) return
  if (isTauriHost()) {
    await window.__TAURI__?.core?.invoke("set_workspace_menu_enabled", { enabled, viewState })
    return
  }
  await window.electronAPI?.setWorkspaceMenuEnabled?.(enabled, viewState)
}
