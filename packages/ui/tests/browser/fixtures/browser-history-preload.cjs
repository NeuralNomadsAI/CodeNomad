const { contextBridge, ipcRenderer } = require("electron")
contextBridge.exposeInMainWorld("browserHistoryNative", {
  register: payload => ipcRenderer.invoke("fixture:browser-register", payload),
  unregister: id => ipcRenderer.invoke("fixture:browser-unregister", id),
  history: (id, entryId) => ipcRenderer.invoke("fixture:browser-history", id, entryId),
})
