import { app, BrowserWindow, dialog, ipcMain } from "electron"
import { join } from "path"
import { createApplicationMenu } from "./menu"
import { setupInstanceIPC } from "./ipc"
import { setupStorageIPC } from "./storage"

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.NODE_ENV === "development") {
    mainWindow.loadURL("http://localhost:3000")
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"))
  }

  createApplicationMenu(mainWindow)
  setupInstanceIPC(mainWindow)
  setupStorageIPC()

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

function setupIPC() {
  ipcMain.handle("dialog:selectFolder", async () => {
    if (!mainWindow) return null

    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select Project Folder",
      buttonLabel: "Select",
      properties: ["openDirectory"],
    })

    if (result.canceled) {
      return null
    }

    return result.filePaths[0] || null
  })
}

app.whenReady().then(() => {
  setupIPC()
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
