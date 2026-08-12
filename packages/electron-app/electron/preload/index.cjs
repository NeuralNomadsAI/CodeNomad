const { contextBridge, ipcRenderer, webUtils } = require("electron")

function resolveWindowContext() {
  const prefix = "--codenomad-window-context="
  const arg = process.argv.find((value) => typeof value === "string" && value.startsWith(prefix))
  const context = arg ? arg.slice(prefix.length) : "local"
  return context === "remote" ? "remote" : "local"
}

function resolveRuntimeHost(windowContext) {
  return "electron"
}

const windowContext = resolveWindowContext()

const localElectronAPI = {
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
  requestMicrophoneAccess: () => ipcRenderer.invoke("media:requestMicrophoneAccess"),
  setWakeLock: (enabled) => ipcRenderer.invoke("power:setWakeLock", Boolean(enabled)),
  showNotification: (payload) => ipcRenderer.invoke("notifications:show", payload),
  openRemoteWindow: (payload) => ipcRenderer.invoke("remote:openWindow", payload),
  claimClientStateAccess: (token) => ipcRenderer.invoke("client-state:claimAccess", token),
  loadClientState: (token) => ipcRenderer.invoke("client-state:load", token),
  saveClientState: (token, snapshot) => ipcRenderer.invoke("client-state:save", token, snapshot),
  setClientStateRestoreEnabled: (token, enabled) =>
    ipcRenderer.invoke("client-state:setRestoreEnabled", token, Boolean(enabled)),
  clearClientState: (token) => ipcRenderer.invoke("client-state:clear", token),
  openWorktreeInFileManager: (token, rootDirectory, registeredDirectory, targetDirectory) =>
    ipcRenderer.invoke("worktree:openInFileManager", token, { rootDirectory, registeredDirectory, targetDirectory }),
}

const remoteElectronAPI = {
  requestMicrophoneAccess: localElectronAPI.requestMicrophoneAccess,
  setWakeLock: localElectronAPI.setWakeLock,
  showNotification: localElectronAPI.showNotification,
}

contextBridge.exposeInMainWorld(
  "electronAPI",
  windowContext === "local" ? localElectronAPI : remoteElectronAPI,
)
contextBridge.exposeInMainWorld("__CODENOMAD_WINDOW_CONTEXT__", windowContext)
contextBridge.exposeInMainWorld("__CODENOMAD_RUNTIME_HOST__", resolveRuntimeHost(windowContext))
