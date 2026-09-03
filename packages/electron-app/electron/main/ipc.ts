import { BrowserWindow, Notification, dialog, ipcMain, powerSaveBlocker, shell, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron"
import fs from "node:fs"
import { requestMicrophoneAccess } from "./permissions"
import type { DeveloperMode } from "./developer-mode"
import type { CliProcessManager } from "./process-manager"
import { openWorkspaceTarget, type WorkspaceEditor, type WorkspaceOpenTarget } from "./workspace-open"
import { popupTitlebarMenu, setWorkspaceMenuEnabled, type TitlebarMenu } from "./menu"
import { validateMainFrame } from "./ipc-security"

interface LocalSender {
  id: string
  window: BrowserWindow
}

interface CliIPCDependencies {
  resolveLocal(sender: IpcMainInvokeEvent["sender"]): LocalSender | undefined
  resolvePreferences?(sender: IpcMainInvokeEvent["sender"]): BrowserWindow | undefined
  getAllowedOrigins(window: BrowserWindow): string[]
  newWindow(): Promise<unknown>
  nextFolder(windowId: string): string | null
  acknowledgeFolder(windowId: string, folder: string, opened: boolean): void
  developerMode: DeveloperMode
}

interface DialogOpenRequest {
  mode: "directory" | "file"
  title?: string
  defaultPath?: string
  filters?: Array<{ name?: string; extensions: string[] }>
  multiple?: boolean
}

interface DialogOpenResult {
  canceled: boolean
  paths: string[]
}

async function resolveLocalWorkspaceFolder(window: BrowserWindow, cliManager: CliProcessManager, instanceId: string, worktreeSlug: string): Promise<string> {
  const baseUrl = cliManager.getStatus().url
  if (!baseUrl) throw new Error("Local CodeNomad server is unavailable")
  const cookieName = cliManager.getAuthCookieName()
  const cookie = (await window.webContents.session.cookies.get({ url: baseUrl, name: cookieName }))[0]
  const headers = cookie ? { Cookie: `${cookie.name}=${cookie.value}` } : undefined
  const workspaceResponse = await fetch(`${baseUrl.replace(/\/$/, "")}/api/workspaces/${encodeURIComponent(instanceId)}`, { headers, signal: AbortSignal.timeout(5_000) })
  if (!workspaceResponse.ok) throw new Error("Workspace is not active")
  const workspace = await workspaceResponse.json() as { path?: unknown }
  if (typeof workspace.path !== "string") throw new Error("Workspace path is unavailable")
  if (worktreeSlug === "root") return workspace.path
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/workspaces/${encodeURIComponent(instanceId)}/worktrees`, { headers, signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error("Workspace worktrees are unavailable")
  const payload = await response.json() as { worktrees?: Array<{ slug?: unknown; directory?: unknown }> }
  const worktree = payload.worktrees?.find((candidate) => candidate.slug === worktreeSlug)
  if (!worktree || typeof worktree.directory !== "string") throw new Error("Selected worktree is unavailable")
  return worktree.directory
}

export function setupCliIPC(cliManager: CliProcessManager, dependencies: CliIPCDependencies) {
  let wakeLockId: number | null = null
  const wakeLockWindows = new Set<number>()
  const wakeCleanupInstalled = new Set<number>()
  const local = (event: IpcMainInvokeEvent): LocalSender => {
    const record = dependencies.resolveLocal(event.sender)
    if (!record) throw new Error("Native operation is limited to local windows")
    validateMainFrame(event, record.window, dependencies.getAllowedOrigins(record.window))
    return record
  }
  const settings = (event: IpcMainInvokeEvent): BrowserWindow => {
    const record = dependencies.resolveLocal(event.sender)
    const window = record?.window ?? dependencies.resolvePreferences?.(event.sender)
    if (!window) throw new Error("Native settings operation requires a local application window")
    validateMainFrame(event, window, dependencies.getAllowedOrigins(window))
    return window
  }
  const anyTrusted = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error("Native operation requires a window")
    validateMainFrame(event, window, dependencies.getAllowedOrigins(window))
    return window
  }
  const updateWakeLock = (): boolean => {
    if (wakeLockWindows.size > 0) {
      if (wakeLockId === null || !powerSaveBlocker.isStarted(wakeLockId)) wakeLockId = powerSaveBlocker.start("prevent-app-suspension")
      return true
    }
    if (wakeLockId !== null && powerSaveBlocker.isStarted(wakeLockId)) powerSaveBlocker.stop(wakeLockId)
    wakeLockId = null
    return false
  }

  ipcMain.handle("cli:getStatus", async (event) => { settings(event); return cliManager.getStatus() })
  ipcMain.handle("cli:restart", async (event) => { settings(event); return cliManager.restart({ dev: process.env.NODE_ENV === "development" }) })
  ipcMain.handle("window:new", async (event) => { local(event); await dependencies.newWindow(); return { ok: true } })
  ipcMain.handle("window:nextFolder", async (event) => dependencies.nextFolder(local(event).id))
  ipcMain.handle("window:ackFolder", async (event, folder: unknown, opened: unknown) => {
    const { id } = local(event)
    if (typeof folder !== "string" || typeof opened !== "boolean") throw new Error("Invalid folder acknowledgement")
    dependencies.acknowledgeFolder(id, folder, opened)
    return { ok: true }
  })
  ipcMain.handle("menu:popup", async (event, menu: unknown, x: unknown, y: unknown) => {
    const { window } = local(event)
    if ((menu !== "file" && menu !== "edit" && menu !== "view" && menu !== "window" && menu !== "help")
      || typeof x !== "number" || typeof y !== "number") throw new Error("Invalid titlebar menu request")
    popupTitlebarMenu(window, menu as TitlebarMenu, x, y)
  })
  ipcMain.handle("developer-mode:get", async (event) => {
    local(event)
    return dependencies.developerMode.state()
  })
  ipcMain.handle("developer-mode:set", async (event, enabled: unknown) => {
    local(event)
    if (typeof enabled !== "boolean") throw new Error("Developer Mode requires a boolean value")
    return dependencies.developerMode.setEnabled(enabled)
  })

  ipcMain.handle("dialog:open", async (event, request: DialogOpenRequest): Promise<DialogOpenResult> => {
    const window = settings(event)
    if (!request || (request.mode !== "directory" && request.mode !== "file")) throw new Error("Invalid dialog request")
    const properties: OpenDialogOptions["properties"] = request.mode === "directory" ? ["openDirectory", "createDirectory"] : ["openFile"]
    if (request.mode === "file" && request.multiple) properties.push("multiSelections")
    const result = await dialog.showOpenDialog(window, {
      title: request.title,
      defaultPath: request.defaultPath,
      properties,
      filters: request.filters?.map((filter) => ({ name: filter.name ?? "Files", extensions: filter.extensions })),
    })
    return { canceled: result.canceled, paths: result.filePaths }
  })

  ipcMain.handle("filesystem:getDirectoryPaths", async (event, paths: unknown): Promise<string[]> => {
    local(event)
    if (!Array.isArray(paths)) return []
    return paths.filter((value): value is string => {
      if (typeof value !== "string" || !value.trim()) return false
      try { return fs.statSync(value).isDirectory() } catch { return false }
    })
  })

  ipcMain.handle("workspace:openTarget", async (event, payload: { target?: unknown; instanceId?: unknown; worktreeSlug?: unknown; path?: unknown; editor?: unknown }): Promise<{ ok: true }> => {
    const { window } = local(event)
    const { target, instanceId, worktreeSlug, editor } = payload ?? {}
    if ((target !== "default" && target !== "reveal" && target !== "terminal" && target !== "editor")
      || typeof instanceId !== "string" || typeof worktreeSlug !== "string"
      || (payload?.path !== undefined && typeof payload.path !== "string")
      || (editor !== undefined && editor !== "vscode" && editor !== "cursor" && editor !== "zed" && editor !== "vscodium")) {
      throw new Error("Invalid workspace open request")
    }
    const folder = await resolveLocalWorkspaceFolder(window, cliManager, instanceId, worktreeSlug)
    await openWorkspaceTarget(target as WorkspaceOpenTarget, folder, payload?.path as string | undefined, editor as WorkspaceEditor | undefined, {
      openPath: (path) => shell.openPath(path), revealPath: (path) => shell.showItemInFolder(path),
    })
    return { ok: true }
  })

  ipcMain.handle("workspace:setMenuEnabled", (event, enabled: unknown): { ok: true } => {
    setWorkspaceMenuEnabled(local(event).window, enabled === true)
    return { ok: true }
  })

  ipcMain.handle("power:setWakeLock", async (event, enabled: boolean): Promise<{ enabled: boolean }> => {
    const window = anyTrusted(event)
    const id = window.webContents.id
    if (!wakeCleanupInstalled.has(id)) {
      wakeCleanupInstalled.add(id)
      window.webContents.once("destroyed", () => {
        wakeLockWindows.delete(id)
        wakeCleanupInstalled.delete(id)
        updateWakeLock()
      })
    }
    if (enabled) wakeLockWindows.add(id)
    else wakeLockWindows.delete(id)
    try { return { enabled: updateWakeLock() } } catch { return { enabled: false } }
  })

  ipcMain.handle("media:requestMicrophoneAccess", async (event): Promise<{ granted: boolean }> => {
    anyTrusted(event)
    return { granted: await requestMicrophoneAccess() }
  })
  ipcMain.handle("notifications:show", async (event, payload: { title?: unknown; body?: unknown }): Promise<{ ok: boolean; reason?: string }> => {
    anyTrusted(event)
    if (!Notification.isSupported()) return { ok: false, reason: "unsupported" }
    try {
      new Notification({ title: typeof payload?.title === "string" ? payload.title : "CodeNomad", body: typeof payload?.body === "string" ? payload.body : "" }).show()
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  })
}
