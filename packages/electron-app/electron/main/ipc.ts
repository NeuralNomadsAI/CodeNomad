import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron"
import type { CliProcessManager, CliStatus } from "./process-manager"

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

let ipcInitialized = false
let activeWindow: BrowserWindow | null = null

function sendToWindow(channel: string, payload: unknown) {
  const target = activeWindow
  if (!target || target.isDestroyed()) {
    return
  }
  target.webContents.send(channel, payload)
}

export function setupCliIPC(mainWindow: BrowserWindow, cliManager: CliProcessManager) {
  activeWindow = mainWindow

  if (ipcInitialized) {
    return
  }
  ipcInitialized = true

  cliManager.on("status", (status: CliStatus) => {
    sendToWindow("cli:status", status)
  })

  cliManager.on("ready", (status: CliStatus) => {
    sendToWindow("cli:ready", status)
  })

  cliManager.on("error", (error: Error) => {
    sendToWindow("cli:error", { message: error.message })
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

    const windowTarget = activeWindow && !activeWindow.isDestroyed() ? activeWindow : undefined
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
}
