// Isolated renderer harness: never loads CodeNomad's backend or a user profile.
const { app, BrowserWindow } = require("electron")
app.setPath("userData", process.env.CODENOMAD_TEST_PROFILE)
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1200, height: 800, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  window.loadURL("about:blank")
})
app.on("window-all-closed", () => app.quit())
