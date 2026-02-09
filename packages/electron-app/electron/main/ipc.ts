import { BrowserWindow, Notification, dialog, ipcMain, powerSaveBlocker, type OpenDialogOptions } from "electron"
import type { CliProcessManager, CliStatus } from "./process-manager"

let wakeLockId: number | null = null

interface DialogOpenRequest {
  mode: "directory" | "file"
  title?: string
  defaultPath?: string
  filters?: Array<{ name?: string; extensions: string[] }>
}

interface DialogOpenResult {
  canceled: boolean
  paths: string[]
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
    await cliManager.stop()
    return cliManager.start({ dev: devMode })
  })

  ipcMain.handle("dialog:open", async (_, request: DialogOpenRequest): Promise<DialogOpenResult> => {
    const properties: OpenDialogOptions["properties"] =
      request.mode === "directory" ? ["openDirectory", "createDirectory"] : ["openFile"]

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

  ipcMain.handle("power:setWakeLock", async (_event, enabled: boolean): Promise<{ enabled: boolean }> => {
    const next = Boolean(enabled)
    if (next) {
      if (wakeLockId !== null && powerSaveBlocker.isStarted(wakeLockId)) {
        return { enabled: true }
      }
      try {
        wakeLockId = powerSaveBlocker.start("prevent-display-sleep")
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
