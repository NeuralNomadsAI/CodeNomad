// Isolated guest host: no CodeNomad backend, preload, or shared user profile.
const { app, BrowserWindow, ipcMain } = require("electron")
app.setPath("userData", process.env.CODENOMAD_TEST_PROFILE)
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1200, height: 800, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true,
      ...(process.env.CODENOMAD_TEST_HISTORY_CONTROLLER ? { preload: require("node:path").join(__dirname, "browser-history-preload.cjs") } : {}) } })
  if (process.env.CODENOMAD_TEST_HISTORY_CONTROLLER) {
    const { BrowserController } = require(process.env.CODENOMAD_TEST_HISTORY_CONTROLLER)
    const controller = new BrowserController(() => {})
    window.webContents.on("did-attach-webview", (_event, guest) => controller.observeGuest(window.webContents, guest))
    ipcMain.handle("fixture:browser-register", (event, payload) => controller.register(event.sender, payload))
    ipcMain.handle("fixture:browser-unregister", (event, id) => controller.unregister(event.sender, id))
    ipcMain.handle("fixture:browser-history", (event, id, entryId) => controller.history(event.sender, id, entryId))
  }
  window.loadURL("about:blank")
})
app.on("window-all-closed", () => app.quit())
