const { contextBridge, ipcRenderer } = require("electron")

const electronAPI = {
  onCliStatus: (callback) => {
    ipcRenderer.on("cli:status", (_, data) => callback(data))
    return () => ipcRenderer.removeAllListeners("cli:status")
  },
  onCliLog: (callback) => {
    ipcRenderer.on("cli:log", (_, data) => callback(data))
    return () => ipcRenderer.removeAllListeners("cli:log")
  },
  onCliError: (callback) => {
    ipcRenderer.on("cli:error", (_, data) => callback(data))
    return () => ipcRenderer.removeAllListeners("cli:error")
  },
  getCliStatus: () => ipcRenderer.invoke("cli:getStatus"),
}

contextBridge.exposeInMainWorld("electronAPI", electronAPI)
