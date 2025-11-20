import { BrowserWindow, ipcMain } from "electron"
import type { CliLogEntry, CliProcessManager, CliStatus } from "./process-manager"

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

  cliManager.on("log", (entry: CliLogEntry) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cli:log", entry)
    }
  })

  cliManager.on("error", (error: Error) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cli:error", { message: error.message })
    }
  })

  ipcMain.handle("cli:getStatus", async () => cliManager.getStatus())
}
