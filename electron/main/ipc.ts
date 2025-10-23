import { ipcMain, BrowserWindow } from "electron"
import { processManager } from "./process-manager"
import { randomBytes } from "crypto"

interface Instance {
  id: string
  folder: string
  port: number
  pid: number
  status: "starting" | "ready" | "error" | "stopped"
  error?: string
}

const instances = new Map<string, Instance>()

function generateId(): string {
  return randomBytes(16).toString("hex")
}

export function setupInstanceIPC(mainWindow: BrowserWindow) {
  processManager.setMainWindow(mainWindow)

  ipcMain.handle("instance:create", async (event, id: string, folder: string) => {
    const instance: Instance = {
      id,
      folder,
      port: 0,
      pid: 0,
      status: "starting",
    }

    instances.set(id, instance)

    try {
      const { pid, port } = await processManager.spawn(folder, id)

      instance.port = port
      instance.pid = pid
      instance.status = "ready"

      mainWindow.webContents.send("instance:started", { id, port, pid })

      const meta = processManager.getAllProcesses().get(pid)
      if (meta) {
        meta.childProcess.on("exit", (code, signal) => {
          instance.status = "stopped"
          mainWindow.webContents.send("instance:stopped", { id })
        })
      }

      return { id, port, pid }
    } catch (error) {
      instance.status = "error"
      instance.error = error instanceof Error ? error.message : String(error)

      mainWindow.webContents.send("instance:error", {
        id,
        error: instance.error,
      })

      throw error
    }
  })

  ipcMain.handle("instance:stop", async (event, pid: number) => {
    await processManager.kill(pid)

    for (const [id, instance] of instances.entries()) {
      if (instance.pid === pid) {
        instance.status = "stopped"
        break
      }
    }
  })

  ipcMain.handle("instance:status", async (event, pid: number) => {
    return processManager.getStatus(pid)
  })

  ipcMain.handle("instance:list", async () => {
    return Array.from(instances.values())
  })
}
