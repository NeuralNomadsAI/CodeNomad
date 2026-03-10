const { contextBridge, ipcRenderer, webUtils } = require("electron")

const electronAPI = {
  onCliStatus: (callback) => {
    ipcRenderer.on("cli:status", (_, data) => callback(data))
    return () => ipcRenderer.removeAllListeners("cli:status")
  },
  onCliError: (callback) => {
    ipcRenderer.on("cli:error", (_, data) => callback(data))
    return () => ipcRenderer.removeAllListeners("cli:error")
  },
  getCliStatus: () => ipcRenderer.invoke("cli:getStatus"),
  restartCli: () => ipcRenderer.invoke("cli:restart"),
  openDialog: (options) => ipcRenderer.invoke("dialog:open", options),
  getDirectoryPaths: (paths) => ipcRenderer.invoke("filesystem:getDirectoryPaths", paths),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return null
    }
  },
  setWakeLock: (enabled) => ipcRenderer.invoke("power:setWakeLock", Boolean(enabled)),
  showNotification: (payload) => ipcRenderer.invoke("notifications:show", payload),
}

contextBridge.exposeInMainWorld("electronAPI", electronAPI)
