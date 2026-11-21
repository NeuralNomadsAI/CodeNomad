const { contextBridge, ipcRenderer } = require("electron")

// Replace only the standard Web API. No bridge object, IPC method or Node value
// crosses into the page, and the channel is fixed inside this isolated closure.
contextBridge.executeInMainWorld({ func: () => { delete window.prompt } })
contextBridge.exposeInMainWorld("prompt", (message, value) => {
  const result = ipcRenderer.sendSync("codenomad:browser-prompt", {
    message: message === undefined ? "" : String(message),
    value: value === undefined ? "" : String(value),
  })
  return typeof result === "string" ? result : null
})
contextBridge.executeInMainWorld({ func: require("../../../ui/src/lib/native/remote-preview-guards.cjs") })
