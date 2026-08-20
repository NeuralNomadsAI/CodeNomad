const { contextBridge, ipcRenderer, webUtils } = require("electron")

function resolveWindowContext() {
  const prefix = "--codenomad-window-context="
  const arg = process.argv.find((value) => typeof value === "string" && value.startsWith(prefix))
  const context = arg ? arg.slice(prefix.length) : "local"
  return context === "remote" ? "remote" : "local"
}

function resolveWindowId() {
  const prefix = "--codenomad-window-id="
  const arg = process.argv.find((value) => typeof value === "string" && value.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : null
}

const windowContext = resolveWindowContext()
const windowId = resolveWindowId()

const localElectronAPI = {
  onCliStatus: (callback) => {
    const handler = (_, data) => callback(data)
    ipcRenderer.on("cli:status", handler)
    return () => ipcRenderer.removeListener("cli:status", handler)
  },
  onCliError: (callback) => {
    const handler = (_, data) => callback(data)
    ipcRenderer.on("cli:error", handler)
    return () => ipcRenderer.removeListener("cli:error", handler)
  },
  getCliStatus: () => ipcRenderer.invoke("cli:getStatus"),
  restartCli: () => ipcRenderer.invoke("cli:restart"),
  openDialog: (options) => ipcRenderer.invoke("dialog:open", options),
  getDirectoryPaths: (paths) => ipcRenderer.invoke("filesystem:getDirectoryPaths", paths),
  openWorkspaceTarget: (payload) => ipcRenderer.invoke("workspace:openTarget", payload),
  setWorkspaceMenuEnabled: (enabled) => ipcRenderer.invoke("workspace:setMenuEnabled", Boolean(enabled)),
  newWindow: () => ipcRenderer.invoke("window:new"),
  nextPendingFolder: () => ipcRenderer.invoke("window:nextFolder"),
  acknowledgePendingFolder: (folder, opened) => ipcRenderer.invoke("window:ackFolder", folder, Boolean(opened)),
  onPendingFolders: (callback) => {
    const handler = () => callback()
    ipcRenderer.on("window:folders-pending", handler)
    return () => ipcRenderer.removeListener("window:folders-pending", handler)
  },
  onMenuAction: (callback) => {
    const handler = (_event, action) => callback(action)
    ipcRenderer.on("menu:action", handler)
    return () => ipcRenderer.removeListener("menu:action", handler)
  },
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
  commitClientStatePartitions: (token, payload) => ipcRenderer.invoke("client-state:commitPartitions", token, payload),
  loadClientStatePartition: (token, key) => ipcRenderer.invoke("client-state:loadPartition", token, key),
  setClientStateRestoreEnabled: (token, enabled) =>
    ipcRenderer.invoke("client-state:setRestoreEnabled", token, Boolean(enabled)),
  clearClientState: (token) => ipcRenderer.invoke("client-state:clear", token),
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
contextBridge.exposeInMainWorld("__CODENOMAD_WINDOW_ID__", windowContext === "local" ? windowId : null)
contextBridge.exposeInMainWorld("__CODENOMAD_RUNTIME_HOST__", "electron")
