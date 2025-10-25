import { contextBridge, ipcRenderer } from "electron"

export interface ElectronAPI {
  selectFolder: () => Promise<string | null>
  createInstance: (id: string, folder: string) => Promise<{ id: string; port: number; pid: number; binaryPath: string }>
  stopInstance: (pid: number) => Promise<void>
  onInstanceStarted: (callback: (data: { id: string; port: number; pid: number; binaryPath: string }) => void) => void
  onInstanceError: (callback: (data: { id: string; error: string }) => void) => void
  onInstanceStopped: (callback: (data: { id: string }) => void) => void
  onInstanceLog: (
    callback: (data: {
      id: string
      entry: { timestamp: number; level: "info" | "error" | "warn" | "debug"; message: string }
    }) => void,
  ) => void
  onNewInstance: (callback: () => void) => void
  scanDirectory: (workspaceFolder: string) => Promise<string[]>
  // Storage operations
  getConfigPath: () => string
  getInstancesDir: () => string
  readConfigFile: () => Promise<string>
  writeConfigFile: (content: string) => Promise<void>
  readInstanceFile: (instanceId: string) => Promise<string>
  writeInstanceFile: (instanceId: string, content: string) => Promise<void>
  deleteInstanceFile: (instanceId: string) => Promise<void>
}

const electronAPI: ElectronAPI = {
  selectFolder: () => ipcRenderer.invoke("dialog:selectFolder"),
  createInstance: (id: string, folder: string) => ipcRenderer.invoke("instance:create", id, folder),
  stopInstance: (pid: number) => ipcRenderer.invoke("instance:stop", pid),
  onInstanceStarted: (callback) => {
    ipcRenderer.on("instance:started", (_, data) => callback(data))
  },
  onInstanceError: (callback) => {
    ipcRenderer.on("instance:error", (_, data) => callback(data))
  },
  onInstanceStopped: (callback) => {
    ipcRenderer.on("instance:stopped", (_, data) => callback(data))
  },
  onInstanceLog: (callback) => {
    ipcRenderer.on("instance:log", (_, data) => callback(data))
  },
  onNewInstance: (callback) => {
    ipcRenderer.on("menu:newInstance", () => callback())
  },
  scanDirectory: (workspaceFolder: string) => ipcRenderer.invoke("fs:scanDirectory", workspaceFolder),
  // Storage operations
  getConfigPath: () => ipcRenderer.invoke("storage:getConfigPath"),
  getInstancesDir: () => ipcRenderer.invoke("storage:getInstancesDir"),
  readConfigFile: () => ipcRenderer.invoke("storage:readConfigFile"),
  writeConfigFile: (content: string) => ipcRenderer.invoke("storage:writeConfigFile", content),
  readInstanceFile: (filename: string) => ipcRenderer.invoke("storage:readInstanceFile", filename),
  writeInstanceFile: (filename: string, content: string) =>
    ipcRenderer.invoke("storage:writeInstanceFile", filename, content),
  deleteInstanceFile: (filename: string) => ipcRenderer.invoke("storage:deleteInstanceFile", filename),
  onConfigChanged: (callback: () => void) => {
    ipcRenderer.on("storage:configChanged", () => callback())
  },
}

contextBridge.exposeInMainWorld("electronAPI", electronAPI)

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
