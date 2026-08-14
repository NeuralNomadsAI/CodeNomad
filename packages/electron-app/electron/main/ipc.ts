import { BrowserWindow, Notification, dialog, ipcMain, powerSaveBlocker, shell, type OpenDialogOptions } from "electron"
import fs from "fs"
import { requestMicrophoneAccess } from "./permissions"
import type { CliProcessManager, CliStatus } from "./process-manager"
import { openWorkspaceTarget, type WorkspaceEditor, type WorkspaceOpenTarget } from "./workspace-open"
import { setWorkspaceMenuEnabled } from "./menu"

let wakeLockId: number | null = null

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

async function resolveLocalWorkspaceFolder(
  mainWindow: BrowserWindow,
  cliManager: CliProcessManager,
  instanceId: string,
  worktreeSlug: string,
): Promise<string> {
  const baseUrl = cliManager.getStatus().url
  if (!baseUrl) throw new Error("Local CodeNomad server is unavailable")
  const cookieName = cliManager.getAuthCookieName()
  const cookie = (await mainWindow.webContents.session.cookies.get({ url: baseUrl, name: cookieName }))[0]
  const headers = cookie ? { Cookie: `${cookie.name}=${cookie.value}` } : undefined
  const workspaceResponse = await fetch(`${baseUrl.replace(/\/$/, "")}/api/workspaces/${encodeURIComponent(instanceId)}`, {
    headers,
    signal: AbortSignal.timeout(5_000),
  })
  if (!workspaceResponse.ok) throw new Error("Workspace is not active")
  const workspace = await workspaceResponse.json() as { path?: unknown }
  if (typeof workspace.path !== "string") throw new Error("Workspace path is unavailable")
  if (worktreeSlug === "root") return workspace.path

  const worktreeResponse = await fetch(
    `${baseUrl.replace(/\/$/, "")}/api/workspaces/${encodeURIComponent(instanceId)}/worktrees`,
    { headers, signal: AbortSignal.timeout(5_000) },
  )
  if (!worktreeResponse.ok) throw new Error("Workspace worktrees are unavailable")
  const payload = await worktreeResponse.json() as { worktrees?: Array<{ slug?: unknown; directory?: unknown }> }
  const worktree = payload.worktrees?.find((candidate) => candidate.slug === worktreeSlug)
  if (!worktree || typeof worktree.directory !== "string") throw new Error("Selected worktree is unavailable")
  return worktree.directory
}

export function setupCliIPC(mainWindow: BrowserWindow, cliManager: CliProcessManager) {
  cliManager.on("status", (status: CliStatus) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cli:status", status)
    }
  })

  cliManager.on("ready", (status: CliStatus) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cli:ready", status)
    }
  })

  cliManager.on("error", (error: Error) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cli:error", { message: error.message })
    }
  })

  ipcMain.handle("cli:getStatus", async () => cliManager.getStatus())

  ipcMain.handle("cli:restart", async () => {
    const devMode = process.env.NODE_ENV === "development"
    return cliManager.restart({ dev: devMode })
  })

  ipcMain.handle("dialog:open", async (_, request: DialogOpenRequest): Promise<DialogOpenResult> => {
    const properties: OpenDialogOptions["properties"] =
      request.mode === "directory" ? ["openDirectory", "createDirectory"] : ["openFile"]
    if (request.mode === "file" && request.multiple) {
      properties.push("multiSelections")
    }

    const filters = request.filters?.map((filter) => ({
      name: filter.name ?? "Files",
      extensions: filter.extensions,
    }))

    const windowTarget = mainWindow.isDestroyed() ? undefined : mainWindow
    const dialogOptions: OpenDialogOptions = {
      title: request.title,
      defaultPath: request.defaultPath,
      properties,
      filters,
    }
    const result = windowTarget
      ? await dialog.showOpenDialog(windowTarget, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)

    return { canceled: result.canceled, paths: result.filePaths }
  })

  ipcMain.handle("filesystem:getDirectoryPaths", async (_event, paths: unknown): Promise<string[]> => {
    if (!Array.isArray(paths)) {
      return []
    }

    const directories = paths.filter((value): value is string => {
      if (typeof value !== "string" || value.trim().length === 0) {
        return false
      }
      try {
        return fs.statSync(value).isDirectory()
      } catch {
        return false
      }
    })
    return directories
  })

  ipcMain.handle(
    "workspace:openTarget",
    async (event, payload: { target?: unknown; instanceId?: unknown; worktreeSlug?: unknown; path?: unknown; editor?: unknown }): Promise<{ ok: true }> => {
      if (mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new Error("Workspace open requests are limited to the local main window")
      }
      const localUrl = cliManager.getStatus().url
      if (!localUrl || new URL(event.senderFrame.url).origin !== new URL(localUrl).origin) {
        throw new Error("Workspace open requests require the local CodeNomad origin")
      }
      const target = payload?.target
      const instanceId = payload?.instanceId
      const worktreeSlug = payload?.worktreeSlug
      const editor = payload?.editor
      if (
        (target !== "default" && target !== "reveal" && target !== "terminal" && target !== "editor")
        || typeof instanceId !== "string"
        || typeof worktreeSlug !== "string"
        || (payload.path !== undefined && typeof payload.path !== "string")
        || (editor !== undefined && editor !== "vscode" && editor !== "cursor" && editor !== "zed" && editor !== "vscodium")
      ) {
        throw new Error("Invalid workspace open request")
      }
      const workspaceFolder = await resolveLocalWorkspaceFolder(mainWindow, cliManager, instanceId, worktreeSlug)
      await openWorkspaceTarget(
        target as WorkspaceOpenTarget,
        workspaceFolder,
        payload.path as string | undefined,
        editor as WorkspaceEditor | undefined,
        { openPath: (path) => shell.openPath(path), revealPath: (path) => shell.showItemInFolder(path) },
      )
      return { ok: true }
    },
  )

  ipcMain.handle("workspace:setMenuEnabled", (event, enabled: unknown): { ok: true } => {
    if (mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error("Workspace menu updates are limited to the local main window")
    }
    setWorkspaceMenuEnabled(enabled === true)
    return { ok: true }
  })

  ipcMain.handle("power:setWakeLock", async (_event, enabled: boolean): Promise<{ enabled: boolean }> => {
    const next = Boolean(enabled)
    if (next) {
      if (wakeLockId !== null && powerSaveBlocker.isStarted(wakeLockId)) {
        return { enabled: true }
      }
      try {
        wakeLockId = powerSaveBlocker.start("prevent-app-suspension")
      } catch {
        wakeLockId = null
        return { enabled: false }
      }
      return { enabled: true }
    }

    if (wakeLockId !== null) {
      try {
        if (powerSaveBlocker.isStarted(wakeLockId)) {
          powerSaveBlocker.stop(wakeLockId)
        }
      } finally {
        wakeLockId = null
      }
    }
    return { enabled: false }
  })

  ipcMain.handle(
    "media:requestMicrophoneAccess",
    async (): Promise<{ granted: boolean }> => ({ granted: await requestMicrophoneAccess() }),
  )

  ipcMain.handle(
    "remote:openWindow",
    async (
      _event,
      payload: { id: string; name: string; baseUrl: string; skipTlsVerify: boolean },
    ): Promise<{ ok: boolean }> => {
      const opener = (mainWindow as BrowserWindow & {
        __codenomadOpenRemoteWindow?: (payload: {
          id: string
          name: string
          baseUrl: string
          skipTlsVerify: boolean
        }) => Promise<void>
      }).__codenomadOpenRemoteWindow
      if (!opener) {
        throw new Error("Remote window opening is not available")
      }
      await opener(payload)
      return { ok: true }
    },
  )

  ipcMain.handle(
    "notifications:show",
    async (_event, payload: { title?: unknown; body?: unknown }): Promise<{ ok: boolean; reason?: string }> => {
      if (!Notification.isSupported()) {
        return { ok: false, reason: "unsupported" }
      }

      const title = typeof payload?.title === "string" ? payload.title : "CodeNomad"
      const body = typeof payload?.body === "string" ? payload.body : ""
      try {
        const notification = new Notification({ title, body })
        notification.show()
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
  )
}
