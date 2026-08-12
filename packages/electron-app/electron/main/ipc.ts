import { BrowserWindow, Notification, dialog, ipcMain, powerSaveBlocker, shell, type OpenDialogOptions } from "electron"
import { execFile } from "child_process"
import fs from "fs"
import pathUtils from "path"
import { requestMicrophoneAccess } from "./permissions"
import type { CliProcessManager, CliStatus } from "./process-manager"

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

function gitWorktreePaths(repoRoot: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repoRoot, "worktree", "list", "--porcelain", "-z"], (error, stdout) => {
      if (error) return reject(error)
      resolve(stdout.split("\0").flatMap((entry) => entry.startsWith("worktree ") ? [entry.slice(9)] : []))
    })
  })
}

async function isRegisteredGitWorktree(repoRoot: string, path: string): Promise<boolean> {
  const requested = fs.realpathSync.native(path)
  const root = fs.realpathSync.native(repoRoot)
  const registered = await gitWorktreePaths(root)
  return registered.some((candidate) => {
    try {
      const resolved = fs.realpathSync.native(candidate)
      const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value
      const exact = normalize(resolved) === normalize(requested)
      const relative = pathUtils.relative(resolved, requested)
      const rootSubdirectory = normalize(requested) === normalize(root)
        && relative !== ".." && !relative.startsWith(`..${pathUtils.sep}`) && !pathUtils.isAbsolute(relative)
      return exact || rootSubdirectory
    } catch {
      return false
    }
  })
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

  ipcMain.handle("filesystem:openDirectory", async (event, path: unknown, repoRoot: unknown): Promise<{ ok: boolean }> => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error("Directory opening is unavailable from this frame")
    }
    if (
      typeof path !== "string" || path.trim().length === 0
      || typeof repoRoot !== "string" || repoRoot.trim().length === 0
      || !fs.statSync(path).isDirectory()
      || !await isRegisteredGitWorktree(repoRoot, path)
    ) {
      throw new Error("Directory not found")
    }
    const canonicalPath = fs.realpathSync.native(path)
    if (!await isRegisteredGitWorktree(repoRoot, canonicalPath)) throw new Error("Directory not found")
    const error = await shell.openPath(canonicalPath)
    if (error) throw new Error(error)
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
